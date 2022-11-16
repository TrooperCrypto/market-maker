import WebSocket from "ws";
import ethers from "ethers";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

// Globals
const PRICE_FEEDS = {};
const BALANCES = {};
const MARKETS = {};
const CHAINLINK_PROVIDERS = {};
const UNISWAP_V3_PROVIDERS = {};
const MY_ORDERS = {};

let uniswap_error_counter = 0;
let chainlink_error_counter = 0;

const ERC20ABI = JSON.parse(fs.readFileSync("ABIs/ERC20.abi"));
const VAULTABI = JSON.parse(fs.readFileSync("ABIs/vault.abi"));

// Load MM config
let MM_CONFIG;
if (process.env.MM_CONFIG) {
  MM_CONFIG = JSON.parse(process.env.MM_CONFIG);
} else {
  const mmConfigFile = fs.readFileSync("config.json", "utf8");
  MM_CONFIG = JSON.parse(mmConfigFile);
}
let activePairs = [];
for (let marketId in MM_CONFIG.pairs) {
  const pair = MM_CONFIG.pairs[marketId];
  if (pair.active) {
    activePairs.push(marketId);
  }
}
console.log("ACTIVE PAIRS", activePairs);
const CHAIN_ID = parseInt(MM_CONFIG.zigzagChainId);
const VAULT = MM_CONFIG.vault.address;
const VAULT_DEPOSIT_TOKENS = MM_CONFIG.vault.depositTokens;
const VAULT_DEPOSIT_FEE = MM_CONFIG.vault.depositFee || 0.01; // default != 0 to prevent arb
const VAULT_WITHDRAW_FEE = MM_CONFIG.vault.withdrawFee || 0.01; // default != 0 to prevent arb

if (VAULT && !VAULT_DEPOSIT_TOKENS) {
  throw new Error('vault need deposit token list')
}

const infuraID = MM_CONFIG.infura ? MM_CONFIG.infura : process.env.INFURA;

const ethersProvider = new ethers.providers.InfuraProvider("mainnet", infuraID);

let rollupProvider = null;
if (CHAIN_ID === 42161) {
  rollupProvider = new ethers.providers.JsonRpcProvider(
    "https://arb1.arbitrum.io/rpc"
  );
} else if (CHAIN_ID === 421613) {
  rollupProvider = new ethers.providers.JsonRpcProvider(
    "https://goerli-rollup.arbitrum.io/rpc"
  );
}

const pKey = MM_CONFIG.ethPrivKey
  ? MM_CONFIG.ethPrivKey
  : process.env.ETH_PRIVKEY;
const WALLET = new ethers.Wallet(pKey, rollupProvider).connect(rollupProvider);
const VAULT_CONTRACT = new ethers.Contract(VAULT, VAULTABI, WALLET);
const VAULT_TOKEN_NAME = await VAULT_CONTRACT.name(); // cache name once

// Start price feeds
await setupPriceFeeds();

// Update account state loop
setTimeout(getBalances, 5000);

let sendOrdersInterval;
let zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
zigzagws.on("open", onWsOpen);
zigzagws.on("close", onWsClose);
zigzagws.on("error", console.error);

function onWsOpen() {
  zigzagws.on("message", handleMessage);
  sendOrdersInterval = setInterval(sendOrders, 7000);
  for (let market in MM_CONFIG.pairs) {
    if (MM_CONFIG.pairs[market].active) {
      const msg = { op: "subscribemarket", args: [CHAIN_ID, market] };
      zigzagws.send(JSON.stringify(msg));
    }
  }
}

function onWsClose() {
  console.log("Websocket closed. Restarting");
  setTimeout(() => {
    clearInterval(sendOrdersInterval);
    zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
    zigzagws.on("open", onWsOpen);
    zigzagws.on("close", onWsClose);
    zigzagws.on("error", console.error);
  }, 5000);
}

async function handleMessage(json) {
  const msg = JSON.parse(json);
  if (
    ![
      "fills",
      "orders",
      "lastprice",
      "liquidity2",
      "fillstatus",
      "marketinfo",
      "error",
    ].includes(msg.op)
  )
    console.log(json.toString());
  switch (msg.op) {
    case "error":
      console.log(msg);
      break;
    case "userorderack":
      const order = msg.args;
      const orderMarket = order[2];
      MY_ORDERS[orderMarket].push(order);
      break;
    case "marketinfo":
      const marketInfo = msg.args[0];
      const marketId = marketInfo.alias;
      if (!marketId) break;
      let oldBaseFee = "N/A",
        oldQuoteFee = "N/A";
      try {
        oldBaseFee = MARKETS[marketId].baseFee;
        oldQuoteFee = MARKETS[marketId].quoteFee;
      } catch (e) {
        // pass, no old marketInfo
      }
      MARKETS[marketId] = marketInfo;
      break;
    default:
      break;
  }
}

function validatePriceFeed(marketId) {
  const mmConfig = MM_CONFIG.pairs[marketId];
  const primaryPriceFeedId = mmConfig.priceFeedPrimary;
  const secondaryPriceFeedId = mmConfig.priceFeedSecondary;

  // Constant mode checks
  const [mode, price] = primaryPriceFeedId.split(":");
  if (mode === "constant") {
    if (price > 0) return true;
    else throw new Error("No initPrice available");
  }

  // Check if primary price exists
  const primaryPrice = PRICE_FEEDS[primaryPriceFeedId];
  if (!primaryPrice) throw new Error("Primary price feed unavailable");

  // If there is no secondary price feed, the price auto-validates
  if (!secondaryPriceFeedId) return true;

  // Check if secondary price exists
  const secondaryPrice = PRICE_FEEDS[secondaryPriceFeedId];
  if (!secondaryPrice) throw new Error("Secondary price feed unavailable");

  // If the secondary price feed varies from the primary price feed by more than 1%, assume something is broken
  const percentDiff = Math.abs(primaryPrice - secondaryPrice) / primaryPrice;
  if (percentDiff > 0.03) {
    console.error("Primary and secondary price feeds do not match!");
    throw new Error("Circuit breaker triggered");
  }

  return true;
}

async function setupPriceFeeds() {
  const cryptowatch = [],
    chainlink = [],
    uniswapV3 = [];
  for (let market in MM_CONFIG.pairs) {
    const pairConfig = MM_CONFIG.pairs[market];
    if (!pairConfig.active) {
      continue;
    }
    // This is needed to make the price feed backwards compatalbe with old constant mode:
    // "DYDX-USDC": {
    //      "mode": "constant",
    //      "initPrice": 20,
    if (pairConfig.mode == "constant") {
      const initPrice = pairConfig.initPrice;
      pairConfig["priceFeedPrimary"] = "constant:" + initPrice.toString();
    }
    const primaryPriceFeed = pairConfig.priceFeedPrimary;
    const secondaryPriceFeed = pairConfig.priceFeedSecondary;

    // parse keys to lower case to match later PRICE_FEED keys
    if (primaryPriceFeed) {
      MM_CONFIG.pairs[market].priceFeedPrimary = primaryPriceFeed.toLowerCase();
    }
    if (secondaryPriceFeed) {
      MM_CONFIG.pairs[market].priceFeedSecondary =
        secondaryPriceFeed.toLowerCase();
    }
    [primaryPriceFeed, secondaryPriceFeed].forEach((priceFeed) => {
      if (!priceFeed) {
        return;
      }
      const [provider, id] = priceFeed.split(":");
      switch (provider.toLowerCase()) {
        case "cryptowatch":
          if (!cryptowatch.includes(id)) {
            cryptowatch.push(id);
          }
          break;
        case "chainlink":
          if (!chainlink.includes(id)) {
            chainlink.push(id);
          }
          break;
        case "uniswapv3":
          if (!uniswapV3.includes(id)) {
            uniswapV3.push(id);
          }
          break;
        case "constant":
          PRICE_FEEDS["constant:" + id] = parseFloat(id);
          break;
        default:
          throw new Error(
            "Price feed provider " + provider + " is not available."
          );
          break;
      }
    });

    // instantiate open orders array for market
    MY_ORDERS[market] = [];
  }
  if (chainlink.length > 0) await chainlinkSetup(chainlink);
  if (cryptowatch.length > 0) await cryptowatchWsSetup(cryptowatch);
  if (uniswapV3.length > 0) await uniswapV3Setup(uniswapV3);

  console.log(PRICE_FEEDS);
}

async function cryptowatchWsSetup(cryptowatchMarketIds) {
  // Set initial prices
  const cryptowatchApiKey =
    process.env.CRYPTOWATCH_API_KEY || MM_CONFIG.cryptowatchApiKey;
  const cryptowatchMarkets = await fetch(
    "https://api.cryptowat.ch/markets?apikey=" + cryptowatchApiKey
  ).then((r) => r.json());
  const cryptowatchMarketPrices = await fetch(
    "https://api.cryptowat.ch/markets/prices?apikey=" + cryptowatchApiKey
  ).then((r) => r.json());
  for (let i in cryptowatchMarketIds) {
    const cryptowatchMarketId = cryptowatchMarketIds[i];
    try {
      const cryptowatchMarket = cryptowatchMarkets.result.find(
        (row) => row.id == cryptowatchMarketId
      );
      const exchange = cryptowatchMarket.exchange;
      const pair = cryptowatchMarket.pair;
      const key = `market:${exchange}:${pair}`;
      PRICE_FEEDS["cryptowatch:" + cryptowatchMarketIds[i]] =
        cryptowatchMarketPrices.result[key];
    } catch (e) {
      console.error(
        "Could not set price feed for cryptowatch:" + cryptowatchMarketId
      );
    }
  }

  const subscriptionMsg = {
    subscribe: {
      subscriptions: [],
    },
  };
  for (let i in cryptowatchMarketIds) {
    const cryptowatchMarketId = cryptowatchMarketIds[i];

    // first get initial price info

    subscriptionMsg.subscribe.subscriptions.push({
      streamSubscription: {
        resource: `markets:${cryptowatchMarketId}:book:spread`,
      },
    });
  }
  let cryptowatch_ws = new WebSocket(
    "wss://stream.cryptowat.ch/connect?apikey=" + cryptowatchApiKey
  );
  cryptowatch_ws.on("open", onopen);
  cryptowatch_ws.on("message", onmessage);
  cryptowatch_ws.on("close", onclose);
  cryptowatch_ws.on("error", console.error);

  function onopen() {
    cryptowatch_ws.send(JSON.stringify(subscriptionMsg));
  }
  function onmessage(data) {
    const msg = JSON.parse(data);
    if (!msg.marketUpdate) return;

    const marketId = "cryptowatch:" + msg.marketUpdate.market.marketId;
    let ask = msg.marketUpdate.orderBookSpreadUpdate.ask.priceStr;
    let bid = msg.marketUpdate.orderBookSpreadUpdate.bid.priceStr;
    let price = ask / 2 + bid / 2;
    PRICE_FEEDS[marketId] = price;
  }
  function onclose() {
    setTimeout(cryptowatchWsSetup, 5000, cryptowatchMarketIds);
  }
}

async function chainlinkSetup(chainlinkMarketAddress) {
  const results = chainlinkMarketAddress.map(async (address) => {
    try {
      const aggregatorV3InterfaceABI = JSON.parse(
        fs.readFileSync("ABIs/chainlinkV3InterfaceABI.abi")
      );
      const provider = new ethers.Contract(
        address,
        aggregatorV3InterfaceABI,
        ethersProvider
      );
      const decimals = await provider.decimals();
      const key = "chainlink:" + address;
      CHAINLINK_PROVIDERS[key] = [provider, decimals];

      // get inital price
      const response = await provider.latestRoundData();
      PRICE_FEEDS[key] = parseFloat(response.answer) / 10 ** decimals;
    } catch (e) {
      throw new Error(
        "Error while setting up chainlink for " + address + ", Error: " + e
      );
    }
  });
  await Promise.all(results);
  setInterval(chainlinkUpdate, 30000);
}

async function chainlinkUpdate() {
  try {
    await Promise.all(
      Object.keys(CHAINLINK_PROVIDERS).map(async (key) => {
        const [provider, decimals] = CHAINLINK_PROVIDERS[key];
        const response = await provider.latestRoundData();
        PRICE_FEEDS[key] = parseFloat(response.answer) / 10 ** decimals;
      })
    );
    chainlink_error_counter = 0;
  } catch (err) {
    chainlink_error_counter += 1;
    console.log(`Failed to update chainlink, retry: ${err.message}`);
    if (chainlink_error_counter > 4) {
      throw new Error("Failed to update chainlink since 150 seconds!");
    }
  }
}

async function uniswapV3Setup(uniswapV3Address) {
  const results = uniswapV3Address.map(async (address) => {
    try {
      const IUniswapV3PoolABI = JSON.parse(
        fs.readFileSync("ABIs/IUniswapV3Pool.abi")
      );

      const provider = new ethers.Contract(
        address,
        IUniswapV3PoolABI,
        ethersProvider
      );

      let [slot0, addressToken0, addressToken1] = await Promise.all([
        provider.slot0(),
        provider.token0(),
        provider.token1(),
      ]);

      const tokenProvier0 = new ethers.Contract(
        addressToken0,
        ERC20ABI,
        ethersProvider
      );
      const tokenProvier1 = new ethers.Contract(
        addressToken1,
        ERC20ABI,
        ethersProvider
      );

      let [decimals0, decimals1] = await Promise.all([
        tokenProvier0.decimals(),
        tokenProvier1.decimals(),
      ]);

      const key = "uniswapv3:" + address;
      const decimalsRatio = 10 ** decimals0 / 10 ** decimals1;
      UNISWAP_V3_PROVIDERS[key] = [provider, decimalsRatio];

      // get inital price
      const price =
        (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * decimalsRatio) / 2 ** 192;
      PRICE_FEEDS[key] = price;
    } catch (e) {
      throw new Error(
        "Error while setting up uniswapV3 for " + address + ", Error: " + e
      );
    }
  });
  await Promise.all(results);
  setInterval(uniswapV3Update, 30000);
}

async function uniswapV3Update() {
  try {
    await Promise.all(
      Object.keys(UNISWAP_V3_PROVIDERS).map(async (key) => {
        const [provider, decimalsRatio] = UNISWAP_V3_PROVIDERS[key];
        const slot0 = await provider.slot0();
        PRICE_FEEDS[key] =
          (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * decimalsRatio) / 2 ** 192;
      })
    );
    // reset error counter if successful
    uniswap_error_counter = 0;
  } catch (err) {
    uniswap_error_counter += 1;
    console.log(`Failed to update uniswap, retry: ${err.message}`);
    console.log(err.message);
    if (uniswap_error_counter > 4) {
      throw new Error("Failed to update uniswap since 150 seconds!");
    }
  }
}

async function sendOrders(pairs = MM_CONFIG.pairs) {
  // update balances before placing new order
  await getBalances();

  for (const marketId in pairs) {
    const mmConfig = pairs[marketId];
    if (!mmConfig || !mmConfig.active) continue;

    try {
      validatePriceFeed(marketId);
    } catch (e) {
      console.error("Can not sendOrders (" + marketId + ") because: " + e);
      continue;
    }

    const marketInfo = MARKETS[marketId];
    if (!marketInfo) continue;

    const midPrice = mmConfig.invert
      ? 1 / PRICE_FEEDS[mmConfig.priceFeedPrimary]
      : PRICE_FEEDS[mmConfig.priceFeedPrimary];
    if (!midPrice) continue;

    const expires = ((Date.now() / 1000) | 0) + 15; // 15s expiry
    const side = mmConfig.side || "d";

    const maxBaseBalance = BALANCES[marketInfo.baseAsset.symbol].value;
    const maxQuoteBalance = BALANCES[marketInfo.quoteAsset.symbol].value;
    const baseBalance = maxBaseBalance / 10 ** marketInfo.baseAsset.decimals;
    const quoteBalance = maxQuoteBalance / 10 ** marketInfo.quoteAsset.decimals;
    const maxSellSize = Math.min(baseBalance, mmConfig.maxSize);
    const maxBuySize = Math.min(quoteBalance / midPrice, mmConfig.maxSize);

    // dont do splits if under 1000 USD
    const usdBaseBalance = baseBalance * marketInfo.baseAsset.usdPrice;
    const usdQuoteBalance = quoteBalance * marketInfo.quoteAsset.usdPrice;
    let buySplits =
      usdQuoteBalance && usdQuoteBalance < 1000
        ? 1
        : mmConfig.numOrdersIndicated || 1;
    let sellSplits =
      usdBaseBalance && usdBaseBalance < 1000
        ? 1
        : mmConfig.numOrdersIndicated || 1;

    if (usdQuoteBalance && usdQuoteBalance < 10 * buySplits)
      buySplits = Math.floor(usdQuoteBalance / 10);
    if (usdBaseBalance && usdBaseBalance < 10 * sellSplits)
      sellSplits = Math.floor(usdBaseBalance / 10);

    let orderArray = [];
    for (let i = 1; i <= buySplits; i++) {
      const buyPrice =
        midPrice *
        (1 -
          mmConfig.minSpread -
          (mmConfig.slippageRate * maxBuySize * i) / buySplits);
      if (["b", "d"].includes(side)) {
        const order = await getOrderCalldata(
          marketId,
          "b",
          buyPrice,
          maxBuySize / buySplits - marketInfo.baseFee,
          expires
        );
        if (order) orderArray.push(order);
      }
    }
    for (let i = 1; i <= sellSplits; i++) {
      const sellPrice =
        midPrice *
        (1 +
          mmConfig.minSpread +
          (mmConfig.slippageRate * maxSellSize * i) / sellSplits);
      if (["s", "d"].includes(side)) {
        const order = await getOrderCalldata(
          marketId,
          "s",
          sellPrice,
          maxSellSize / sellSplits - marketInfo.baseFee,
          expires
        );
        if (order) orderArray.push(order);
      }
    }

    if (VAULT) {
      try {
        const LPOrders = await getLpTokenOrder(expires);
        orderArray = orderArray.concat(LPOrders);
      } catch (e) {
        console.log(`Could not fetch current LP token supply: ${e.message}`);
      }
    }

    // sign all orders to be canceled
    const cancelOrderArray = [];
    const result = MY_ORDERS[marketId].map(async (order) => {
      cancelOrderArray.push(await getCancelOrderEntry(order));
    });
    await Promise.all(result);

    // clear all orders, they either failed to cancel or got canceld
    MY_ORDERS[marketId] = [];

    if (orderArray.length === 0) return;

    zigzagws.send(
      JSON.stringify({
        op: "submitorder4",
        args: [CHAIN_ID, marketId, orderArray, cancelOrderArray],
      })
    );
  }
}

async function getLpTokenOrder(expires) {
  const LPOrders = []
  const usdHoldings = _getHoldingsInUSD();
  const LPTokenDistributed = await VAULT_CONTRACT.totalSupply();
  const trueLPTokenValue = usdHoldings / LPTokenDistributed;
  console.log(`Market making LP tokens at ${trueLPTokenValue}`)

  // generate LP orders for each valid token
  const result = VAULT_DEPOSIT_TOKENS.map(async (token) => {
    const market = `${VAULT_TOKEN_NAME}-${token}`;
    const tokenInfo = getCurrencyInfo(token);
    if (!tokenInfo) return;

    // calculate the LP token price for this token
    const LPPriceInKind = trueLPTokenValue / tokenInfo.usdPrice;

    const depositLPOrder = await getOrderCalldata(
      market,
      's',
      LPPriceInKind * (1 + VAULT_DEPOSIT_FEE),
      BALANCES[VAULT_TOKEN_NAME],
      expires
    );
    LPOrders.push(depositLPOrder);

    const withdrawLPOrder = await getOrderCalldata(
      market,
      'b',
      LPPriceInKind * (1 - VAULT_WITHDRAW_FEE),
      BALANCES[token],
      expires
    );
    LPOrders.push(withdrawLPOrder);
  });

  await Promise.all(result);
  return LPOrders;
}

async function _getHoldingsInUSD() {
  const tokens = Object.keys(BALANCES);
  let usdHoldings = 0;
  tokens.forEach(token => {
    const tokenInfo = getCurrencyInfo(token);
    if (!tokenInfo) return;

    // dont count the minted, but not distributed LP tokens
    if (tokenInfo.address === VAULT) return;

    usdHoldings += BALANCES[token] * tokenInfo.usdPrice;
  })

  return usdHoldings;
}

async function getOrderCalldata(
  marketId,
  side,
  price,
  size,
  expirationTimeSeconds
) {
  console.log(`Side: ${side}, price ${price}, size: ${size}`);
  const marketInfo = MARKETS[marketId];
  if (!marketInfo) return null;
  const baseAmount = size;
  const quoteAmount = size * price;

  if (baseAmount < marketInfo.baseFee || quoteAmount < marketInfo.quoteFee)
    return;

  const baseAmountBN = ethers.utils.parseUnits(
    Number(baseAmount).toFixed(marketInfo.baseAsset.decimals),
    marketInfo.baseAsset.decimals
  );
  const quoteAmountBN = ethers.utils.parseUnits(
    Number(quoteAmount).toFixed(marketInfo.quoteAsset.decimals),
    marketInfo.quoteAsset.decimals
  );

  const [baseToken, quoteToken] = marketId.split("-");
  let sellToken, buyToken, sellAmountBN, buyAmountBN, balanceBN;
  if (side === "s") {
    sellToken = marketInfo.baseAsset.address;
    buyToken = marketInfo.quoteAsset.address;
    sellAmountBN = baseAmountBN;
    buyAmountBN = quoteAmountBN;
    balanceBN = BALANCES[baseToken].value;
  } else {
    sellToken = marketInfo.quoteAsset.address;
    buyToken = marketInfo.baseAsset.address;
    sellAmountBN = quoteAmountBN;
    buyAmountBN = baseAmountBN;
    balanceBN = BALANCES[quoteToken].value;
  }

  const makerVolumeFeeBN = sellAmountBN
    .mul(marketInfo.makerVolumeFee * 10000)
    .div(9999);
  const takerVolumeFeeBN = sellAmountBN
    .mul(marketInfo.takerVolumeFee * 10000)
    .div(9999);

  const userAccount = await getMMBotAccount();
  let domain, Order, types;
  if (Number(marketInfo.contractVersion) == 2.0) {
    // size check
    if (makerVolumeFeeBN.gte(takerVolumeFeeBN)) {
      balanceBN = balanceBN.sub(makerVolumeFeeBN);
    } else {
      balanceBN = balanceBN.sub(takerVolumeFeeBN);
    }

    if (balanceBN.lte(0)) return null;

    const delta = sellAmountBN.mul("100000").div(balanceBN).toNumber();
    if (delta > 100100) {
      // 100.1 %
      throw new Error(`Amount exceeds balance.`);
    }
    // prevent dust issues
    if (delta > 99990) {
      // 99.9 %
      sellAmountBN = balanceBN;
      buyAmountBN = buyAmountBN.mul(100000).div(delta);
    }
    Order = {
      user: userAccount,
      sellToken,
      buyToken,
      sellAmount: sellAmountBN.toString(),
      buyAmount: buyAmountBN.toString(),
      expirationTimeSeconds: expirationTimeSeconds.toFixed(0),
    };

    domain = {
      name: "ZigZag",
      version: "2.0",
      chainId: CHAIN_ID,
      verifyingContract: marketInfo.exchangeAddress,
    };

    types = {
      Order: [
        { name: "user", type: "address" },
        { name: "sellToken", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "sellAmount", type: "uint256" },
        { name: "buyAmount", type: "uint256" },
        { name: "expirationTimeSeconds", type: "uint256" },
      ],
    };
  }

  const signature = await WALLET._signTypedData(domain, types, Order);

  Order.signature = signature;

  return Order;
}

async function getCancelOrderEntry(order) {
  const orderid = order[1];
  const message = `cancelorder2:${CHAIN_ID}:${orderid}`;
  const signature = await WALLET.signMessage(message);
  return [orderid, signature];
}

function getExchangeAddress() {
  const marketInfo = Object.values(MARKETS)[0];
  return marketInfo?.exchangeAddress;
}

function getCurrencies() {
  const tickers = new Set();
  activePairs.forEach((pair) => {
    tickers.add(pair.split("-")[0]);
    tickers.add(pair.split("-")[1]);
  });
  return [...tickers];
}

function getPairs() {
  return Object.keys(MARKETS);
}

function getCurrencyInfo(currency) {
  if (currency === VAULT_TOKEN_SYMBOL) {
    return {
      id: VAULT,
      address: VAULT,
      symbol: VAULT_TOKEN_SYMBOL,
      decimals: VAULT_DECIMALS,
      usdPrice: 1
    }    
  }

  const pairs = getPairs();
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const marketInfo = MARKETS[pair];
    const baseCurrency = pair.split("-")[0];
    const quoteCurrency = pair.split("-")[1];
    if (baseCurrency === currency && marketInfo) {
      return marketInfo.baseAsset;
    } else if (quoteCurrency === currency && marketInfo) {
      return marketInfo.quoteAsset;
    }
  }
  return null;
}

async function getBalances() {
  const contractAddress = getExchangeAddress();
  const tokens = getCurrencies();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    BALANCES[token] = await getBalanceOfCurrency(token, contractAddress);
  }
}

async function getBalanceOfCurrency(token, contractAddress) {
  const account = await getMMBotAccount();
  let result = { value: 0, allowance: ethers.constants.Zero };
  if (!rollupProvider) return result;

  try {
    if (token === "ETH") {
      result.value = await rollupProvider.getBalance(account);
      result.allowance = ethers.constants.MaxUint256;
      return result;
    }
    const tokenInfo = getCurrencyInfo(token);

    if (!tokenInfo || !tokenInfo.address) return result;

    const contract = new ethers.Contract(
      tokenInfo.address,
      ERC20ABI,
      rollupProvider
    );
    result.value = await contract.balanceOf(account);
    if (contractAddress) {
      result.allowance = await contract.allowance(account, contractAddress);

      if (result.value.gte(result.allowance)) {
        console.log(`Sending approve for ${tokenInfo.name} - ${tokenInfo.address}`)
        if (VAULT) {
          await VAULT_CONTRACT.approveToken(tokenInfo.address, contractAddress, ethers.constants.MaxUint256);
        } else {
          await contract.connect(WALLET).approve(contractAddress, ethers.constants.MaxUint256);
        }        
      }
    } else {
      result.allowance = 0;
    }

    return result;
  } catch (e) {
    console.log(e);
    return result;
  }
}

async function getMMBotAccount() {
  return VAULT ? VAULT : WALLET.getAddress();
}

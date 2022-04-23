import ethers from 'ethers';
import * as starknet from "starknet";
import fs from "fs";
import dotenv from 'dotenv';
import WebSocket from 'ws';
import fetch from 'node-fetch';

const stringToFelt = (text) => {
  const bufferText = Buffer.from(text, 'utf8');
  const hexString = '0x' + bufferText.toString('hex');
  return starknet.number.toFelt(hexString)
}

dotenv.config();

const MARKETS = {};
const tokenInfos = {};
let tokens = [];
const _accountState = {};
let keypair;
let accountContract;
const PRICE_FEEDS = {};

let MM_CONFIG;
let CHAIN_ID;

const CHAINLINK_PROVIDERS = {};
const UNISWAP_V3_PROVIDERS = {};
let uniswap_error_counter = 0;
let chainlink_error_counter = 0;

const accountCompiled = starknet.json.parse(
  fs.readFileSync("ABIs/StarkNetAccount.json").toString("ascii")
);
const erc20Compiled_ABI = starknet.json.parse(
  fs.readFileSync("ABIs/StarkNetERC20.abi").toString("ascii")
);

// Load MM config
if (process.env.MM_CONFIG) {
  MM_CONFIG = JSON.parse(process.env.MM_CONFIG);
}
else {
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
CHAIN_ID = parseInt(MM_CONFIG.zigzagChainId);
console.log("ACTIVE PAIRS", activePairs);

const tickers = new Set();
for (let index in activePairs) {
  tickers.add(activePairs[index].split("-")[0]);
  tickers.add(activePairs[index].split("-")[1]);
}
tokens = [...tickers];
console.log("ACTIVE TOKENS", tokens);

try {
  const ethPrivKey = (process.env.ETH_PRIVKEY || MM_CONFIG.ethPrivKey);
  const publicAddress = MM_CONFIG.publicAddress;
  if (!ethPrivKey || ethPrivKey === "") throw new Error("Set privatekey using 'ethPrivKey'!");
  if (!publicAddress || publicAddress === "") throw new Error("Set publicAddress using 'publicAddress'!");

  _accountState.address = publicAddress;
  _accountState.privateKey = ethPrivKey;
  _accountState.committed = {};
  keypair = starknet.ec.ec.keyFromPrivate(ethPrivKey, "hex");
  accountContract = new starknet.Account(
    starknet.defaultProvider,
    publicAddress,
    keypair
  );

  const contract = new starknet.Contract(
    accountCompiled.abi,
    publicAddress
  );
  const signer = await contract.get_signer();
  if (signer.toString() === '0') throw new Error("Account not initzilized");
} catch (e) {
  console.error(`Error connection to StarkNet. Make sure your privatekey and publicAddress are correct: ${e.message}`)
}

let zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
zigzagws.on('open', onWsOpen);
zigzagws.on('close', onWsClose);
zigzagws.on('error', console.error);

let indicateLiquidityInterval;
function onWsOpen() {
  zigzagws.on('message', handleMessage);
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
    clearInterval(indicateLiquidityInterval)
    zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
    zigzagws.on('open', onWsOpen);
    zigzagws.on('close', onWsClose);
    zigzagws.on('error', console.error);
  }, 5000);
}

async function handleMessage(json) {
  const msg = JSON.parse(json);
  if (!(["lastprice", "liquidity2", "fillstatus", "marketinfo"]).includes(msg.op)) console.log(json.toString());
  switch (msg.op) {
    case 'error':
      console.log(`Error: ${msg.args}`)
      break;
    case "marketinfo":
      const marketInfo = msg.args[0];
      const marketId = marketInfo.alias;
      if (!marketId) break
      let oldBaseFee = "N/A", oldQuoteFee = "N/A";
      try {
        oldBaseFee = MARKETS[marketId].baseFee;
        oldQuoteFee = MARKETS[marketId].quoteFee;
      } catch (e) {
        // pass, no old marketInfo
      }
      tokenInfos[marketInfo.baseAsset.symbol] = marketInfo.baseAsset;
      tokenInfos[marketInfo.quoteAsset.symbol] = marketInfo.quoteAsset;
      MARKETS[marketId] = marketInfo;
      const newBaseFee = MARKETS[marketId].baseFee;
      const newQuoteFee = MARKETS[marketId].quoteFee;
      console.log(`marketinfo ${marketId} - update baseFee ${oldBaseFee} -> ${newBaseFee}, quoteFee ${oldQuoteFee} -> ${newQuoteFee}`);
      break
    case 'marketinfo2':
      const marketInfos = msg.args[0];
      console.log(marketInfos)
      marketInfos.forEach(marketinfo => {
        if (!marketinfo) return
        const marketId = marketInfo.alias;
        if (!marketId) return
        MARKETS[marketId] = marketInfo;
      })
    default:
      break
  }
}

await new Promise((resolve) => {
  setTimeout(resolve, 2500);
});

// Start price feeds
await updateAccountState();
await setupPriceFeeds();
console.log(_accountState.committed.balances)
setInterval(updateAccountState, 60000)
indicateLiquidityInterval = setInterval(indicateLiquidity, 10000);


async function _getBalances() {
  const balances = {};
  const results = tokens.map(async (currency) => {
    const contractAddress = tokenInfos[currency].address;
    if (contractAddress) {
      let balance = await _getBalance(contractAddress);
      balances[currency] = balance;
    }
  })
  await Promise.all(results);
  return balances;
};

async function _getBalance(contractAddress) {
  const erc20 = new starknet.Contract(erc20Compiled_ABI, contractAddress);
  const balance = await erc20.balanceOf (
    _accountState.address
  );
  return starknet.uint256.uint256ToBN(balance[0]).toString();
};

async function updateAccountState() {
  _accountState.committed.balances = await _getBalances();
}

function validatePriceFeed(marketId) {
  const mmConfig = MM_CONFIG.pairs[marketId];
  const primaryPriceFeedId = mmConfig.priceFeedPrimary;
  const secondaryPriceFeedId = mmConfig.priceFeedSecondary;

  // Constant mode checks    
  const [mode, price] = primaryPriceFeedId.split(':');
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

function indicateLiquidity(pairs = MM_CONFIG.pairs) {
  for (const marketId in pairs) {
    const mmConfig = pairs[marketId];
    if (!mmConfig || !mmConfig.active) continue;

    try {
      validatePriceFeed(marketId);
    } catch (e) {
      console.error("Can not indicateLiquidity (" + marketId + ") because: " + e);
      continue;
    }

    const marketInfo = MARKETS[marketId];
    if (!marketInfo) continue;

    const midPrice = PRICE_FEEDS[mmConfig.priceFeedPrimary];
    if (!midPrice) continue;

    const expires = (Date.now() / 1000 | 0) + 10; // 10s expiry
    const side = mmConfig.side || 'd';

    const baseBalance = _accountState.committed.balances[marketInfo.baseAsset.symbol]
      / 10 ** marketInfo.baseAsset.decimals;
    const quoteBalance = _accountState.committed.balances[marketInfo.quoteAsset.symbol]
      / 10 ** marketInfo.quoteAsset.decimals;
    const maxSellSize = Math.min(baseBalance, mmConfig.maxSize);
    const maxBuySize = Math.min(quoteBalance / midPrice, mmConfig.maxSize);

    const splits = mmConfig.numOrdersIndicated || 10;
    const orders = [];
    for (let i = 1; i <= splits; i++) {
      const buyPrice = midPrice * (1 - mmConfig.minSpread - (mmConfig.slippageRate * maxBuySize * i / splits));
      const sellPrice = midPrice * (1 + mmConfig.minSpread + (mmConfig.slippageRate * maxSellSize * i / splits));
      if ((['b', 'd']).includes(side)) {
        orders.push(["b", buyPrice, maxBuySize / splits]);
      }
      if ((['s', 'd']).includes(side)) {
        orders.push(["s", sellPrice, maxSellSize / splits]);
      }
    }

    orders.map(async (order) => {
      const getFraction = (decimals) => {
        let denominator = 1;
        for (; (decimals * denominator) % 1 !== 0; denominator++);
        return { numerator: decimals * denominator, denominator }
      }

      const sideInt = (order[0] === "b") ? '0' : '1';
      const priceRatio = getFraction(order[1]);
      const amountBN = order[2] * (10 ** marketInfo.baseAsset.decimals);
      const ZZMessage = {
        message_prefix: "StarkNet Message",
        domain_prefix: {
          name: 'zigzag.exchange',
          version: '1',
          chain_id: 'SN_GOERLI'
        },
        sender: _accountState.address.toString(),
        order: {
          base_asset: marketInfo.baseAsset.address.toString(),
          quote_asset: marketInfo.quoteAsset.address.toString(),
          side: sideInt,
          base_quantity: amountBN.toString(),
          price: {
            numerator: priceRatio.numerator.toString(),
            denominator: priceRatio.denominator.toString()
          },
          expiration: expires.toString()
        }
      }

      let hash = starknet.hash.pedersen([
        stringToFelt(ZZMessage.message_prefix),
        "0x1bfc207425a47a5dfa1a50a4f5241203f50624ca5fdf5e18755765416b8e288"
      ])
      hash = starknet.hash.pedersen([hash, stringToFelt(ZZMessage.domain_prefix.name)])
      hash = starknet.hash.pedersen([hash, ZZMessage.domain_prefix.version])
      hash = starknet.hash.pedersen([hash, stringToFelt(ZZMessage.domain_prefix.chain_id)])
      hash = starknet.hash.pedersen([hash, ZZMessage.sender])
      hash = starknet.hash.pedersen([hash, "0x1c40c16f3451462e7f4a563be58271e0a15bfc1cb3fe2e4849e78ccc3bd557"])
      hash = starknet.hash.pedersen([hash, ZZMessage.order.base_asset])
      hash = starknet.hash.pedersen([hash, ZZMessage.order.quote_asset])
      hash = starknet.hash.pedersen([hash, ZZMessage.order.side])
      hash = starknet.hash.pedersen([hash, ZZMessage.order.base_quantity])
      hash = starknet.hash.pedersen([hash, ZZMessage.order.price.numerator])
      hash = starknet.hash.pedersen([hash, ZZMessage.order.price.denominator])
      hash = starknet.hash.pedersen([hash, ZZMessage.order.expiration])

      const starkKey = starknet.ec.ec.keyFromPrivate(_accountState.privateKey.toString(), 'hex');
      const signature = starknet.ec.sign(starkKey, hash)
      ZZMessage.sig_r = signature[0]
      ZZMessage.sig_s = signature[1]


      const msg = { op: "submitorder2", args: [CHAIN_ID, marketId, JSON.stringify(ZZMessage)] };
      console.log(ZZMessage)
      console.log(msg)
      try {
        zigzagws.send(JSON.stringify(msg));
      } catch (e) {
        console.error("Could not send order");
        console.error(e);
      }

    });
  }
}

async function setupPriceFeeds() {
  const cryptowatch = [], chainlink = [], uniswapV3 = [];
  for (let market in MM_CONFIG.pairs) {
    const pairConfig = MM_CONFIG.pairs[market];
    if (!pairConfig.active) { continue; }
    // This is needed to make the price feed backwards compatalbe with old constant mode:
    // "DYDX-USDC": {
    //      "mode": "constant",
    //      "initPrice": 20,    
    if (pairConfig.mode == "constant") {
      const initPrice = pairConfig.initPrice;
      pairConfig['priceFeedPrimary'] = "constant:" + initPrice.toString();
    }
    const primaryPriceFeed = pairConfig.priceFeedPrimary;
    const secondaryPriceFeed = pairConfig.priceFeedSecondary;
    [primaryPriceFeed, secondaryPriceFeed].forEach(priceFeed => {
      if (!priceFeed) { return; }
      const [provider, id] = priceFeed.split(':');
      switch (provider.toLowerCase()) {
        case 'cryptowatch':
          if (!cryptowatch.includes(id)) { cryptowatch.push(id); }
          break;
        case 'chainlink':
          if (!chainlink.includes(id)) { chainlink.push(id); }
          break;
        case 'uniswapv3':
          if (!uniswapV3.includes(id)) { uniswapV3.push(id); }
          break;
        case 'constant':
          PRICE_FEEDS['constant:' + id] = parseFloat(id);
          break;
        default:
          throw new Error("Price feed provider " + provider + " is not available.")
          break;
      }
    });
  }
  if (chainlink.length > 0) await chainlinkSetup(chainlink);
  if (cryptowatch.length > 0) await cryptowatchWsSetup(cryptowatch);
  if (uniswapV3.length > 0) await uniswapV3Setup(uniswapV3);

  console.log(PRICE_FEEDS);
}

async function cryptowatchWsSetup(cryptowatchMarketIds) {
  // Set initial prices
  const cryptowatchApiKey = process.env.CRYPTOWATCH_API_KEY || MM_CONFIG.cryptowatchApiKey;
  const cryptowatchMarkets = await fetch("https://api.cryptowat.ch/markets?apikey=" + cryptowatchApiKey).then(r => r.json());
  const cryptowatchMarketPrices = await fetch("https://api.cryptowat.ch/markets/prices?apikey=" + cryptowatchApiKey).then(r => r.json());
  for (let i in cryptowatchMarketIds) {
    const cryptowatchMarketId = cryptowatchMarketIds[i];
    try {
      const cryptowatchMarket = cryptowatchMarkets.result.find(row => row.id == cryptowatchMarketId);
      const exchange = cryptowatchMarket.exchange;
      const pair = cryptowatchMarket.pair;
      const key = `market:${exchange}:${pair}`;
      PRICE_FEEDS['cryptowatch:' + cryptowatchMarketIds[i]] = cryptowatchMarketPrices.result[key];
    } catch (e) {
      console.error("Could not set price feed for cryptowatch:" + cryptowatchMarketId);
    }
  }

  const subscriptionMsg = {
    "subscribe": {
      "subscriptions": []
    }
  }
  for (let i in cryptowatchMarketIds) {
    const cryptowatchMarketId = cryptowatchMarketIds[i];

    // first get initial price info

    subscriptionMsg.subscribe.subscriptions.push({
      "streamSubscription": {
        "resource": `markets:${cryptowatchMarketId}:book:spread`
      }
    })
  }
  let cryptowatch_ws = new WebSocket("wss://stream.cryptowat.ch/connect?apikey=" + cryptowatchApiKey);
  cryptowatch_ws.on('open', onopen);
  cryptowatch_ws.on('message', onmessage);
  cryptowatch_ws.on('close', onclose);
  cryptowatch_ws.on('error', console.error);

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
      const aggregatorV3InterfaceABI = JSON.parse(fs.readFileSync('ABIs/chainlinkV3InterfaceABI.abi'));
      const provider = new ethers.Contract(address, aggregatorV3InterfaceABI, ethersProvider);
      const decimals = await provider.decimals();
      const key = 'chainlink:' + address;
      CHAINLINK_PROVIDERS[key] = [provider, decimals];

      // get inital price
      const response = await provider.latestRoundData();
      PRICE_FEEDS[key] = parseFloat(response.answer) / 10 ** decimals;
    } catch (e) {
      throw new Error("Error while setting up chainlink for " + address + ", Error: " + e);
    }
  });
  await Promise.all(results);
  setInterval(chainlinkUpdate, 30000);
}

async function chainlinkUpdate() {
  try {
    await Promise.all(Object.keys(CHAINLINK_PROVIDERS).map(async (key) => {
      const [provider, decimals] = CHAINLINK_PROVIDERS[key];
      const response = await provider.latestRoundData();
      PRICE_FEEDS[key] = parseFloat(response.answer) / 10 ** decimals;
    }));
    chainlink_error_counter = 0;
  } catch (err) {
    chainlink_error_counter += 1;
    console.log(`Failed to update chainlink, retry: ${err.message}`);
    if (chainlink_error_counter > 4) {
      throw new Error("Failed to update chainlink since 150 seconds!")
    }
  }
}

async function uniswapV3Setup(uniswapV3Address) {
  const results = uniswapV3Address.map(async (address) => {
    try {
      const IUniswapV3PoolABI = JSON.parse(fs.readFileSync('ABIs/IUniswapV3Pool.abi'));
      const ERC20ABI = JSON.parse(fs.readFileSync('ABIs/ERC20.abi'));

      const provider = new ethers.Contract(address, IUniswapV3PoolABI, ethersProvider);

      let [
        slot0,
        addressToken0,
        addressToken1
      ] = await Promise.all([
        provider.slot0(),
        provider.token0(),
        provider.token1()
      ]);

      const tokenProvier0 = new ethers.Contract(addressToken0, ERC20ABI, ethersProvider);
      const tokenProvier1 = new ethers.Contract(addressToken1, ERC20ABI, ethersProvider);

      let [
        decimals0,
        decimals1
      ] = await Promise.all([
        tokenProvier0.decimals(),
        tokenProvier1.decimals()
      ]);

      const key = 'uniswapV3:' + address;
      const decimalsRatio = (10 ** decimals0 / 10 ** decimals1);
      UNISWAP_V3_PROVIDERS[key] = [provider, decimalsRatio];

      // get inital price
      const price = (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * decimalsRatio) / (2 ** 192);
      PRICE_FEEDS[key] = price;
    } catch (e) {
      throw new Error("Error while setting up uniswapV3 for " + address + ", Error: " + e);
    }
  });
  await Promise.all(results);
  setInterval(uniswapV3Update, 30000);
}

async function uniswapV3Update() {
  try {
    await Promise.all(Object.keys(UNISWAP_V3_PROVIDERS).map(async (key) => {
      const [provider, decimalsRatio] = UNISWAP_V3_PROVIDERS[key];
      const slot0 = await provider.slot0();
      PRICE_FEEDS[key] = (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * decimalsRatio) / (2 ** 192);
    }));
    // reset error counter if successful 
    uniswap_error_counter = 0;
  } catch (err) {
    uniswap_error_counter += 1;
    console.log(`Failed to update uniswap, retry: ${err.message}`);
    console.log(err.message);
    if (uniswap_error_counter > 4) {
      throw new Error("Failed to update uniswap since 150 seconds!")
    }
  }
}
/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store } from "@graphprotocol/graph-ts";
import {
  Pair,
  Token,
  PaintFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
} from "../../generated/schema";
import { Mint, Burn, Swap, Transfer, Sync } from "../../generated/templates/Pair/Pair";
import { updatePairDayData, updateTokenDayData, updatePaintDayData, updatePairHourData } from "./dayUpdates";
import { getFtmPriceInUSD, findFtmPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from "./pricing";
import { convertTokenToDecimal, ADDRESS_ZERO, FACTORY_ADDRESS, ONE_BI, ZERO_BD, BI_18 } from "./utils";

function isCompleteMint(mintId: string): boolean {
  return MintEvent.load(mintId).sender !== null; // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // Initial liquidity.
  if (event.params.to.toHex() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return;
  }

  // get pair and load contract
  let pair = Pair.load(event.address.toHex());

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, BI_18);

  // get or create transaction
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHex());
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.burns = [];
    transaction.swaps = [];
  }

  // mints
  let mints = transaction.mints;
  if (event.params.from.toHex() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    pair.save();

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(mints.length).toString())
      );
      mint.transaction = transaction.id;
      mint.pair = pair.id;
      mint.to = event.params.to;
      mint.liquidity = value;
      mint.timestamp = transaction.timestamp;
      mint.transaction = transaction.id;
      mint.save();

      // update mints in transaction
      transaction.mints = mints.concat([mint.id]);

      // save entities
      transaction.save();
    }
  }

  // case where direct send first on FTM withdrawals
  if (event.params.to.toHex() == pair.id) {
    let burns = transaction.burns;
    let burn = new BurnEvent(
      event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString())
    );
    burn.transaction = transaction.id;
    burn.pair = pair.id;
    burn.liquidity = value;
    burn.timestamp = transaction.timestamp;
    burn.to = event.params.to;
    burn.sender = event.params.from;
    burn.needsComplete = true;
    burn.transaction = transaction.id;
    burn.save();

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id);
    transaction.burns = burns;
    transaction.save();
  }

  // burn
  if (event.params.to.toHex() == ADDRESS_ZERO && event.params.from.toHex() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value);
    pair.save();

    // this is a new instance of a logical burn
    let burns = transaction.burns;
    let burn: BurnEvent;
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1]);
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent;
      } else {
        burn = new BurnEvent(
          event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString())
        );
        burn.transaction = transaction.id;
        burn.needsComplete = false;
        burn.pair = pair.id;
        burn.liquidity = value;
        burn.transaction = transaction.id;
        burn.timestamp = transaction.timestamp;
      }
    } else {
      burn = new BurnEvent(event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString()));
      burn.transaction = transaction.id;
      burn.needsComplete = false;
      burn.pair = pair.id;
      burn.liquidity = value;
      burn.transaction = transaction.id;
      burn.timestamp = transaction.timestamp;
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1]);
      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      store.remove("Mint", mints[mints.length - 1]);
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop();
      transaction.mints = mints;
      transaction.save();
    }
    burn.save();
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id;
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id);
    }
    transaction.burns = burns;
    transaction.save();
  }

  transaction.save();
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex());
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let paint = PaintFactory.load(FACTORY_ADDRESS);

  // reset factory liquidity by subtracting only tracked liquidity
  paint.totalLiquidityFTM = paint.totalLiquidityFTM.minus(pair.trackedReserveFTM as BigDecimal);

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1);
  else pair.token0Price = ZERO_BD;
  if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0);
  else pair.token1Price = ZERO_BD;

  let bundle = Bundle.load("1");
  bundle.ftmPrice = getFtmPriceInUSD();
  bundle.save();

  let t0derivedFTM = findFtmPerToken(token0 as Token);
  token0.derivedFTM = t0derivedFTM;
  token0.derivedUSD = t0derivedFTM.times(bundle.ftmPrice);
  token0.save();

  let t1derivedFTM = findFtmPerToken(token1 as Token);
  token1.derivedFTM = t1derivedFTM;
  token1.derivedUSD = t1derivedFTM.times(bundle.ftmPrice);
  token1.save();

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityFTM: BigDecimal;
  if (bundle.ftmPrice.notEqual(ZERO_BD)) {
    trackedLiquidityFTM = getTrackedLiquidityUSD(
      bundle as Bundle,
      pair.reserve0,
      token0 as Token,
      pair.reserve1,
      token1 as Token
    ).div(bundle.ftmPrice);
  } else {
    trackedLiquidityFTM = ZERO_BD;
  }

  // use derived amounts within pair
  pair.trackedReserveFTM = trackedLiquidityFTM;
  pair.reserveFTM = pair.reserve0
    .times(token0.derivedFTM as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedFTM as BigDecimal));
  pair.reserveUSD = pair.reserveFTM.times(bundle.ftmPrice);

  // use tracked amounts globally
  paint.totalLiquidityFTM = paint.totalLiquidityFTM.plus(trackedLiquidityFTM);
  paint.totalLiquidityUSD = paint.totalLiquidityFTM.times(bundle.ftmPrice);

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1);

  // save entities
  pair.save();
  paint.save();
  token0.save();
  token1.save();
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  let mints = transaction.mints;
  let mint = MintEvent.load(mints[mints.length - 1]);

  let pair = Pair.load(event.address.toHex());
  let paint = PaintFactory.load(FACTORY_ADDRESS);

  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // get new amounts of USD and FTM for tracking
  let bundle = Bundle.load("1");
  let amountTotalUSD = token1.derivedFTM
    .times(token1Amount)
    .plus(token0.derivedFTM.times(token0Amount))
    .times(bundle.ftmPrice);

  // update txn counts
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  paint.totalTransactions = paint.totalTransactions.plus(ONE_BI);

  // save entities
  token0.save();
  token1.save();
  pair.save();
  paint.save();

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount as BigDecimal;
  mint.amount1 = token1Amount as BigDecimal;
  mint.logIndex = event.logIndex;
  mint.amountUSD = amountTotalUSD as BigDecimal;
  mint.save();

  updatePairDayData(event);
  updatePairHourData(event);
  updatePaintDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    return;
  }

  let burns = transaction.burns;
  let burn = BurnEvent.load(burns[burns.length - 1]);

  let pair = Pair.load(event.address.toHex());
  let paint = PaintFactory.load(FACTORY_ADDRESS);

  //update token info
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // get new amounts of USD and FTM for tracking
  let bundle = Bundle.load("1");
  let amountTotalUSD = token1.derivedFTM
    .times(token1Amount)
    .plus(token0.derivedFTM.times(token0Amount))
    .times(bundle.ftmPrice);

  // update txn counts
  paint.totalTransactions = paint.totalTransactions.plus(ONE_BI);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);

  // update global counter and save
  token0.save();
  token1.save();
  pair.save();
  paint.save();

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal;
  burn.amount1 = token1Amount as BigDecimal;
  // burn.to = event.params.to
  burn.logIndex = event.logIndex;
  burn.amountUSD = amountTotalUSD as BigDecimal;
  burn.save();

  updatePairDayData(event);
  updatePairHourData(event);
  updatePaintDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHex());
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals);
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals);
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals);
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals);

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In);
  let amount1Total = amount1Out.plus(amount1In);

  // FTM/USD prices
  let bundle = Bundle.load("1");

  // get total amounts of derived USD and FTM for tracking
  let derivedAmountFTM = token1.derivedFTM
    .times(amount1Total)
    .plus(token0.derivedFTM.times(amount0Total))
    .div(BigDecimal.fromString("2"));
  let derivedAmountUSD = derivedAmountFTM.times(bundle.ftmPrice);

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(
    bundle as Bundle,
    amount0Total,
    token0 as Token,
    amount1Total,
    token1 as Token
  );

  let trackedAmountFTM: BigDecimal;
  if (bundle.ftmPrice.equals(ZERO_BD)) {
    trackedAmountFTM = ZERO_BD;
  } else {
    trackedAmountFTM = trackedAmountUSD.div(bundle.ftmPrice);
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  let paint = PaintFactory.load(FACTORY_ADDRESS);
  paint.totalVolumeUSD = paint.totalVolumeUSD.plus(trackedAmountUSD);
  paint.totalVolumeFTM = paint.totalVolumeFTM.plus(trackedAmountFTM);
  paint.untrackedVolumeUSD = paint.untrackedVolumeUSD.plus(derivedAmountUSD);
  paint.totalTransactions = paint.totalTransactions.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  paint.save();

  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHex());
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.swaps = [];
    transaction.burns = [];
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(swaps.length).toString()));

  // update swap event
  swap.transaction = transaction.id;
  swap.pair = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.to = event.params.to;
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD;
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();

  // update day entities
  let pairDayData = updatePairDayData(event);
  let pairHourData = updatePairHourData(event);
  let paintDayData = updatePaintDayData(event);
  let token0DayData = updateTokenDayData(token0 as Token, event);
  let token1DayData = updateTokenDayData(token1 as Token, event);

  // swap specific updating
  paintDayData.dailyVolumeUSD = paintDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  paintDayData.dailyVolumeFTM = paintDayData.dailyVolumeFTM.plus(trackedAmountFTM);
  paintDayData.dailyVolumeUntracked = paintDayData.dailyVolumeUntracked.plus(derivedAmountUSD);
  paintDayData.save();

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total);
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total);
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  pairDayData.save();

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total);
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total);
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD);
  pairHourData.save();

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total);
  token0DayData.dailyVolumeFTM = token0DayData.dailyVolumeFTM.plus(amount0Total.times(token0.derivedFTM as BigDecimal));
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedFTM as BigDecimal).times(bundle.ftmPrice)
  );
  token0DayData.save();

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total);
  token1DayData.dailyVolumeFTM = token1DayData.dailyVolumeFTM.plus(amount1Total.times(token1.derivedFTM as BigDecimal));
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedFTM as BigDecimal).times(bundle.ftmPrice)
  );
  token1DayData.save();
}

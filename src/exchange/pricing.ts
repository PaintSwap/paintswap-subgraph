/* eslint-disable prefer-const */
import { BigDecimal, Address } from "@graphprotocol/graph-ts/index";
import { Pair, Token, Bundle } from "../../generated/schema";
import { ZERO_BD, factoryContract, ADDRESS_ZERO, ONE_BD } from "./utils";

const WFTM_ADDRESS = "0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83";
const USDC_WFTM_PAIR = "0x7924f76918769fcdcf854c2fdf5d5538dcd7401a";

export function getFtmPriceInUSD(): BigDecimal {
  // fetch ftm prices for each stablecoin
  let usdcPair = Pair.load(USDC_WFTM_PAIR); // usdt is token0
  if (usdcPair != null) {
    return usdcPair.token0Price;
  } else {
    return ZERO_BD;
  }
}

export function getBrushPriceInUSD()

// token where amounts should contribute to tracked volume and liquidity
let WHITELIST: string[] = [
  "0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83", // WFTM
  "0x04068da6c83afcfa0e13ba15a6696662335d5b75", // USDC
  "0x74b23882a30290451a17c44f4f05243b6b58c76d", // WETH
  "0x321162cd933e2be498cd2267a90534a804051b11", // WBTC
  ""
];

// minimum liquidity for price to get tracked
let MINIMUM_LIQUIDITY_THRESHOLD_FTM = BigDecimal.fromString("10");

/**
 * Search through graph to find derived FTM per token.
 * @todo update to be derived FTM (add stablecoin estimates)
 **/
export function findFtmPerToken(token: Token): BigDecimal {
  if (token.id == WFTM_ADDRESS) {
    return ONE_BD;
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    let pairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]));
    if (pairAddress.toHex() != ADDRESS_ZERO) {
      let pair = Pair.load(pairAddress.toHex());
      if (pair.token0 == token.id && pair.reserveFTM.gt(MINIMUM_LIQUIDITY_THRESHOLD_FTM)) {
        let token1 = Token.load(pair.token1);
        return pair.token1Price.times(token1.derivedFTM as BigDecimal); // return token1 per our token * FTM per token 1
      }
      if (pair.token1 == token.id && pair.reserveFTM.gt(MINIMUM_LIQUIDITY_THRESHOLD_FTM)) {
        let token0 = Token.load(pair.token0);
        return pair.token0Price.times(token0.derivedFTM as BigDecimal); // return token0 per our token * FTM per token 0
      }
    }
  }
  return ZERO_BD; // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  bundle: Bundle,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let price0 = token0.derivedFTM.times(bundle.ftmPrice);
  let price1 = token1.derivedFTM.times(bundle.ftmPrice);

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1)).div(BigDecimal.fromString("2"));
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0);
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1);
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  bundle: Bundle,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let price0 = token0.derivedFTM.times(bundle.ftmPrice);
  let price1 = token1.derivedFTM.times(bundle.ftmPrice);

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1));
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString("2"));
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString("2"));
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}

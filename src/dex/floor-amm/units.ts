// A scaled launch's two units: FloorAmm runs floor-math at `mathDecimals = min(18, max(6, quoteDecimals))`, so an 18-dp
// token on a 6-dp quote trades in math units of 1e12 chain base units (`k = tokenScale`). `launchMarket` (the books,
// the cushion curve, the schedule) is in MATH units; `launchState`'s token fields, the events' token fields and every
// published price are per CHAIN unit. Quote amounts never scale. These are the contract's own conversions.

import { sqrtX64 } from './math/bid';
import { mathDecimals } from './math/launch';

const ONE = 1n << 64n;

/** Chain token base units per math unit. */
export const tokenScale = (
  tokenDecimals: number,
  quoteDecimals: number,
): bigint =>
  10n ** BigInt(tokenDecimals - mathDecimals(tokenDecimals, quoteDecimals));

/** A Q64.64 price per math unit as one per chain unit (`⌊x ÷ k⌋`). */
export const perChain = (k: bigint, x: bigint): bigint => x / k;

/** A Q64.64 sqrt price per math unit as one per chain unit (`x ÷ √k`). */
export const sqrtPerChain = (k: bigint, x: bigint): bigint =>
  k === 1n ? x : (x * ONE) / sqrtX64(k << 64n);

/** The cushion curve's liquidity per chain unit (`liq · √k`). */
export const liqPerChain = (k: bigint, liq: bigint): bigint =>
  k === 1n ? liq : (liq * sqrtX64(k << 64n)) / ONE;

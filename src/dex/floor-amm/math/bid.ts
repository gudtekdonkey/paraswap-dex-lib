// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// THE HOOK IS THE BID (keeperless): the reference crate's `bid.rs` ported step for step — the two pots, the floor, the
// stored cushion curve, the sell fill and the credit. Rust is the definition; `golden/bid.json` holds this port to it bit
// for bit (`test/bid.test.ts`).
//
// - `F` (`Pots.floor`): the floor's money; `f = F ÷ S_out` (`floorX64`). ⛔ It never falls.
// - `C` (`Pots.cushion`): the cushion's money, paid along a virtual quote-only range whose TOP `√b` (`bidSqrtX64`) and
// LIQUIDITY `L` (`liq`) are STORED. A sell walks it down at constant `L`; it ends where its price MEETS the running
// floor `F ÷ (S − x)` (`meetSqrtX64`); below that the cushion buys at the running floor; then `F` pays `f`.
// - The bid's top is `price × u` (`bidTopX64`), `u` what a buy keeps.
//
// ⛔ Every rounding is against the trader. Prices are Q64.64 quote base units per token base unit; sqrt prices
// `√p · 2^64` (⚠ NOT the pool's sqrt price, which is √(tokens per quote)); `L` the real liquidity.

import { exp2X64, log2X64 } from './fixed';
import { INV_LN2_X64 } from './schedule';

const ONE = 1n << 64n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

/** The 3 % margin of the floor's line and the after-end lot's resale floor (not the bid's top). */
export const BID_MARGIN_BPS = 10_300n;
/** The bid's top: 1.00 × what a buy keeps of the books' price, `price · u`. */
export const BID_TOP_MARGIN_BPS = 10_000n;

/**
 * `floor_math::bid::CUSHION_CAPPED_AT_TOP` (one constant; it must match the program's): the cushion never buys above the curve's last top; once a sell's running floor `F ÷ (S − x)` passes
 * it the cushion stops and its rest folds into `F` (pro rata to everyone outside). `false`: the cushion buys at the running
 * floor until its money runs out (the last seller of a market takes the cushion's rest).
 */
export const CUSHION_CAPPED_AT_TOP: boolean = true;

/**
 * `floor_math::bid::CUSHION_TRACKS_PRICE` (ON; the crate's `cushion-lags` feature turns it off
 * for measurement only): a credit into a live curve whose top sits at or under the floor after it folds the old cushion into
 * `F` and re-opens the curve over `[f after, the bid's top]` with the credit's own money. Pinned to `bid.json`'s `cushionTracks`.
 */
export const CUSHION_TRACKS_PRICE: boolean = true;

/** `MathError` as `bid.rs` returns it. */
export type BidErrorCode = 'Zero' | 'Overflow';

export class BidMathError extends Error {
  readonly code: BidErrorCode;
  constructor(code: BidErrorCode) {
    super(`wagmi bid: ${code}`);
    this.name = 'BidMathError';
    this.code = code;
  }
}

const zero = (): never => {
  throw new BidMathError('Zero');
};
const overflow = (): never => {
  throw new BidMathError('Overflow');
};
const u128 = (v: bigint): bigint => (v < 0n || v > U128_MAX ? overflow() : v);
const u256 = (v: bigint): bigint => (v > U256_MAX ? overflow() : v);
const umin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const umax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const satSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
const satAdd = (a: bigint, b: bigint): bigint => umin(a + b, U128_MAX);

/** The two pots and the cushion curve (`bid::Pots`). */
export interface Pots {
  /** `F`, quote base units. */
  floor: bigint;
  /** `C`, quote base units. */
  cushion: bigint;
  /** `√b · 2^64`: the cushion curve's top now. */
  bidSqrtX64: bigint;
  /** `L`, the curve's liquidity; 0 while there is no curve. */
  liq: bigint;
}

export const NO_POTS: Pots = Object.freeze({
  floor: 0n,
  cushion: 0n,
  bidSqrtX64: 0n,
  liq: 0n,
});

/** What a sell of `x` tokens gets from the hook (`bid::SellFill`). */
export interface SellFill {
  /** Quote paid to the seller (before FLOOR's sell take): `fromCushion + fromFloor`. */
  quoteOut: bigint;
  /** Tokens the cushion bought (the relist lot) and what it paid — on the curve and at the floor. */
  cushionTokens: bigint;
  fromCushion: bigint;
  /** Tokens the floor bought (they rejoin the inventory) and what it paid. */
  floorTokens: bigint;
  fromFloor: bigint;
  after: Pots;
  /**
   * The stages' shapes, so the lot can record what each token cost (`lot.ts`). Stage 1, the curve: `curveTokens` for
   * `curveQuote`, walked at `curveLiq` from `√curveFromX64` down to `√curveToX64`. Stage 2, the cushion at the running
   * floor `runFloor ÷ (runS − x)`: `runTokens` for `runQuote`. All 0 for a stage that did not run.
   */
  curveTokens: bigint;
  curveQuote: bigint;
  curveFromX64: bigint;
  curveToX64: bigint;
  curveLiq: bigint;
  runTokens: bigint;
  runQuote: bigint;
  runFloor: bigint;
  runS: bigint;
}

/** What a credit did to the pots (`bid::Credit`). */
export interface Credit {
  toFloorFirst: bigint;
  toCushion: bigint;
  toFloorRest: bigint;
  after: Pots;
}

function mulDivDown(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) return zero();
  return u128((a * b) / c);
}

function mulDivUp(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) return zero();
  const n = a * b;
  return u128(n / c + (n % c !== 0n ? 1n : 0n));
}

/** `schedule::isqrt_u256`: `⌊√n⌋` exactly (the crate's Newton lands on the same integer). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** `√p · 2^64` for a Q64.64 price, rounded down. */
export function sqrtX64(pX64: bigint): bigint {
  return isqrt(pX64 << 64n);
}

/** The price of a sqrt price, Q64.64, rounded down (saturating at u128). */
export function priceOfSqrt(sq: bigint): bigint {
  return umin((sq * sq) / ONE, U128_MAX);
}

/** `f = F ÷ S_out`, Q64.64, rounded down. `0n` when nothing is outside. */
export function floorX64(floor: bigint, sOut: bigint): bigint {
  if (sOut === 0n) return 0n;
  // past u128 it saturates
  const v = (floor << 64n) / sOut;
  return v > U128_MAX ? U128_MAX : v;
}

/** The bid's top: `price · u`, `u` (what a buy keeps) Q64.64. Rounded down. */
export function bidTopX64(priceX64: bigint, u: bigint): bigint {
  const kept = u128((priceX64 * u) / ONE);
  return mulDivDown(kept, 10_000n, BID_TOP_MARGIN_BPS);
}

/**
 * ⛔ THE BOUGHT-BACK LOT's ONE formula (`floor_math::bid::resale_floor_x64`; never below
 * 1.03× what it paid): the least price per token base unit (Q64.64, what a buyer pays) at which the program
 * resells `tokens` it bought back for `cost` — `⌈⌈⌈cost·2^64 ÷ tokens⌉ · 1.03⌉ · 2^64 ÷ u⌉`; 0 with nothing held.
 */
export function resaleFloorX64(
  cost: bigint,
  tokens: bigint,
  u: bigint,
): bigint {
  if (tokens === 0n || cost === 0n) return 0n;
  const avg = mulDivUp(cost, ONE, tokens);
  const a3 = mulDivUp(avg, BID_MARGIN_BPS, 10_000n);
  return mulDivUp(a3, ONE, u > 1n ? u : 1n);
}

/** `resale_ask_x64`: `max(the curve's price, resaleFloorX64)`. */
export function resaleAskX64(
  curvePriceX64: bigint,
  cost: bigint,
  tokens: bigint,
  u: bigint,
): bigint {
  const f = resaleFloorX64(cost, tokens, u);
  return curvePriceX64 > f ? curvePriceX64 : f;
}

/** `lot_cost_out`: the cost leaving the lot with `n` of its `tokens` — all of it with the last, else `min(⌈cost·n ÷ tokens⌉, cost)`. */
export function lotCostOut(cost: bigint, tokens: bigint, n: bigint): bigint {
  if (n >= tokens) return cost;
  return umin(mulDivUp(cost, n, tokens), cost);
}

/** Whether the curve can pay now: money, liquidity, and its top above the floor (`b·S > F·2^64`). */
export function curveLive(p: Pots, sOut: bigint): boolean {
  if (p.cushion === 0n || p.liq === 0n || sOut === 0n) return false;
  return priceOfSqrt(p.bidSqrtX64) * sOut > p.floor << 64n;
}

/** The hook's best bid: the curve's top while it pays, else the floor (where a sell's walk through outside LPs stops). */
export function bidPriceX64(p: Pots, sOut: bigint): bigint {
  return curveLive(p, sOut)
    ? priceOfSqrt(p.bidSqrtX64)
    : floorX64(p.floor, sOut);
}

/**
 * Where the curve (top `√b`, liquidity `L`) meets the running floor `F ÷ (S − x)`:
 * `√b·(y + √(y² + 4F·(m + y))) ÷ 2(m + y)`, `y = L·√b`, `m = b·S`. Rounded UP: the walk ends early.
 */
export function meetSqrtX64(
  sb: bigint,
  liq: bigint,
  floor: bigint,
  sOut: bigint,
): bigint {
  const y = mulDivDown(liq, sb, ONE);
  const m = u128((priceOfSqrt(sb) * sOut) / ONE);
  const my = u128(m + y);
  // nothing on either side: the curve stays where it is
  if (my === 0n) return sb;
  const four = u256(floor * my * 4n); // checked_mul_u64(4)
  const d = u256(y * y + four);
  const r = u128(isqrt(d) + 1n);
  const num = u128(y + r);
  return umin(mulDivUp(sb, num, u128(my * 2n)), sb);
}

/** Tokens the curve buys walking from `sb` down to `sn` at `liq`: `L·(1 ÷ √sn − 1 ÷ √sb)`, rounded down. */
function tokensBetween(liq: bigint, sb: bigint, sn: bigint): bigint {
  if (sn === 0n) return U128_MAX;
  const t = mulDivDown(liq, sb - sn, sn);
  return mulDivDown(t, ONE, sb);
}

/**
 * The hook fills a sell of `x` tokens: the curve while it pays above the running floor, the cushion at the running floor,
 * then `f` out of `F`. `sOut` is the tokens outside BEFORE the sell (the seller's `x` among them). Every token is bought.
 */
export function sell(p: Pots, sOut: bigint, x: bigint): SellFill {
  if (x > sOut) return overflow();
  const a = { ...p };
  let s = sOut;
  let rest = x;
  let ct = 0n;
  let cq = 0n;
  let c1: bigint[] = [0n, 0n, 0n, 0n, 0n];
  let run: bigint[] = [0n, 0n, 0n, 0n];
  // 1. the curve, from its top to where it meets the running floor or runs out of money
  if (rest > 0n && curveLive(a, s)) {
    const sb = a.bidSqrtX64;
    const sm = meetSqrtX64(sb, a.liq, a.floor, s);
    const drop = mulDivDown(a.cushion, ONE, a.liq);
    const sa = umax(satSub(sb, drop), 1n);
    const [end, moneyOut] = sa >= sm ? [sa, true] : [sm, false];
    const toEnd = tokensBetween(a.liq, sb, end);
    let t: bigint;
    let sn: bigint;
    let q: bigint;
    if (rest >= toEnd) {
      q = moneyOut
        ? a.cushion
        : umin(mulDivDown(a.liq, sb - end, ONE), a.cushion);
      [t, sn] = [toEnd, end];
    } else {
      const den = u128(a.liq + mulDivDown(rest, sb, ONE));
      sn = umax(mulDivUp(sb, a.liq, den), end);
      t = rest;
      q = umin(mulDivDown(a.liq, sb - sn, ONE), a.cushion);
    }
    // the curve's rounding may price its last tokens under the running floor — never: at most `⌊q·S ÷ F⌋` tokens
    // for `q`, the rest to the stages below; a stage that buys no token pays nothing and leaves `√b` where it was
    if (a.floor > 0n) t = umin(t, mulDivDown(q, s, a.floor));
    if (t === 0n) [sn, q] = [sb, 0n];
    c1 = [t, q, sb, sn, a.liq];
    a.cushion -= q;
    a.bidSqrtX64 = sn;
    if (a.cushion === 0n) a.liq = 0n;
    s -= t;
    rest -= t;
    ct += t;
    cq += q;
  }
  // 2. the cushion at the running floor: q = F·ln(S ÷ (S − x)); it runs out after S·(1 − e^(−C ÷ F)) tokens.
  // option (b) (`CUSHION_CAPPED_AT_TOP`): never above the curve's last top — once the running floor passes it the
  // cushion stops and what it has left FOLDS into `F`, so every holder still outside shares it pro rata
  const top = priceOfSqrt(a.bidSqrtX64);
  // the tokens until F ÷ (S − x) reaches the top: S − ⌈F ÷ top⌉
  const topLim =
    CUSHION_CAPPED_AT_TOP &&
    rest > 0n &&
    a.cushion > 0n &&
    a.floor > 0n &&
    top > 0n
      ? satSub(s, mulDivUp(a.floor, ONE, top))
      : null;
  if (topLim === 0n) {
    a.floor = u128(a.floor + a.cushion);
    a.cushion = 0n;
    a.liq = 0n;
  }
  if (rest > 0n && a.cushion > 0n && a.floor > 0n) {
    const y = mulDivUp(a.cushion, INV_LN2_X64 + 1n, a.floor);
    let s1: bigint;
    if (y >> 64n >= 128n) {
      s1 = 0n;
    } else {
      const e = exp2X64(y & (ONE - 1n));
      if (e === null) return overflow();
      const g = e + 2n;
      s1 = mulDivDown(s, ONE, g) >> (y >> 64n);
    }
    const moneyCap = s - umin(s1, s);
    const cap = topLim === null ? moneyCap : umin(topLim, moneyCap);
    const topped = cap < moneyCap;
    const lnPay = (x: bigint): bigint => {
      const l0 = log2X64(s);
      const l1 = log2X64(s - x);
      if (l0 === null || l1 === null) return zero();
      return umin(
        mulDivDown(a.floor, satSub(l0 - l1, 1n), INV_LN2_X64 + 1n),
        a.cushion,
      );
    };
    let t: bigint;
    let q: bigint;
    if (rest >= cap && !topped) {
      [t, q] = [cap, a.cushion];
    } else if (rest >= cap) {
      // stopped at the top: `F·ln(S ÷ (S − cap))`, the rest of `C` folds into `F` below
      [t, q] = [cap, lnPay(cap)];
    } else {
      [t, q] = [rest, lnPay(rest)];
    }
    // `S₁` rounded down rounds the cap UP — never more than `⌊q·S ÷ F⌋` tokens for `q` (the rest to the floor)
    t = umin(t, mulDivDown(q, s, a.floor));
    if (t === 0n) q = 0n;
    run = [t, q, a.floor, s];
    a.cushion -= q;
    if (topped && rest >= cap) {
      // (b): the running floor reached the top — the cushion's rest folds into `F`
      a.floor = u128(a.floor + a.cushion);
      a.cushion = 0n;
    }
    if (a.cushion === 0n) a.liq = 0n;
    s -= t;
    rest -= t;
    ct += t;
    cq += q;
  }
  // 3. the floor: `F ÷ S_out`, rounded down — the floor never falls
  let fq = 0n;
  if (rest > 0n) {
    fq = mulDivDown(a.floor, rest, s);
    a.floor -= fq;
  }
  return {
    quoteOut: cq + fq,
    cushionTokens: ct,
    fromCushion: cq,
    floorTokens: rest,
    fromFloor: fq,
    after: a,
    curveTokens: c1[0],
    curveQuote: c1[1],
    curveFromX64: c1[2],
    curveToX64: c1[3],
    curveLiq: c1[4],
    runTokens: run[0],
    runQuote: run[1],
    runFloor: run[2],
    runS: run[3],
  };
}

/**
 * `L = ⌊c·2⁶⁴ ÷ span⌋`, 0 when it passes u128: a span too thin for its `L` leaves the money parked in `C` on a dead curve,
 * never an overflow that reverts a buy.
 */
function liqOr0(c: bigint, span: bigint): bigint {
  try {
    return mulDivDown(c, ONE, span);
  } catch (e) {
    if (e instanceof BidMathError) return 0n;
    throw e;
  }
}

/**
 * A credit to the pots, FLOOR FIRST: `amount` arrives while `n` tokens join the `sOut` outside. `F` takes `⌈F·n ÷ S_out⌉`,
 * `C` up to `cushionRoom`, the rest `F`. The curve's top rises by the CL rule at constant `L`, capped at `topX64`
 * (`bidTopX64` at the books after; past it the extra widens `L` over the same bottom); a dead curve re-opens at `topX64`
 * over `[f, top]`. A buy: `amount` its kept money, `cushionRoom` the target less `C`. A relist sale: its proceeds, the lot's
 * cost of the tokens sold.
 */
export function credit(
  p: Pots,
  sOut: bigint,
  n: bigint,
  amount: bigint,
  cushionRoom: bigint,
  topX64: bigint,
): Credit {
  const a = { ...p };
  const first = sOut === 0n ? 0n : umin(mulDivUp(a.floor, n, sOut), amount);
  const left = amount - first;
  const toC = umin(left, cushionRoom);
  const rest = left - toC;
  const live = curveLive(a, sOut);
  a.floor = u128(a.floor + first + rest);
  const s = u128(sOut + n);
  const st = sqrtX64(topX64);
  // (the floor after is read only when the cushion takes money: a kept-skim credit never needs it)
  if (
    CUSHION_TRACKS_PRICE &&
    toC > 0n &&
    live &&
    a.bidSqrtX64 <= sqrtX64(floorX64(a.floor, s))
  ) {
    // B2: the old cushion folds into `F`; the curve re-opens over [f after, the bid's top] with this credit's money alone
    a.floor = u128(a.floor + a.cushion);
    const sf = sqrtX64(floorX64(a.floor, s));
    a.cushion = toC;
    a.bidSqrtX64 = st;
    a.liq = st > satAdd(sf, 1n) ? liqOr0(toC, st - sf) : 0n;
  } else if (toC > 0n) {
    const c2 = u128(a.cushion + toC);
    if (live) {
      // past u128 (or with no liquidity) the curve is over its top: the money goes to the floor below
      let sb2 = U128_MAX;
      try {
        const v = a.bidSqrtX64 + mulDivDown(toC, ONE, a.liq);
        if (v <= U128_MAX) sb2 = v;
      } catch (e) {
        if (!(e instanceof BidMathError)) throw e;
      }
      if (sb2 <= st) {
        a.bidSqrtX64 = sb2;
      } else {
        const sa = satSub(a.bidSqrtX64, mulDivDown(a.cushion, ONE, a.liq));
        a.bidSqrtX64 = st;
        a.liq = st > sa ? liqOr0(c2, st - sa) : 0n;
      }
    } else {
      const sf = sqrtX64(floorX64(a.floor, s));
      a.bidSqrtX64 = st;
      a.liq = st > satAdd(sf, 1n) ? liqOr0(c2, st - sf) : 0n;
    }
    a.cushion = c2;
  }
  return { toFloorFirst: first, toCushion: toC, toFloorRest: rest, after: a };
}
/**
 * `bid::cap_top`: a stored curve top above `topX64` comes down to it, the bottom and the money kept
 * (`L = C·2⁶⁴ ÷ (√top − √a)`); a top at or under the bottom or the floor folds the cushion into `F`. Else unchanged.
 */
export function capTop(p: Pots, sOut: bigint, topX64: bigint): Pots {
  const a = { ...p };
  const st = sqrtX64(topX64);
  if (a.cushion === 0n || a.liq === 0n || a.bidSqrtX64 <= st) return a;
  const d = mulDivDown(a.cushion, ONE, a.liq);
  const sa = a.bidSqrtX64 > d ? a.bidSqrtX64 - d : 0n;
  const sf = sqrtX64(floorX64(a.floor, sOut));
  const lo = sa > sf ? sa : sf;
  if (st > satAdd(lo, 1n)) {
    a.bidSqrtX64 = st;
    a.liq = mulDivDown(a.cushion, ONE, st - sa);
  } else {
    a.floor = u128(a.floor + a.cushion);
    a.cushion = 0n;
    a.bidSqrtX64 = 0n;
    a.liq = 0n;
  }
  return a;
}

// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math `tail.rs` bit for bit: THE TAIL RANGE. After the schedule's end the tail (1 % of the supply plus any
// inventory the schedule did not sell) is ONE constant-product range owned by the program, from the schedule's frozen
// price to an infinite price. `L = ⌊tail · √frozen⌋` is fixed at the end; the curve holds `⌈L ÷ √p⌉` tokens, so it never
// runs out. A buy raises `√p` by what the range keeps (`(kept − 1) ÷ L`), floor first (`⌈F·n ÷ S_out⌉` to `F`); a sell
// lowers it down to the frozen price, `f` a token from `F` and the rest from the range's money. Every rounding is against
// the trader. Held to `golden/trade.json`'s `tail_range` and, through `launch.ts`, to `launch.json`.
//
// Units: `√p` is `√(price) · 2^64` (`bid.sqrtX64`), `L` quote base units per `√p` (as the cushion's curve).

import { floorX64, priceOfSqrt, sqrtX64 } from './bid';
import { FloorMathError, fail } from './index';

const ONE = 1n << 64n;
const U128_MAX = (1n << 128n) - 1n;
const u128 = (v: bigint): bigint => (v > U128_MAX ? fail('Overflow') : v);
const mulDivDown = (a: bigint, b: bigint, c: bigint): bigint =>
  c === 0n ? fail('Zero') : u128((a * b) / c);
const mulDivUp = (a: bigint, b: bigint, c: bigint): bigint => {
  if (c === 0n) fail('Zero');
  const n = a * b;
  return u128(n / c + (n % c !== 0n ? 1n : 0n));
};
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const satSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

/** `tail::open`: `[L, √frozen]` for `tokens` held at the frozen price (`√frozen = sqrtX64(frozen)`, `L` rounded down). */
export function tailOpen(tokens: bigint, frozenX64: bigint): [bigint, bigint] {
  const se = sqrtX64(frozenX64);
  return [mulDivDown(tokens, se, ONE), se];
}

/** `tail::tokens_at`: the tokens the curve holds at `√p`, `⌈L · 2^64 ÷ √p⌉` (0 with no liquidity; at least 1 with some). */
export function tailTokensAt(liq: bigint, sqrt: bigint): bigint {
  if (liq === 0n) return 0n;
  const d = sqrt > 1n ? sqrt : 1n;
  const n = liq << 64n;
  const v = u128(n / d + (n % d !== 0n ? 1n : 0n));
  return v > 1n ? v : 1n;
}

/** `tail::tokens_floor`: `⌊L · 2^64 ÷ √p⌋`, the tokens the curve surely holds at `√p` (a buy counts from here). */
function tokensFloor(liq: bigint, sqrt: bigint): bigint {
  return u128((liq << 64n) / (sqrt > 1n ? sqrt : 1n));
}

/** `tail::owed`: what the curve owes a seller from `√p` down to the frozen price, `⌊L · (√p − √end) ÷ 2^64⌋`. */
export function tailOwed(liq: bigint, sqrt: bigint, sqrtEnd: bigint): bigint {
  return mulDivDown(liq, satSub(sqrt, sqrtEnd), ONE);
}

/** `tail::price_x64`: the range's price, Q64.64 (rounded down, saturating). */
export function tailPriceX64(sqrt: bigint): bigint {
  return priceOfSqrt(sqrt);
}

/** `tail::TailBuy`: what one buy took from the range. */
export interface TailBuy {
  pay: bigint;
  out: bigint;
  kept: bigint;
  cut: bigint;
  toFloor: bigint;
  toMoney: bigint;
  sqrtAfter: bigint;
}

/** `tail::TailSell`: what one sell put back into the range. */
export interface TailSell {
  tokens: bigint;
  gross: bigint;
  fromFloor: bigint;
  fromMoney: bigint;
  sqrtAfter: bigint;
}

const noBuy = (sqrtAfter: bigint): TailBuy => ({
  pay: 0n,
  out: 0n,
  kept: 0n,
  cut: 0n,
  toFloor: 0n,
  toMoney: 0n,
  sqrtAfter,
});

/** No range sale (`tail::TailSell::default()` at `√p`). */
export const noTailSell = (sqrtAfter: bigint): TailSell => ({
  tokens: 0n,
  gross: 0n,
  fromFloor: 0n,
  fromMoney: 0n,
  sqrtAfter,
});

/**
 * `tail::buy`: a buy of at most `offer` quote from the range at `√p` — `held` its tokens (it keeps one), `u` what it keeps
 * (the cut-adjusted keep), `floor` / `sOut` the pots' `F` and the tokens outside (at least `f` a token), `lineX64` the
 * backing line (0 = none), `sqrtCap` a `√p` it stops at (U128_MAX = none), `tokenCap` the most tokens. Nothing out: nothing
 * charged.
 */
export function tailBuy(
  liq: bigint,
  sqrt: bigint,
  held: bigint,
  offer: bigint,
  u: bigint,
  floor: bigint,
  sOut: bigint,
  lineX64: bigint,
  sqrtCap: bigint,
  tokenCap: bigint,
): TailBuy {
  if (liq === 0n || offer === 0n || u === 0n) return noBuy(sqrt);
  const x0 = tokensFloor(liq, sqrt);
  const maxOut = min(min(tokenCap, satSub(held, 1n)), satSub(x0, 1n));
  // the money's move: √p + (kept − 1) ÷ L
  const kept0 = mulDivDown(offer, u, ONE);
  let s1 = U128_MAX;
  const d = (satSub(kept0, 1n) * ONE) / liq;
  if (d <= U128_MAX && sqrt + d <= U128_MAX) s1 = sqrt + d;
  let capped = false;
  if (s1 > sqrtCap) {
    s1 = max(sqrtCap, sqrt);
    capped = true;
  }
  let n = satSub(x0, tailTokensAt(liq, s1));
  if (n > maxOut) {
    n = maxOut;
    s1 = max(sqrt, mulDivUp(liq, ONE, x0 - n));
    capped = true;
  }
  if (n === 0n) return noBuy(sqrt);
  // a capped move charges what it needs, ⌈(⌈L·(√p′ − √p) ÷ 2^64⌉ + 1) · 2^64 ÷ u⌉, and at least the least prices for all
  // its tokens (⌈⌈F·n ÷ S_out⌉ · 2^64 ÷ u⌉ and ⌈n · line ÷ 2^64⌉)
  let pay = offer;
  if (capped) {
    const sat = (f: () => bigint): bigint => {
      try {
        return f();
      } catch (e) {
        if (e instanceof FloorMathError && e.code === 'Overflow')
          return U128_MAX;
        throw e;
      }
    };
    const curve = mulDivUp(u128(mulDivUp(liq, s1 - sqrt, ONE) + 1n), ONE, u);
    const atF =
      floor > 0n && sOut > 0n
        ? sat(() => mulDivUp(mulDivUp(floor, n, sOut), ONE, u))
        : 0n;
    const atLine = lineX64 > 0n ? sat(() => mulDivUp(n, lineX64, ONE)) : 0n;
    pay = min(max(max(curve, atF), atLine), offer);
  }
  const kept = mulDivDown(pay, u, ONE);
  // the least prices: `f` a token from what the range keeps, the backing line from what the buyer pays
  let m = n;
  // (a bound: past u128 it binds nothing — a leg of 2¹²³+ is filled / refunded, never refused `Overflow`)
  if (floor > 0n && sOut > 0n) {
    const k = (kept * sOut) / floor;
    m = min(m, k > U128_MAX ? U128_MAX : k);
  }
  if (lineX64 > 0n) {
    const byLine = (pay << 64n) / lineX64;
    m = min(m, byLine > U128_MAX ? U128_MAX : byLine);
  }
  if (m === 0n) return noBuy(sqrt);
  if (m < n) {
    s1 = max(sqrt, min(s1, mulDivUp(liq, ONE, x0 - m)));
    n = m;
  }
  const toFloor = sOut === 0n ? 0n : min(mulDivUp(floor, n, sOut), kept);
  return {
    pay,
    out: n,
    kept,
    cut: pay - kept,
    toFloor,
    toMoney: kept - toFloor,
    sqrtAfter: s1,
  };
}

/**
 * `tail::sell`: a sell of up to `tokens` into the range at `√p`, down to `√end` at most — the curve pays
 * `⌊L·(√p − √p″) ÷ 2^64⌋ − 1`; `⌊F·k ÷ S_out⌋` of it from `F`, the rest from the range's `money` (at most what it holds).
 */
export function tailSell(
  liq: bigint,
  sqrt: bigint,
  sqrtEnd: bigint,
  money: bigint,
  tokens: bigint,
  floor: bigint,
  sOut: bigint,
): TailSell {
  if (liq === 0n || tokens === 0n || sqrt <= sqrtEnd) return noTailSell(sqrt);
  const x0 = tokensFloor(liq, sqrt);
  const xe = tailTokensAt(liq, sqrtEnd);
  const k = min(tokens, satSub(xe, x0));
  if (k === 0n) return noTailSell(sqrt);
  const s2 =
    x0 + k >= xe
      ? sqrtEnd
      : min(max(mulDivUp(liq, ONE, x0 + k), sqrtEnd), sqrt);
  // token by token the larger of the curve and `f`: the curve above `√f`, `f` under it (`f` read before the sell)
  const fromFloor = sOut === 0n ? 0n : mulDivDown(floor, k, sOut);
  const sf = sqrtX64(floorX64(floor, sOut));
  let fromMoney = 0n;
  if (sqrt > sf) {
    const sm = max(s2, sf);
    const k1 = min(satSub(tokensFloor(liq, sm), x0), k);
    const g1 = satSub(mulDivDown(liq, sqrt - sm, ONE), 1n);
    const f1 = sOut === 0n ? 0n : mulDivUp(floor, k1, sOut);
    fromMoney = min(satSub(g1, f1), money);
  }
  return {
    tokens: k,
    gross: fromFloor + fromMoney,
    fromFloor,
    fromMoney,
    sqrtAfter: s2,
  };
}

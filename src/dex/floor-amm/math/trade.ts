// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math `trade.rs` bit for bit: THE BUY'S PIECES the program composes — the keeperless schedule fill,
// the flat sale and its credit top, the floor's line, the window's price, the snipe cap, the creator buy. After the
// schedule's end the tail is one range (`tail.ts`) and the lot resells at `lotAskX64`. Held to `golden/trade.json`'s
// `window`, `flat_fill`, `lot_ask`, `tail_range` and `keeperless`.

import { BID_MARGIN_BPS, BID_TOP_MARGIN_BPS, bidPriceX64 } from './bid';
import type { Pots } from './bid';
import { BPS, fail, FloorMathError } from './index';
import { creatorBuyMaxTokens, saleTokens, windowTokens } from './preset';
import type { PresetSpec } from './preset';
import { splitMembers } from './fees';
import { fillToRoom, priceX64, raisePriceTo, raiseToBacking } from './schedule';
import type { Schedule, State } from './schedule';

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
/** `mul_div_up(..).unwrap_or(u128::MAX)`: the lines saturate past u128. */
const satMulDivUp = (a: bigint, b: bigint, c: bigint): bigint => {
  const n = a * b;
  const v = n / c + (n % c !== 0n ? 1n : 0n);
  return v > U128_MAX ? U128_MAX : v;
};
const sat = (v: bigint): bigint => (v > U128_MAX ? U128_MAX : v);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** What one fill along the schedule does. */
export interface Fill {
  pay: bigint;
  out: bigint;
  /** What the books keep of `pay`: credited to the pots floor first. */
  vaultIn: bigint;
  /** `pay − vaultIn`: what leaves the books — the three Marketcap Milestones and the rest (`fees.splitMilestones`). */
  cut: bigint;
  /** The inventory bound the fill: the schedule is DONE (its price frozen). */
  ended: boolean;
  after: State;
}

/** `trade::fill`: `offer` along the schedule out of `inventory`; a fill whose kept part rounds to nothing hands out nothing. */
export function fill(
  sch: Schedule,
  st: State,
  offer: bigint,
  inventory: bigint,
): Fill {
  const none: Fill = {
    pay: 0n,
    out: 0n,
    vaultIn: 0n,
    cut: 0n,
    ended: false,
    after: { ...st },
  };
  if (offer === 0n) return none;
  const [pay, out, after] = fillToRoom(sch, st, offer, inventory);
  const ended = pay < offer;
  if (out === 0n || after.h <= st.h) return { ...none, ended };
  // the books' money is `pow2(l)` in whole quote units, so a dust fill can add tokens faster than one unit of money and
  // the books' price would fall: such a fill sells nothing (the rest is refunded) — a buy never lowers the books' price
  if (priceX64(after) < priceX64(st)) return { ...none, ended };
  const vaultIn = min(after.h - st.h, pay);
  return { pay, out, vaultIn, cut: pay - vaultIn, ended, after };
}

/**
 * ⛔ `fill_keeperless`: at every `S_out > 0` (`money` = `F + C`, `min_public` 1), the books raised to `minPriceX64` (the
 * lot's resale floor; 0 none), the fill, then `out ≤ ⌊vault_in · S_out ÷ F⌋`. null: no price sells a token.
 */
export function fillKeeperless(
  sch: Schedule,
  st: State,
  offer: bigint,
  inventory: bigint,
  money: bigint,
  sOut: bigint,
  floor: bigint,
  minPriceX64: bigint,
): Fill | null {
  if (offer === 0n) return fill(sch, st, offer, inventory);
  const g = raiseToBacking(sch, st, money, sOut, offer, 1n);
  if (g === null) return null;
  const h = minPriceX64 > 0n ? raisePriceTo(sch, g, minPriceX64) : g;
  const f = fill(sch, h, offer, inventory);
  if (floor > 0n && sOut > 0n && f.out > 0n)
    f.out = min(f.out, mulDivDown(f.vaultIn, sOut, floor));
  return f;
}

/** A flat sale (the window, the lot or the tail after the end). */
export interface FlatFill {
  pay: bigint;
  out: bigint;
  /** `⌊pay · u ÷ 2^64⌋`: credited floor first. */
  kept: bigint;
  /** `pay − kept`. */
  cut: bigint;
}

export const NO_FLAT: FlatFill = Object.freeze({
  pay: 0n,
  out: 0n,
  kept: 0n,
  cut: 0n,
});

/**
 * ⛔ `flat_fill`: `⌊offer · 2^64 ÷ ask⌋` tokens, at most `have`; one-step cap with a floor; the charge `⌈n · ask⌉`; and
 * nothing at all if the kept part still falls short of `f` for the tokens. `u`: the slot-cut `u` in the window,
 * `Schedule.u` for the lot and the tail.
 */
export function flatFill(
  askX64: bigint,
  offer: bigint,
  have: bigint,
  u: bigint,
  floor: bigint,
  sOut: bigint,
): FlatFill {
  if (askX64 === 0n) fail('Zero');
  let n = min(min((offer << 64n) / askX64, U128_MAX), have);
  if (floor > 0n && sOut > 0n && n > 0n) {
    const pay = min(mulDivUp(n, askX64, ONE), offer);
    const kept = mulDivDown(pay, u, ONE);
    n = min(n, mulDivDown(kept, sOut, floor));
  }
  if (n === 0n) return { ...NO_FLAT };
  const pay = min(mulDivUp(n, askX64, ONE), offer);
  const kept = mulDivDown(pay, u, ONE);
  if (floor > 0n && sOut > 0n && kept * sOut < n * floor) return { ...NO_FLAT };
  return { pay, out: n, kept, cut: pay - kept };
}

/** a flat sale's credit tops the curve at most at `⌊ask · u⌋` (`⌊⌊ask · u⌋ · 10⁴ ÷ BID_TOP_MARGIN⌋`). */
export function flatCreditTop(
  bidTopX64: bigint,
  askX64: bigint,
  u: bigint,
): bigint {
  const kept = mulDivDown(askX64, u, ONE);
  return min(bidTopX64, mulDivDown(kept, BPS, BID_TOP_MARGIN_BPS));
}

/** The floor's line `⌈⌈f · 2^64 ÷ u⌉ · 1.03⌉`; 0 with no floor. */
export function floorLineX64(floorX64: bigint, u: bigint): bigint {
  if (floorX64 === 0n) return 0n;
  const fu = satMulDivUp(floorX64, ONE, max(u, 1n));
  return satMulDivUp(fu, BID_MARGIN_BPS, BPS);
}

/**
 * `backing_line_x64`: a flat sale (the window, the tail and the lot after the end) never sells under what the bid's whole
 * money holds per token outside, less this buy's own take: `⌈⌈⌈(F + C) · 2^64 ÷ S_out⌉ · (leg − take) ÷ leg⌉ · 2^64 ÷ u⌉`.
 * 0 with nothing outside, a 0 leg or no money.
 */
export function backingLineX64(
  band: bigint,
  sOut: bigint,
  take: bigint,
  leg: bigint,
  u: bigint,
): bigint {
  if (sOut === 0n || leg === 0n || band === 0n) return 0n;
  const n = band << 64n;
  const per = sat(n / sOut + (n % sOut !== 0n ? 1n : 0n));
  const net = satMulDivUp(per, leg - min(take, leg), leg);
  return satMulDivUp(net, ONE, max(u, 1n));
}

/** the window's flat price `max(p₀, the floor's line, 1)`. Pass the slot-cut `u`. */
export function windowPriceX64(
  p0X64: bigint,
  floorX64: bigint,
  u: bigint,
): bigint {
  return max(max(p0X64, floorLineX64(floorX64, u)), 1n);
}

/** The window's tokens this transaction may take: what is left, at most the snipe cap. */
export function windowRoom(windowLeft: bigint, cap: bigint | null): bigint {
  return cap === null ? windowLeft : min(windowLeft, cap);
}

/** the most tokens ONE transaction may buy `slotsSinceCreate` after create, or null (no cap). */
export function snipeCap(
  p: PresetSpec,
  decimals: number,
  slotsSinceCreate: bigint,
): bigint | null {
  if (
    p.snipeSlots === 0 ||
    p.windowMaxPerTxBps === 0 ||
    slotsSinceCreate >= BigInt(p.snipeSlots)
  )
    return null;
  const w = windowTokens(p, decimals);
  const base = w > 0n ? w : saleTokens(p, decimals);
  // at least one base unit a transaction
  return max(u128(base * BigInt(p.windowMaxPerTxBps)) / BPS, 1n);
}

/** may the creator's atomic buy take `tokens`? (≤ `creatorBuyMaxBps` of the window; none with no window.) */
export function creatorBuyOk(
  p: PresetSpec,
  decimals: number,
  tokens: bigint,
): boolean {
  return tokens <= creatorBuyMaxTokens(p, decimals);
}

// ---- THE TOKEN OPTION'S RELEASES (every release re-checks both lines; each split pro rata by the slot's weights) ----

/** `trade::alloc_released_after`: `⌊total · Σ_{i<releases} bps_i ÷ 10⁴⌋` (cumulative; the last release ends on the total). */
export function allocReleasedAfter(
  total: bigint,
  releaseBps: readonly number[],
  releases: number,
): bigint {
  let cum = 0n;
  for (let i = 0; i < releases && i < releaseBps.length; i++)
    cum += BigInt(releaseBps[i]);
  return (total * cum) / BPS;
}

/** `trade::alloc_next_release_at`: 0 before the first, else `releasedAt + releaseSecs` (saturating u64); null when done. */
export function allocNextReleaseAt(
  releasesDone: number,
  releaseCount: number,
  releasedAt: bigint,
  releaseSecs: number,
): bigint | null {
  if (releasesDone >= releaseCount) return null;
  if (releasesDone === 0) return 0n;
  const v = releasedAt + BigInt(releaseSecs);
  const max = (1n << 64n) - 1n;
  return v > max ? max : v;
}

/** `trade::split_release`: by the ppb weights (`splitMembers`), the dust to place 0; weights all 0 → place 0 takes all. */
export function splitRelease(tokens: bigint, w: readonly number[]): bigint[] {
  if (w.every(x => x === 0)) return w.map((_, i) => (i === 0 ? tokens : 0n));
  const [parts, dust] = splitMembers(tokens, w);
  const out = [...parts];
  out[0] += dust;
  return out;
}

/** The bought-back lot's margin: 10^4 = none (`trade::LOT_MARGIN_BPS`). */
export const LOT_MARGIN_BPS = 10_000n;

const lotLine = (x: bigint, u: bigint): bigint =>
  mulDivUp(mulDivUp(x, LOT_MARGIN_BPS, BPS), ONE, u > 0n ? u : 1n);

/**
 * `trade::lot_ask_x64`: ONE BIN's ask (`lotCost` / `lotTokens` are the bin's, `lot.ts`) — `max(` the bin's average cost `,`
 * `⌈F·2⁶⁴ ÷ S_out⌉` `,` the live bid (`max(bidPriceX64, rangeX64)`) `)` ÷ `u` (× the lot's margin), raised to the lot's own
 * line `lotBackingLineX64`, at least 1; `null` with no tokens or past u128 (the bin waits). `takeV` / `kept` / `leg`: the
 * buy's take on its whole leg and the kept skim in it (0 / 0 / 1 quote-free). `rangeX64`: after the end the tail range's
 * price while it is above its frozen price, else 0.
 */
export function lotAskX64(
  p: Pots,
  sOut: bigint,
  lotCost: bigint,
  lotTokens: bigint,
  u: bigint,
  takeV: bigint,
  kept: bigint,
  leg: bigint,
  rangeX64: bigint,
): bigint | null {
  if (lotTokens === 0n) return null;
  // `f` rounded up: an ask at the published (rounded-down) floor would sell nothing under `flatFill`'s exact floor check
  const f = sOut === 0n ? 0n : satMulDivUp(p.floor, ONE, sOut);
  const b = max(bidPriceX64(p, sOut), rangeX64);
  let t: bigint;
  try {
    const avg = lotCost === 0n ? 0n : mulDivUp(lotCost, ONE, lotTokens);
    t = max(max(lotLine(avg, u), lotLine(f, u)), lotLine(b, u));
  } catch (e) {
    if (e instanceof FloorMathError) return null;
    throw e;
  }
  const line = lotBackingLineX64(
    sat(p.floor + p.cushion),
    sOut,
    takeV,
    kept,
    leg,
    u,
  );
  const ask = max(max(t, line), 1n);
  return ask === U128_MAX ? null : ask;
}

/**
 * `trade::lot_backing_line_x64`: the bid's line for the lot, `⌈⌈⌈band·2⁶⁴ ÷ S_out⌉ · (leg − take) ÷ (leg − take + kept)⌉ ·
 * 2⁶⁴ ÷ u⌉` (`take ≤ leg`, `kept ≤ take`; 0 with `S_out`, `leg` or `band` 0; every step saturates): only the take that
 * leaves the pots discounts it. The window keeps `backingLineX64`.
 */
export function lotBackingLineX64(
  band: bigint,
  sOut: bigint,
  takeV: bigint,
  kept: bigint,
  leg: bigint,
  u: bigint,
): bigint {
  if (sOut === 0n || leg === 0n || band === 0n) return 0n;
  const per = satMulDivUp(band, ONE, sOut);
  const tk = min(takeV, leg);
  const den = leg - tk + min(kept, tk);
  const net = den === 0n ? U128_MAX : satMulDivUp(per, leg - tk, den);
  return satMulDivUp(net, ONE, u > 0n ? u : 1n);
}

/** `trade::lot_credit_top`: `min(bidTop, floor(floor(ask * u) * 10^4 / LOT_MARGIN))`. */
export function lotCreditTopX64(
  bidTopX64: bigint,
  askX64: bigint,
  u: bigint,
): bigint {
  return min(
    bidTopX64,
    mulDivDown(mulDivDown(askX64, u, ONE), BPS, LOT_MARGIN_BPS),
  );
}

/**
 * `trade::live_buy_price_x64`: the lower of `priceX64v` (the books' price while the schedule sells; after the end the tail
 * range's price) and the lot's ask (quote-free) while the lot holds tokens.
 */
export function liveBuyPriceX64(
  priceX64v: bigint,
  p: Pots,
  sOut: bigint,
  lotCost: bigint,
  lotTokens: bigint,
  u: bigint,
): bigint {
  const a = lotAskX64(p, sOut, lotCost, lotTokens, u, 0n, 0n, 1n, 0n);
  return a !== null && a < priceX64v ? a : priceX64v;
}

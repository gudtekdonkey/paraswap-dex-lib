// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math `lot.rs`: the bought-back lot at each token's cost — the tokens the pots buy on sells, kept by what
// EACH cost in `LOT_BINS` bins on a log-price grid of 32 bins an octave (a bin spans `2^(1/32)`, 2.19 %), sorted by key,
// resold the cheapest first, each at its own average cost (`trade.ts` `lotAskX64`). A sell's three stages (the curve's
// walk, the cushion at the running floor, `f`) are split exactly at the grid's edges into at most `LOT_PIECES` pieces a
// stage (`lotPieces`: 1, 1, 2, 4, … bins from the cheapest end). Everything mutates in place.

import { lotCostOut, priceOfSqrt, sqrtX64 } from './bid';
import type { SellFill } from './bid';
import { exp2X64, log2X64 } from './fixed';
import { fail } from './index';

const ONE = 1n << 64n;
const U128_MAX = (1n << 128n) - 1n;

/** The lot's bins (fixed on every chain). */
export const LOT_BINS = 16;
/** `log2` of the grid's bins an octave: 2⁵ = 32. */
export const LOT_BINS_PER_OCTAVE_LOG2 = 5;
export const LOT_BINS_PER_OCTAVE = 1 << LOT_BINS_PER_OCTAVE_LOG2;
/** The most pieces one stage of one sell is split into. */
export const LOT_PIECES = 8;

/** One bin: its grid key, the tokens it holds and what the pots paid for them (quote base units). */
export interface LotBin {
  key: number;
  tokens: bigint;
  cost: bigint;
}

/** The lot: `len` bins in use, sorted by key, the cheapest first; the rest zero (`bins.length` is always `LOT_BINS`). */
export interface Lot {
  len: number;
  bins: LotBin[];
}

const zeroBin = (): LotBin => ({ key: 0, tokens: 0n, cost: 0n });

/** `Lot::default()`. */
export function emptyLot(): Lot {
  return { len: 0, bins: Array.from({ length: LOT_BINS }, zeroBin) };
}

/** A deep copy. */
export function cloneLot(l: Lot): Lot {
  return { len: l.len, bins: l.bins.map(b => ({ ...b })) };
}

/** The bins in use. */
export function lotBinsInUse(l: Lot): LotBin[] {
  return l.bins.slice(0, l.len);
}

function mulDivDown(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) return fail('Zero');
  const v = (a * b) / c;
  return v > U128_MAX ? fail('Overflow') : v;
}

/** `mul_div_down(a, b, c).unwrap_or(u128::MAX)`: past u128, or a 0 divisor, saturates. */
function mulDivDownSat(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) return U128_MAX;
  const v = (a * b) / c;
  return v > U128_MAX ? U128_MAX : v;
}

const u128add = (a: bigint, b: bigint): bigint => {
  const v = a + b;
  return v > U128_MAX ? fail('Overflow') : v;
};

/** `lot::key_of`: `⌊log2(price_x64) · 32⌋` of the raw Q64.64 integer; 0 for a 0 price. */
export function lotKeyOf(priceX64: bigint): number {
  const l = log2X64(priceX64);
  return l === null ? 0 : Number(l >> BigInt(64 - LOT_BINS_PER_OCTAVE_LOG2));
}

/** `lot::edge_x64`: `2^(key ÷ 32)` as a raw Q64.64 integer, rounded down; saturates at u128::MAX. */
export function lotEdgeX64(key: number): bigint {
  const y = BigInt(key) << BigInt(64 - LOT_BINS_PER_OCTAVE_LOG2);
  const int = y >> 64n;
  const m = exp2X64(y & (ONE - 1n)) ?? U128_MAX;
  if (int >= 64n) {
    const sh = int - 64n;
    // `m.leading_zeros()` of a u128
    const lz = 128n - BigInt(m === 0n ? 0 : m.toString(2).length);
    return sh >= lz ? U128_MAX : m << sh;
  }
  return m >> (64n - int);
}

/** `lot::pieces`: a stage's pieces over the bins `kLo ..= kHi` as offsets `o[0] = 0 < … < o[n]`, `n ≤ LOT_PIECES`. */
export function lotPieces(kLo: number, kHi: number): [number[], number] {
  const span = (kHi > kLo ? kHi - kLo : 0) + 1;
  const o = Array.from({ length: LOT_PIECES + 1 }, () => 0);
  let n = 1;
  let b = 1;
  while (b < span && n < LOT_PIECES) {
    o[n] = b;
    n += 1;
    b *= 2;
  }
  o[n] = span;
  return [o, n];
}

/** `lot::piece_key`: piece `j`'s key, `kLo + o[j] + (o[j + 1] − o[j] − 1) ÷ 2`. */
export function lotPieceKey(
  kLo: number,
  o: readonly number[],
  j: number,
): number {
  return kLo + o[j] + Math.floor((o[j + 1] - o[j] - 1) / 2);
}

/** `Lot::insert`: into the bin with `key`, else a new bin in order; at 17 the two closest keys merge (ties: the dearest pair). */
export function lotInsert(
  l: Lot,
  key: number,
  tokens: bigint,
  cost: bigint,
): void {
  if (tokens === 0n) return;
  const n = l.len;
  let i = 0;
  while (i < n && l.bins[i].key < key) i++;
  if (i < n && l.bins[i].key === key) {
    const b = l.bins[i];
    b.tokens = u128add(b.tokens, tokens);
    b.cost = u128add(b.cost, cost);
    return;
  }
  const t: LotBin[] = [
    ...l.bins.slice(0, i).map(b => ({ ...b })),
    { key, tokens, cost },
    ...l.bins.slice(i, n).map(b => ({ ...b })),
  ];
  let m = n + 1;
  if (m > LOT_BINS) {
    let j = 0;
    for (let k = 1; k < m - 1; k++) {
      if (t[k + 1].key - t[k].key <= t[j + 1].key - t[j].key) j = k;
    }
    t[j].tokens = u128add(t[j].tokens, t[j + 1].tokens);
    t[j].cost = u128add(t[j].cost, t[j + 1].cost);
    t.splice(j + 1, 1);
    m -= 1;
  }
  while (t.length < LOT_BINS) t.push(zeroBin());
  l.bins = t;
  l.len = m;
}

/** `Lot::take`: `n` tokens leave bin `i`; the cost that leaves with them (`lotCostOut`); an emptied bin is removed. */
export function lotTake(l: Lot, i: number, n: bigint): bigint {
  const b = l.bins[i];
  const cost = lotCostOut(b.cost, b.tokens, n);
  if (n >= b.tokens) {
    l.bins.splice(i, 1);
    l.bins.push(zeroBin());
    l.len -= 1;
  } else {
    l.bins[i] = { key: b.key, tokens: b.tokens - n, cost: b.cost - cost };
  }
  return cost;
}

/** `Lot::add_sell`: a sell's tokens by what each cost — the curve's walk, the cushion at the running floor, the floor's at `f`. */
export function lotAddSell(l: Lot, fill: SellFill): void {
  lotSplitCurve(
    l,
    fill.curveTokens,
    fill.curveQuote,
    fill.curveFromX64,
    fill.curveToX64,
    fill.curveLiq,
  );
  lotSplitRun(l, fill.runTokens, fill.runQuote, fill.runFloor, fill.runS);
  if (fill.floorTokens > 0n) {
    // a price only KEYS the bin (its cost is booked exactly): past u128 it saturates
    const p = mulDivDownSat(fill.fromFloor, ONE, fill.floorTokens);
    lotInsert(l, lotKeyOf(p), fill.floorTokens, fill.fromFloor);
  }
}

const clamp = (v: bigint, lo: bigint, hi: bigint): bigint =>
  v < lo ? lo : v > hi ? hi : v;
const umin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const umax = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** `Lot::split_curve`: stage 1, `t` tokens for `q` walked down the curve from `√sb` to `√sn` at `liq`, piece by piece from the top. */
export function lotSplitCurve(
  l: Lot,
  t: bigint,
  q: bigint,
  sb: bigint,
  sn: bigint,
  liq: bigint,
): void {
  if (t === 0n) return;
  const kLo = lotKeyOf(priceOfSqrt(sn));
  const [o, n] = lotPieces(kLo, lotKeyOf(priceOfSqrt(sb)));
  let ct = 0n;
  let cq = 0n;
  for (let j = n - 1; j >= 1; j--) {
    // (Rust's `clamp(sn, sb)`: `max(sn).min(sb)`)
    const se = clamp(sqrtX64(lotEdgeX64(kLo + o[j])), sn, sb);
    const at =
      se === 0n
        ? t
        : umin(mulDivDown(mulDivDown(liq, sb - se, se), ONE, sb), t);
    const aq = umax(umin(mulDivDown(liq, sb - se, ONE), q), cq);
    if (at > ct) {
      lotInsert(l, lotPieceKey(kLo, o, j), at - ct, aq - cq);
      ct = at;
      cq = aq;
    }
  }
  lotRest(l, lotPieceKey(kLo, o, 0), t - ct, q - cq);
}

/** `Lot::split_run`: stage 2, `t` tokens for `q` at the running floor `F ÷ (S − x)`, piece by piece from the bottom. */
export function lotSplitRun(
  l: Lot,
  t: bigint,
  q: bigint,
  floor: bigint,
  s: bigint,
): void {
  if (t === 0n) return;
  // (the running floor's prices only key the pieces: past u128, or with nothing left, they saturate)
  const pLo = mulDivDownSat(floor, ONE, s);
  const kLo = lotKeyOf(pLo);
  const [o, n] = lotPieces(kLo, lotKeyOf(mulDivDownSat(floor, ONE, s - t)));
  let ct = 0n;
  let cq = 0n;
  let pA = pLo;
  for (let j = 1; j < n; j++) {
    const e = umax(lotEdgeX64(kLo + o[j]), 1n);
    // the tokens until the running floor reaches `e`: S − ⌈F·2^64 ÷ e⌉ (past u128: u128::MAX)
    const num = floor * ONE;
    let fe = num / e + (num % e !== 0n ? 1n : 0n);
    if (fe > U128_MAX) fe = U128_MAX;
    const at = umin(s > fe ? s - fe : 0n, t);
    if (at > ct) {
      const pq = umin(mulDivDown(at - ct, pA / 2n + e / 2n, ONE), q - cq);
      lotInsert(l, lotPieceKey(kLo, o, j - 1), at - ct, pq);
      ct = at;
      cq += pq;
    }
    pA = e;
  }
  lotRest(l, lotPieceKey(kLo, o, n - 1), t - ct, q - cq);
}

/** A stage's last piece; with no token left its quote joins the bin at `key`, else the dearest under it, else the cheapest. */
function lotRest(l: Lot, key: number, t: bigint, q: bigint): void {
  if (t > 0n) {
    lotInsert(l, key, t, q);
    return;
  }
  if (q === 0n || l.len === 0) return;
  let i = 0;
  while (i + 1 < l.len && l.bins[i + 1].key <= key) i++;
  l.bins[i] = { ...l.bins[i], cost: u128add(l.bins[i].cost, q) };
}

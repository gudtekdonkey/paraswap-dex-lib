// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// The cushion schedule, ported step by step from
// the reference crate's `schedule.rs`. Every rounding is Rust's (bigint truncation = Rust's integer division);
// `test/schedule.test.ts` holds the port to the golden `schedule.json` bit for bit.
//
// ⛔ Rust is the definition: change `schedule.rs`, regenerate the vectors, then follow here.

import { exp2X64, log2X64 } from './fixed';
import { FloorMathError, BPS } from './index';
import type { MathErrorCode } from './index';
import { U128_MAX } from './u256';

const ONE = 1n << 64n;
/** `1 ÷ ln 2` as Q64.64, rounded down. */
export const INV_LN2_X64 = 26_613_026_195_688_644_983n;
/** `ln 2` as Q64.64, rounded down. */
const LN2_X64 = 12_786_308_645_202_655_659n;
/** The most points a schedule may have. */
export const MAX_POINTS = 8;
/** `Schedule.toBytes`'s length (the crate's `SCHEDULE_LEN`): 8 (the count, padded) + 5 × 8 × 16 + 16. */
export const SCHEDULE_LEN = 8 + 5 * MAX_POINTS * 16 + 16;

function fail(code: MathErrorCode): never {
  throw new FloorMathError(code);
}

/** `.to_u128.ok_or(Overflow)`. */
function u128(v: bigint): bigint {
  return v > U128_MAX ? fail('Overflow') : v;
}

const mulQ = (a: bigint, b: bigint): bigint => u128((a * b) / ONE);
function divQ(a: bigint, b: bigint): bigint {
  if (b === 0n) fail('Zero');
  return u128((a << 64n) / b);
}
function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) fail('Zero');
  return u128((a * b) / c);
}
function log2(n: bigint): bigint {
  return log2X64(n) ?? fail('Zero');
}
function exp2(y: bigint): bigint {
  return exp2X64(y) ?? fail('Overflow');
}
const leadingZeros = (v: bigint): number =>
  v === 0n ? 128 : 128 - v.toString(2).length;
const satSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** `2^l` for `l` in Q64.64, as an integer, rounded down. */
export function pow2(l: bigint): bigint {
  const ip = Number(l >> 64n);
  const g = exp2(l & (ONE - 1n));
  if (ip >= 64) {
    const sh = ip - 64;
    if (sh >= leadingZeros(g)) fail('Overflow');
    return g << BigInt(sh);
  }
  return g >> BigInt(64 - ip);
}

/** `x · 2^y` for `y ≥ 0` in Q64.64, rounded down. */
function scaleUp(x: bigint, y: bigint): bigint {
  const ip = Number(y >> 64n);
  const g = exp2(y & (ONE - 1n));
  const v = u128((x * g) / ONE);
  if (ip >= leadingZeros(v) && v !== 0n) fail('Overflow');
  return v << BigInt(ip);
}

export interface Point {
  mcap: bigint;
  bps: number;
}

export interface ScheduleTerms {
  cushionBps: readonly [number, number];
  polBps: readonly [number, number];
  rampCpFrom: bigint;
  fullAt: bigint;
  floor0Bps: number;
  rampFrom: bigint;
  floorPoints: readonly [Point, Point, Point, Point];
  cutBps: number;
}

const bpsQ = (b: number): bigint => (BigInt(b) * ONE) / BPS;

function writeU128(b: Uint8Array, o: number, v: bigint): void {
  for (let i = 0; i < 16; i++) b[o + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}
function readU128(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

function lerp(
  knots: readonly (readonly [bigint, bigint])[],
  l: bigint,
): bigint {
  if (l <= knots[0][0]) return knots[0][1];
  for (let i = 0; i + 1 < knots.length; i++) {
    const [a, va] = knots[i];
    const [b, vb] = knots[i + 1];
    if (l <= b) {
      if (b === a) return vb;
      return va + mulDiv(vb - va, l - a, b - a);
    }
  }
  return knots[knots.length - 1][1];
}

/** The schedule, precomputed once per pool (Rust's `Schedule`). */
export class Schedule {
  readonly l: bigint[] = [];
  readonly cp: bigint[] = [];
  readonly f: bigint[] = [];
  readonly gcp: bigint[] = [];
  readonly gf: bigint[] = [];
  readonly u: bigint;

  private constructor(u: bigint) {
    this.u = u;
  }

  get length(): number {
    return this.l.length;
  }

  /** Rust's `Schedule::new`. */
  static create(t: ScheduleTerms, openMcap: bigint): Schedule {
    if (BigInt(t.cutBps) >= BPS) fail('VaultShareOutOfRange');
    const u = bpsQ(Number(BPS) - t.cutBps);
    const lOpen = log2(openMcap);
    const lFrom = log2(max(t.rampCpFrom, openMcap));
    const lFull = max(log2(max(t.fullAt, openMcap)), lFrom);
    if (t.cushionBps[1] < t.cushionBps[0] || t.polBps[1] < t.polBps[0])
      fail('RampOutOfRange');
    // a schedule whose ramp is full by the open opens at the full share
    const cOpen =
      lFull <= lOpen
        ? bpsQ(t.cushionBps[1]) + bpsQ(t.polBps[1])
        : bpsQ(t.cushionBps[0]) + bpsQ(t.polBps[0]);
    const cpKnots: [bigint, bigint][] = [
      [lOpen, cOpen],
      [lFrom, bpsQ(t.cushionBps[0]) + bpsQ(t.polBps[0])],
      [lFull, bpsQ(t.cushionBps[1]) + bpsQ(t.polBps[1])],
    ];
    const fKnots: [bigint, bigint][] = [[log2(t.rampFrom), bpsQ(t.floor0Bps)]];
    for (let i = 0; i < 4; i++) {
      const p = t.floorPoints[i];
      fKnots.push([log2(p.mcap), bpsQ(p.bps)]);
      if (fKnots[i + 1][0] <= fKnots[i][0] || fKnots[i + 1][1] < fKnots[i][1])
        fail('RampOutOfRange');
    }
    const ls = [
      lOpen,
      cpKnots[1][0],
      cpKnots[2][0],
      ...fKnots.map(k => k[0]),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const s = new Schedule(u);
    for (const x of ls) {
      if (x < lOpen || (s.l.length > 0 && x === s.l[s.l.length - 1])) continue;
      s.l.push(x);
      s.cp.push(lerp(cpKnots, x));
      s.f.push(lerp(fKnots, x));
      s.gcp.push(0n);
      s.gf.push(0n);
    }
    const n = s.l.length;
    for (let i = 0; i < n; i++) {
      if (i + 1 < n) {
        const dl = s.l[i + 1] - s.l[i];
        s.gcp[i] = divQ(s.cp[i + 1] - s.cp[i], dl);
        s.gf[i] = divQ(s.f[i + 1] - s.f[i], dl);
      }
      const kTop = i + 1 < n ? s.cp[i + 1] + s.f[i + 1] : s.cp[i] + s.f[i];
      const slope = mulQ(s.gcp[i] + s.gf[i], INV_LN2_X64);
      if (kTop + slope >= u) fail('RatioOutOfRange');
    }
    return s;
  }

  /**
   * ⛔ `Schedule::with_slot_cut`: this schedule with `slotQ` (Q64.64, the Team Slot's share of every payment) taken out
   * of what the books keep, `u' = u − slotQ`, for ONE fill (and the lot's flat ask). The shares are
   * unchanged; the price must still rise as it mints at `u'` on every interval, else `RatioOutOfRange`; `u'` 0 or less is
   * `VaultShareOutOfRange`. `slotQ` 0 is this schedule exactly.
   */
  withSlotCut(slotQ: bigint): Schedule {
    if (slotQ === 0n) return this;
    const u = this.u - slotQ;
    if (slotQ < 0n || u <= 0n) fail('VaultShareOutOfRange');
    const n = this.length;
    for (let i = 0; i < n; i++) {
      const kTop =
        i + 1 < n ? this.cp[i + 1] + this.f[i + 1] : this.cp[i] + this.f[i];
      const slope = mulQ(this.gcp[i] + this.gf[i], INV_LN2_X64);
      if (kTop + slope >= u) fail('RatioOutOfRange');
    }
    const s = new Schedule(u);
    s.l.push(...this.l);
    s.cp.push(...this.cp);
    s.f.push(...this.f);
    s.gcp.push(...this.gcp);
    s.gf.push(...this.gf);
    return s;
  }

  /**
   * `Schedule::to_bytes`: `n`, then the five arrays (each `MAX_POINTS` u128 LE, zero past `n`) and `u` — the bytes a
   * pool stores (`WagmiPool.schedule`).
   */
  toBytes(): Uint8Array {
    const b = new Uint8Array(SCHEDULE_LEN);
    b[0] = this.length;
    let o = 8;
    for (const arr of [this.l, this.cp, this.f, this.gcp, this.gf]) {
      for (let i = 0; i < MAX_POINTS; i++) {
        writeU128(b, o, arr[i] ?? 0n);
        o += 16;
      }
    }
    writeU128(b, o, this.u);
    return b;
  }

  /** `Schedule::from_bytes`: the stored schedule read back. ⛔ Only bytes the crate wrote: nothing is re-checked. */
  static fromBytes(b: Uint8Array): Schedule {
    if (b.length !== SCHEDULE_LEN)
      throw new RangeError(
        `a schedule is ${SCHEDULE_LEN} bytes, got ${b.length}`,
      );
    const n = Math.min(b[0], MAX_POINTS);
    const s = new Schedule(readU128(b, 8 + 5 * MAX_POINTS * 16));
    const arrs = [s.l, s.cp, s.f, s.gcp, s.gf];
    arrs.forEach((arr, k) => {
      for (let i = 0; i < n; i++)
        arr.push(readU128(b, 8 + (k * MAX_POINTS + i) * 16));
    });
    return s;
  }

  /** Point `i`: `[l, cp, f, cp′, f′]`. */
  point(i: number): [bigint, bigint, bigint, bigint, bigint] | null {
    return i < this.length
      ? [this.l[i], this.cp[i], this.f[i], this.gcp[i], this.gf[i]]
      : null;
  }

  seg(l: bigint): number {
    let i = 0;
    while (i + 1 < this.length && l >= this.l[i + 1]) i++;
    return i;
  }

  at(l: bigint): [bigint, bigint, bigint, bigint] {
    const i = this.seg(l);
    const d = satSub(l, this.l[i]);
    return [
      this.cp[i] + mulQ(this.gcp[i], d),
      this.gcp[i],
      this.f[i] + mulQ(this.gf[i], d),
      this.gf[i],
    ];
  }

  /** `(cp, f)` at `l` (the crate's `shares`). */
  shares(l: bigint): [bigint, bigint] {
    const [cp, , f] = this.at(l);
    return [cp, f];
  }

  /** below the open (`l < l[0]`, reachable since `retireFlat`) the open's own point is the next one. */
  nextPoint(l: bigint): bigint | null {
    if (this.length > 0 && l < this.l[0]) return this.l[0];
    const i = this.seg(l);
    return i + 1 < this.length && this.l[i + 1] > l ? this.l[i + 1] : null;
  }

  hA(l: bigint): bigint {
    const [cp, , f] = this.at(l);
    return mulQ(cp + f, pow2(l));
  }

  /** The crate's `line`: `[k at the interval's start, its slope, l − that start]`; flat at the open's shares below it. */
  line(l: bigint): [bigint, bigint, bigint] {
    if (this.length > 0 && l < this.l[0])
      return [this.cp[0] + this.f[0], 0n, 0n];
    const i = this.seg(l);
    return [this.cp[i] + this.f[i], this.gcp[i] + this.gf[i], l - this.l[i]];
  }

  dlog2sA(l0: bigint, l1: bigint): bigint {
    const [ka, g, e0] = this.line(l0);
    if (l1 < l0) fail('Overflow');
    const d = l1 - l0;
    const lin = mulQ(ka + mulQ(g, INV_LN2_X64), d);
    const quad = mulQ(g, mulQ(d, 2n * e0 + d)) / 2n;
    return divQ(lin + quad, this.u);
  }

  solveA(lo: bigint, hi: bigint, h: bigint): bigint {
    const lh = log2(h);
    let l = lo;
    for (let it = 0; it < 6; it++) {
      const [ka, gl, e] = this.line(l);
      const k = ka + mulQ(gl, e);
      const gk = mulQ(gl, INV_LN2_X64);
      const g = l + (log2(k) - (64n << 64n)) - lh;
      if (g >= 0n) break;
      const dg = ONE + divQ(gk, k);
      const step = divQ(-g, dg);
      if (step === 0n) break;
      l = min(l + step, hi);
    }
    let back = 1n << 20n;
    const over = (x: bigint): boolean => {
      try {
        return this.hA(x) > h;
      } catch (e) {
        if (e instanceof FloorMathError) return true;
        throw e;
      }
    };
    while (l > lo && over(l)) {
      l = max(satSub(l, back), lo);
      back <<= 1n;
    }
    return l;
  }
}

/** The books a buy at the price reads and writes (Rust's `State`). */
export interface State {
  s: bigint;
  h: bigint;
  l: bigint;
  floorX64: bigint;
}

export const mcapOf = (st: State): bigint => pow2(st.l);

/** The crate's `solve_b`: region B's `l` for `rest = h − floor·s`, Newton to a fixed point. */
function solveB(sch: Schedule, rest: bigint, lGuess: bigint): bigint {
  let l = lGuess;
  for (let i = 0; i < 8; i++) {
    const [cp, gcp] = sch.at(l);
    const target = log2(divQ(rest, cp));
    const dg = ONE + divQ(mulQ(gcp, INV_LN2_X64), cp);
    const step = divQ(target >= l ? target - l : l - target, dg);
    if (step === 0n) break;
    l = target >= l ? l + step : l - step;
  }
  return l;
}

/**
 * The crate's `retire`: tokens the floor's bid bought, retired from the books (`n` out of the supply, `cost` out of
 * the money, the floor unchanged), the market cap found again from the books. Never lowers the price.
 */
export function retire(
  sch: Schedule,
  st: State,
  n: bigint,
  cost: bigint,
): State {
  if (n === 0n && cost === 0n) return { ...st };
  if (st.s < n || st.s - n === 0n) fail('Zero');
  const s = st.s - n;
  if (st.h < cost) fail('Overflow');
  const h = st.h - cost;
  const floor = st.floorX64;
  const fs = mulQ(floor, s);
  const lb = h > fs ? solveB(sch, h - fs, st.l) : null;
  const bOk = lb !== null && mulQ(sch.at(lb)[2], pow2(lb)) <= fs;
  // region B holds there: that root is the answer (region A's solve below would not be read)
  if (lb !== null && bOk)
    return { s, h, l: lb, floorX64: retireFloor(sch, lb, s, floor) };
  let la: bigint | null = null;
  {
    const top = max(st.l, sch.l[0]);
    let i = sch.seg(top);
    while (i > 0 && sch.hA(sch.l[i]) > h) i--;
    if (sch.hA(sch.l[i]) <= h) {
      const hi = i + 1 < sch.length ? min(sch.l[i + 1], top) : top;
      la = sch.solveA(sch.l[i], max(hi, sch.l[i]), h);
    }
  }
  const aOk = la !== null && mulQ(sch.at(la)[2], pow2(la)) >= fs;
  let l: bigint;
  if (lb !== null && bOk) l = lb;
  else if (la !== null && aOk) l = la;
  else if (lb !== null && la !== null) l = min(lb, la);
  else if (lb !== null) l = lb;
  else if (la !== null) l = la;
  else fail('Zero');
  return { s, h, l, floorX64: retireFloor(sch, l, s, floor) };
}

/**
 * the crate's `rederive` — the books are a PRICING curve only; `h` is the curve's coordinate,
 * `cp(M)·M + max(F·s, f(M)·M)`, never money.
 */
export function rederive(sch: Schedule, st: State): State {
  const m = pow2(st.l);
  const [cp, f] = sch.shares(st.l);
  return {
    ...st,
    h: u128(mulQ(cp, m) + max(mulQ(st.floorX64, st.s), mulQ(f, m))),
  };
}

/** `retireFlat`'s round-up of `l`, raw Q64.64 units (the crate's `RETIRE_ROUND_UP`). */
export const RETIRE_ROUND_UP = 4n;

/** The step in `l` that moves an integer market cap `m` by about two units (the crate's `step_of`). */
function stepOf(m: bigint): bigint {
  return max((U128_MAX / max(m, 1n)) >> 62n, RETIRE_ROUND_UP);
}

/**
 * the crate's `retire_flat` — `n` tokens the protocol took back retired AT A FLAT PRICE: `s − n`,
 * `l − log2(s ÷ (s − n))` (rounded up until the price is not lower), the curve floor unchanged, `h` re-derived.
 */
export function retireFlat(sch: Schedule, st: State, n: bigint): State {
  if (n === 0n) return { ...st };
  if (st.s <= n) fail('Zero');
  const s = st.s - n;
  const d = satSub(log2(st.s), log2(s));
  if (st.l < d) fail('Overflow');
  let out = rederive(sch, {
    s,
    h: 0n,
    l: u128(st.l - d + RETIRE_ROUND_UP),
    floorX64: st.floorX64,
  });
  const p0 = priceX64(st);
  let bump = stepOf(pow2(out.l));
  while (priceX64(out) < p0) {
    out = rederive(sch, { ...out, l: u128(out.l + bump) });
    bump <<= 1n;
  }
  return out;
}

/** resale guard (the crate's `raise_price_to`): the books' price raised to at least `minPriceX64`, `l` only. */
export function raisePriceTo(
  sch: Schedule,
  st: State,
  minPriceX64: bigint,
): State {
  if (priceX64(st) >= minPriceX64) return { ...st };
  const num = minPriceX64 * st.s;
  const m = max(u128(num / ONE + (num % ONE !== 0n ? 1n : 0n)), 1n);
  let l = u128(log2(m) + RETIRE_ROUND_UP);
  let bump = stepOf(m);
  for (;;) {
    const out = rederive(sch, { ...st, l });
    if (priceX64(out) >= minPriceX64) return out;
    l = u128(l + bump);
    bump <<= 1n;
  }
}

/** margin over what the bid already holds per token, bps. */
export const BACKING_MARGIN_BPS = 10_300n;

/**
 * ⛔ (the crate's `backing_min_price`): the least books' price (Q64.64) a fill of `pay` may start at so that
 * `pay ÷ n ≥ (1.03·band + pay·u) ÷ (public + n)` — the bid's money after the fill per public token after it. `0n` when
 * nothing binds (the cut covers the margin), `null` when no price can hold (nothing outside, or past u128).
 */
export function backingMinPrice(
  sch: Schedule,
  band: bigint,
  pub: bigint,
  pay: bigint,
): bigint | null {
  if (pay === 0n) return 0n;
  const gb = u128((band * BACKING_MARGIN_BPS + 9_999n) / 10_000n);
  const cut = pay - mulQ(pay, sch.u);
  if (gb <= cut) return 0n;
  const c = gb - cut;
  if (pub === 0n) return null;
  const nm = (pay * pub) / c;
  const nMax = nm > U128_MAX ? U128_MAX : nm;
  if (nMax === 0n) return null;
  const m = (pay * ONE + nMax - 1n) / nMax;
  return m > U128_MAX ? null : m;
}

/**
 * ⛔ (the crate's `raise_to_backing`): the books a fill of `pay` starts from — raised (`l` only) to
 * `backingMinPrice`. A buy is never refused: under the dust line (`pub < minPublic`, the hooks pass
 * 1 % of the sale) the books come back UNCHANGED; `null` only where no price holds a fill of `pay` with the line met
 * (`backingMinPrice`'s `null`): the hooks keep such a payment as dust, never refusing.
 */
export function raiseToBacking(
  sch: Schedule,
  st: State,
  band: bigint,
  pub: bigint,
  pay: bigint,
  minPublic: bigint,
): State | null {
  if (pub < minPublic) return { ...st };
  const m = backingMinPrice(sch, band, pub, pay);
  if (m === null) return null;
  if (m === 0n) return { ...st };
  if (priceX64(st) >= m) return { ...st };
  return raisePriceTo(sch, st, m);
}

/** Where the floor's share binds the floor follows it, never down (the crate's `retire_floor`). */
function retireFloor(
  sch: Schedule,
  l: bigint,
  s: bigint,
  floor: bigint,
): bigint {
  const [, , f] = sch.at(l);
  return max(divQ(mulQ(f, pow2(l)), s), floor);
}

/** The crate's `raise_floor`: money that is no part of any buy raises the floor (`h + e`, `floor + e ÷ s`), not the price. */
export function raiseFloor(st: State, e: bigint): State {
  if (e === 0n) return { ...st };
  return {
    ...st,
    h: u128(st.h + e),
    floorX64: u128(st.floorX64 + divQ(e, st.s)),
  };
}
export const priceX64 = (st: State): bigint => divQ(pow2(st.l), st.s);

/** The market cap the pool opens at. The preset's schedule opens at `openMcap(raise, sale, 0n)`. */
export const openMcap = (raise: bigint, sale: bigint, pol: bigint): bigint =>
  mulDiv(raise, sale + pol, sale);

/**
 * Graduation: the books at the open with the POL's tokens IN them (the preset's are `openSale`'s). Refuses
 * `pol` 0 (`RatioOutOfRange`): on the sale alone with all the money the price cannot rise as it mints.
 */
export function open(
  sch: Schedule,
  raise: bigint,
  sale: bigint,
  pol: bigint,
): State {
  if (pol === 0n) fail('RatioOutOfRange');
  const s = sale + pol;
  const h = mulQ(raise, sch.u);
  const m = openMcap(raise, sale, pol);
  const l = log2(m);
  const [cp, , f] = sch.at(l);
  const heldAbove = mulQ(cp, m);
  if (heldAbove > h) fail('RampOutOfRange');
  const floorX64 = max(divQ(h - heldAbove, s), divQ(mulQ(f, m), s));
  return { s, h, l, floorX64 };
}

/**
 * `open_sale`: THE PRESET'S BOOKS AT GRADUATION — the sale only (`s` = the sale, the market cap the
 * raise) on the curve floor (`open`'s, the POL's tokens counted: ~83.6 % of the sale price), `h` re-derived. The POL's
 * 1M and the 89M are inventory, outside the books, so a resale counts them once.
 */
export function openSale(
  sch: Schedule,
  raise: bigint,
  sale: bigint,
  pol: bigint,
): State {
  const wide = open(sch, raise, sale, pol);
  return rederive(sch, {
    s: sale,
    h: 0n,
    l: log2(openMcap(raise, sale, 0n)),
    floorX64: wide.floorX64,
  });
}

/** The headroom a Team Slot keeps at the open past its row's max, bps. */
export const OPEN_SLOT_MARGIN_BPS = 50;

/**
 * `schedule::open_sale_for`: `openSale`, with the curve floor capped so every admissible Team Slot rate trades:
 * `φ ≤ (u − cp − bps(slotMax + 50)) · m ÷ sale`. Bit for bit `openSale` where the cap does not bind.
 */
export function openSaleFor(
  sch: Schedule,
  raise: bigint,
  sale: bigint,
  pol: bigint,
  slotMaxBps: number,
): State {
  const wide = openSale(sch, raise, sale, pol);
  const m = openMcap(raise, sale, 0n);
  const [cp] = sch.at(wide.l);
  const headroom = bpsQ(Math.min(slotMaxBps + OPEN_SLOT_MARGIN_BPS, 0xffff));
  const room = sch.u - cp - headroom;
  if (sch.u < cp || sch.u - cp < headroom || room <= 0n) fail('RampOutOfRange');
  const cap = divQ(mulQ(room, m), sale);
  if (wide.floorX64 <= cap) return wide;
  return rederive(sch, { s: sale, h: 0n, l: wide.l, floorX64: cap });
}

const phi = (floor: bigint, s: bigint, l: bigint): bigint =>
  u128((floor * s) / pow2(l));

function checkedSub(a: bigint, b: bigint): bigint {
  return a < b ? fail('Overflow') : a - b;
}

function lOfB(
  sch: Schedule,
  floor: bigint,
  h: bigint,
  s: bigint,
  lGuess: bigint,
): bigint {
  const rest = checkedSub(h, mulQ(floor, s));
  let l = lGuess;
  for (let it = 0; it < 1; it++) {
    const [cp, gcp] = sch.at(l);
    const target = log2(divQ(rest, cp));
    const dg = ONE + divQ(mulQ(gcp, INV_LN2_X64), cp);
    l = target >= l ? l + divQ(target - l, dg) : l - divQ(l - target, dg);
  }
  return l;
}

function dsDh(
  sch: Schedule,
  floor: bigint,
  h: bigint,
  s: bigint,
  l: bigint,
): bigint {
  const [cp] = sch.at(l);
  const rest = checkedSub(h, mulQ(floor, s));
  return mulDiv(cp, s, mulQ(sch.u, rest));
}

function stepB(
  sch: Schedule,
  floor: bigint,
  h: bigint,
  s: bigint,
  l: bigint,
  dh: bigint,
): [bigint, bigint] {
  const half = dh / 2n;
  const k1 = dsDh(sch, floor, h, s, l);
  const s2 = s + mulQ(k1, half);
  const l2 = lOfB(sch, floor, h + half, s2, l);
  const k2 = dsDh(sch, floor, h + half, s2, l2);
  const s3 = s + mulQ(k2, half);
  const l3 = lOfB(sch, floor, h + half, s3, l2);
  const k3 = dsDh(sch, floor, h + half, s3, l3);
  const s4 = s + mulQ(k3, dh);
  const l4 = lOfB(sch, floor, h + dh, s4, l3);
  const k4 = dsDh(sch, floor, h + dh, s4, l4);
  const s1 = s + mulQ(k1 + 2n * k2 + 2n * k3 + k4, dh) / 6n;
  return [s1, lOfB(sch, floor, h + dh, s1, l4)];
}

function maxStepB(
  sch: Schedule,
  floor: bigint,
  h: bigint,
  s: bigint,
  l: bigint,
): bigint {
  const rest = checkedSub(h, mulQ(floor, s));
  const lean = max(checkedSub(ONE, divQ(phi(floor, s, l), sch.u)), 1n);
  return max(divQ(rest, lean) >> 1n, 1n);
}

function flatB(
  sch: Schedule,
  floor: bigint,
  s: bigint,
  l: bigint,
  h1: bigint,
): [bigint, bigint, bigint, boolean, boolean] {
  const [c, , f] = sch.at(l);
  const u = sch.u;
  const uc = checkedSub(u, c);
  const p0 = divQ(pow2(l), s);
  const d0 = max(checkedSub(mulQ(uc, p0), floor), 1n);
  const a = mulDiv(mulQ(floor, s), u, uc);
  const b = mulDiv(mulQ(c, mulQ(d0, s)), ONE, uc);
  const e1 = divQ(u, c); // (u ÷ c) = e + 1
  const e = e1 - ONE;
  // the money's two terms at y (`money = A + B`; Newton's slope reuses them: ln 2 · (A + (e + 1)·B))
  const parts = (y: bigint): [bigint, bigint] => [
    scaleUp(a, y),
    scaleUp(b, mulQ(e1, y)),
  ];
  const money = (y: bigint): bigint => {
    const [x, z] = parts(y);
    return x + z;
  };
  // the supply, log2 of the market cap and `d₀·2^(e·y)` at y
  const books = (y: bigint): [bigint, bigint, bigint] => {
    const s1 = scaleUp(s, y);
    const grow = scaleUp(d0, mulQ(e, y));
    const p1 = divQ(floor + grow, uc);
    return [s1, log2(mulQ(p1, s1)), grow];
  };
  // where this flat stretch ends: the floor's share binding (P = floor ÷ f), or the next point of the schedule
  const num = mulQ(floor, satSub(uc, f));
  const den = max(mulQ(f, d0), 1n);
  const ySw = num > den ? divQ(log2(divQ(num, den)) - (64n << 64n), e) : 0n;
  // the crate's point-first search: tried only when the money could reach the next point (at least `c · 2^lb + floor · s₀`)
  let yHi = ySw;
  let cached: [bigint, bigint] | null = null;
  const lbFirst = sch.nextPoint(l);
  if (lbFirst !== null) {
    const lb = lbFirst;
    const reach = mulQ(c, pow2(lb)) + mulQ(floor, s);
    if (h1 >= reach) {
      // a start right of the root and near it: `log2(s₀·d₀ ÷ (u − c)) + (e + 1)·y` lies under `l(y)`
      const base = satSub(log2(mulDiv(s, d0, uc)), 64n << 64n);
      const guess = min(divQ(satSub(lb, base), e1), ySw);
      const [swS, swL, swG] = books(guess);
      if (swL > lb) {
        let z = guess;
        let sz = swS;
        let lz = swL;
        let grow = swG;
        for (let it = 0; it < 6; it++) {
          if (lz <= lb) break;
          const dl = ONE + mulDiv(mulQ(e, grow), ONE, floor + grow); // dl/dy
          const step = mulDiv(lz - lb, ONE, dl);
          if (step === 0n) break;
          z = satSub(z, step);
          [sz, lz, grow] = books(z);
        }
        let back = 1n << 20n;
        while (z > 0n && lz > lb) {
          z = satSub(z, back);
          back <<= 1n;
          [sz, lz] = books(z);
        }
        const [az, bz] = parts(z);
        if (az + bz <= h1) {
          // the books at the point itself: `l` ON the point (a hair above `books(z)`'s, never below)
          return [az + bz, sz, lb, false, false];
        }
        // the buy ends before the point: Newton on the money starts at z
        yHi = z;
        cached = [az, bz];
      }
    }
  }
  // the target: the switch if the money gets there, else the y where the money is h1 (Newton on the convex h(y) from the right)
  let [ay, by] = cached ?? parts(yHi);
  const hSw = yHi === ySw ? ay + by : money(ySw);
  let y = yHi;
  let done = false;
  if (hSw > h1) {
    done = true;
    for (let it = 0; it < 8; it++) {
      const hy = ay + by;
      if (hy <= h1) break;
      const slope = max(mulQ(LN2_X64, ay + mulQ(e1, by)), 1n);
      const step = mulDiv(hy - h1, ONE, slope);
      if (step === 0n) break;
      y = satSub(y, step);
      [ay, by] = parts(y);
    }
    // never past the money: step back if rounding left it a hair over
    let back = 1n << 20n;
    let hy = ay + by;
    while (y > 0n && hy > h1) {
      y = satSub(y, back);
      back <<= 1n;
      hy = money(y);
    }
  }
  let [s1, l1, growY] = books(y);
  // a buy the bound let through that still passes the point (the bound is a floor on the money there): stop at it
  const lb = sch.nextPoint(l);
  if (lb !== null && l1 > lb) {
    let z = y;
    let sz = s1;
    let lz = l1;
    let grow = growY;
    for (let it = 0; it < 6; it++) {
      if (lz <= lb) break;
      const dl = ONE + mulDiv(mulQ(e, grow), ONE, floor + grow);
      const step = mulDiv(lz - lb, ONE, dl);
      if (step === 0n) break;
      z = satSub(z, step);
      [sz, lz, grow] = books(z);
    }
    let back = 1n << 20n;
    while (z > 0n && lz > lb) {
      z = satSub(z, back);
      back <<= 1n;
      [sz, lz] = books(z);
    }
    return [money(z), sz, lb, false, false];
  }
  if (!done) {
    s1 = max(s1, s);
    l1 = max(l1, l);
    return [hSw, s1, l1, false, true];
  }
  return [h1, s1, l1, true, false];
}

function inA(sch: Schedule, floor: bigint, l: bigint, s: bigint): boolean {
  const [, , f] = sch.at(l);
  return f >= phi(floor, s, l);
}

function gap0(sch: Schedule, floor: bigint, l: bigint, s: bigint): bigint {
  const [, , f] = sch.at(l);
  return f - phi(floor, s, l);
}

/** A buy of `pay` quote base units at the price: `[minted, books after]` (Rust's `mint_for_payment`). */
export function mintForPayment(
  sch: Schedule,
  st: State,
  pay: bigint,
): [bigint, State] {
  const [n, after] = walk(sch, st, pay, false);
  return [n, after];
}

/** Rust's `walk`: `mintForPayment`, or with `stopAtA` the books at the walk's first pass in region A and `true`. */
function walk(
  sch: Schedule,
  st: State,
  pay: bigint,
  stopAtA: boolean,
): [bigint, State, boolean] {
  // in region B the walk re-derives the supply a few base units above the books': nothing paid mints nothing
  if (pay === 0n) return [0n, { ...st }, false];
  const h1 = u128(st.h + mulQ(pay, sch.u));
  let l = st.l;
  let s = st.s;
  const floor = st.floorX64;
  let h = st.h;
  let forceA = false;
  let guard = 0;
  for (;;) {
    guard++;
    if (guard > 4_096) fail('Overflow');
    if (forceA || inA(sch, floor, l, s)) {
      if (stopAtA) return [s - st.s, { s, h, l, floorX64: floor }, true];
      const top = sch.nextPoint(l);
      if (top !== null && sch.hA(top) <= h1) {
        s = scaleUp(s, sch.dlog2sA(l, top));
        l = top;
        continue;
      }
      const hi = min(top ?? l + (64n << 64n), l + (64n << 64n));
      const l1 = max(sch.solveA(l, hi, h1), l);
      s = scaleUp(s, sch.dlog2sA(l, l1));
      l = l1;
      const [, , f] = sch.at(l);
      const fl = max(divQ(mulQ(f, pow2(l)), s), floor);
      return [s - st.s, { s, h: h1, l, floorX64: fl }, false];
    }
    {
      const i = sch.seg(l);
      if (sch.gcp[i] === 0n && sch.gf[i] === 0n) {
        const [h2, s2, l2, done, atSwitch] = flatB(sch, floor, s, l, h1);
        forceA = atSwitch;
        h = h2;
        s = s2;
        l = max(l2, l);
        if (done) break;
        continue;
      }
    }
    const hNext = min(h + maxStepB(sch, floor, h, s, l), h1);
    const [sNext, lNext] = stepB(sch, floor, h, s, l, hNext - h);
    if (!inA(sch, floor, lNext, sNext)) {
      h = hNext;
      s = sNext;
      l = lNext;
      if (h === h1) break;
      continue;
    }
    const ev = (x: bigint): [bigint, bigint, bigint] => {
      const [sx, lx] = stepB(sch, floor, h, s, l, x);
      const [, , f] = sch.at(lx);
      return [f - phi(floor, sx, lx), sx, lx];
    };
    const dh = hNext - h;
    let a = 0n;
    let b = dh;
    // the bracket's right end is the whole step, already taken
    let sb = sNext;
    let lb = lNext;
    let ga = gap0(sch, floor, l, s);
    let gb = gap0(sch, floor, lNext, sNext);
    // Rust's early stop: the right end's gap under 2^-30 of a share
    const close = ONE >> 20n;
    let side = 0;
    for (let it = 0; it < 12; it++) {
      if (b - a <= max(dh >> 24n, 1n) || gb <= close) break;
      ga = min(ga, -1n);
      gb = max(gb, 1n);
      const w = mulDiv(b - a, -ga, gb - ga);
      const x = min(max(a + w, a + 1n), b - 1n);
      const [gx, sx, lx] = ev(x);
      if (gx >= 0n) {
        b = x;
        gb = gx;
        sb = sx;
        lb = lx;
        if (side === 1) ga /= 2n;
        side = 1;
      } else {
        a = x;
        ga = gx;
        if (side === -1) gb /= 2n;
        side = -1;
      }
    }
    h += b;
    s = sb;
    l = lb;
  }
  return [s - st.s, { s, h: h1, l, floorX64: floor }, false];
}

/**
 * A `pay` whose {@link mintForPayment} mints at least `x`, within what the books can tell apart ({@link resolution})
 * of a payment that does not: exact-out is DEFINED as this search's answer (the crate's `payment_for_mint`, step for
 * step). Not the least such payment: the mint is a staircase near any one payment at the fixed point's resolution.
 * Each trial stands for `m + ½` (its mint is rounded down), so steps aim at `x − ½` in doubled integers; until a trial
 * suffices, from its own end price (at least doubling); then Illinois' regula falsi between the bracket's ends.
 */
export function paymentForMint(sch: Schedule, st: State, x: bigint): bigint {
  if (x === 0n) return 0n;
  const x2 = u128(x * 2n);
  const u2 = u128(sch.u * 2n);
  let lo = 0n;
  let a = x2 - 1n;
  let hi: [bigint, bigint] | null = null;
  let kept = 0;
  let p = max(mulDiv(x, priceX64(st), sch.u), resolution(sch, st, 0n));
  for (let i = 0; i < 256; i++) {
    const [m, after] = mintForPayment(sch, st, p);
    const m2 = u128(m * 2n);
    if (m >= x) {
      const b = m2 + 1n - x2;
      if (kept === 1) a = max(a / 2n, 1n);
      kept = 1;
      hi = [p, b];
    } else {
      a = x2 - m2 - 1n;
      if (kept === -1 && hi) hi = [hi[0], max(hi[1] / 2n, 1n)];
      kept = -1;
      lo = p;
    }
    if (!hi) {
      const up = u128((a * priceX64(after)) / u2) + 1n;
      p = u128(p + max(up, p));
      continue;
    }
    const [h, b] = hi;
    if (h - lo <= resolution(sch, after, h)) return h;
    const den = u128(a + b);
    const num = (h - lo) * a;
    const q = u128(num / den) + (num % den !== 0n ? 1n : 0n);
    const t = lo + q;
    p = t < lo + 1n ? lo + 1n : t > h - 1n ? h - 1n : t;
  }
  fail('Overflow');
}

/** What the books can tell apart near `pay` from the books `st` (the crate's `resolution`). */
function resolution(sch: Schedule, st: State, pay: bigint): bigint {
  return max(
    max(mulDiv(2n + (st.s >> 44n), priceX64(st), sch.u), pay >> 40n),
    1n,
  );
}

// ---- what the program asks of the schedule (the preset row is `preset.ts`) -----------------------

/**
 * `split_cp`: the cushion's and the POL's parts of `cp` — both ramp over the same stretch, so the cushion's share is
 * `c0 + (c1 − c0)·t` with `t = (cp − cp0) ÷ (cp1 − cp0)` (0 while flat), the POL the rest.
 */
export function splitCp(
  t: Pick<ScheduleTerms, 'cushionBps' | 'polBps'>,
  cp: bigint,
): [bigint, bigint] {
  const [c0, c1] = [bpsQ(t.cushionBps[0]), bpsQ(t.cushionBps[1])];
  const [cp0, cp1] = [c0 + bpsQ(t.polBps[0]), c1 + bpsQ(t.polBps[1])];
  let c =
    cp1 > cp0 && cp > cp0
      ? c0 + mulDiv(c1 - c0, min(cp - cp0, cp1 - cp0), cp1 - cp0)
      : c0;
  c = min(c, cp);
  return [c, cp - c];
}

/**
 * `targets`: what the schedule asks the pool to hold at the books `st`, quote base units: `[floor, cushion, pol]` —
 * `floor·s`, and the cushion's and the POL's shares of the market cap. ⛔ Their sum is `h` only to the fixed point's
 * error; the hook places `floor` first and gives any surplus to the floor.
 */
export function targets(
  sch: Schedule,
  t: Pick<ScheduleTerms, 'cushionBps' | 'polBps'>,
  st: State,
): [bigint, bigint, bigint] {
  const m = pow2(st.l);
  const [cp] = sch.shares(st.l);
  const [c, p] = splitCp(t, cp);
  return [mulQ(st.floorX64, st.s), mulQ(c, m), mulQ(p, m)];
}

/** the crate's `cp_targets` — `[c(M)·M, p(M)·M]`, the cushion's and the POL's targets (no floor term on Solana). */
export function cpTargets(
  sch: Schedule,
  t: Pick<ScheduleTerms, 'cushionBps' | 'polBps'>,
  st: State,
): [bigint, bigint] {
  const m = pow2(st.l);
  const [cp] = sch.shares(st.l);
  const [c, p] = splitCp(t, cp);
  return [mulQ(c, m), mulQ(p, m)];
}

/**
 * `mint_capped`: a buy of at most `offer` that mints at most `room` (the 1T cap): `[pay, out, books after]`,
 * `pay ≤ offer`, `out ≤ room`. Two trial buys, never `paymentForMint`'s search: the full offer; past the room, the
 * offer scaled by `room ÷ out`, rounded up, the buyer getting `min(its mint, room)` for it. ⚠ The books after are the
 * scaled payment's, so they count the few tokens it mints past the room.
 */
export function mintCapped(
  sch: Schedule,
  st: State,
  offer: bigint,
  room: bigint,
): [bigint, bigint, State] {
  const [out, after] = mintForPayment(sch, st, offer);
  if (out <= room) return [offer, out, after];
  if (room === 0n) return [0n, 0n, { ...st }];
  const num = offer * room;
  const pay = min(u128(num / out + (num % out !== 0n ? 1n : 0n)), offer);
  const [got, after2] = mintForPayment(sch, st, pay);
  return [pay, min(got, room), after2];
}

/** The crate's `FILL_TO_ROOM_TRIALS`. */
export const FILL_TO_ROOM_TRIALS = 5;

/** The crate's `pow_interp`: the payment where the power law through `(pay, got)` points `a`, `b` reaches `room`; null where none. */
function powInterp(
  a: [bigint, bigint],
  b: [bigint, bigint],
  room: bigint,
): bigint | null {
  const lg = (x: bigint): bigint => {
    const v = log2X64(x);
    if (v === null) throw new FloorMathError('Zero');
    return v;
  };
  const [lpa, lga, lpb, lgb, lr] = [
    lg(a[0]),
    lg(a[1]),
    lg(b[0]),
    lg(b[1]),
    lg(room),
  ];
  const [dp, dg] = [lpa - lpb, lga - lgb];
  if (dp === 0n || dg === 0n || dp > 0n !== dg > 0n) return null;
  const num = lr - lga;
  const abs = (x: bigint): bigint => (x < 0n ? -x : x);
  const mag = mulDiv(abs(num), abs(dp), abs(dg));
  const neg = num < 0n !== (dp < 0n !== dg < 0n);
  const l = neg ? lpa - mag : lpa + mag;
  if (l < 0n || l > U128_MAX) return 1n;
  try {
    return pow2(l);
  } catch {
    return null;
  }
}

/**
 * The crate's `fill_to_room`: a buy of at most `offer` handing out at most `room` tokens of the INVENTORY,
 * `[pay, out, books after]`. THE END IN CLOSED FORM: from the books where the walk is in region A (where a walk of the
 * offer first enters it), region A's end at `st.s + room` and the least payment reaching its money,
 * `⌈(h_end − st.h) · 2^64 ÷ u⌉` — an offer of at least that buys exactly the room for exactly it; a smaller offer is
 * `mintForPayment`; trials (`fillToRoomTrials`) only where the room runs out inside region B.
 */
export function fillToRoom(
  sch: Schedule,
  st: State,
  offer: bigint,
  room: bigint,
): [bigint, bigint, State] {
  if (room === 0n || offer === 0n)
    return fillToRoomTrials(sch, st, offer, room);
  const s1 = u128(st.s + room);
  const [, a, inRegionA] = walk(sch, st, offer, true);
  if (!inRegionA || a.s >= s1) return fillToRoomTrials(sch, st, offer, room);
  const end = endInA(sch, a, s1);
  const dh = end.h - st.h;
  if (dh < 0n) fail('Overflow');
  const n = dh << 64n;
  const pay = u128(n / sch.u + (n % sch.u !== 0n ? 1n : 0n));
  if (pay <= offer)
    return [pay, room, { ...end, h: u128(st.h + mulQ(pay, sch.u)) }];
  const [out, after] = mintForPayment(sch, st, offer);
  if (out <= room) return [offer, out, after];
  return fillToRoomTrials(sch, st, offer, room);
}

/**
 * fill by TRIAL BUYS (the crate's `fill_to_room_trials`; now `fillToRoom`'s fallback): the crate's
 * trials step for step (the whole offer, the scaled offer, then the power law through the last two trials or the
 * bracket's middle) and its choice of answer.
 */
export function fillToRoomTrials(
  sch: Schedule,
  st: State,
  offer: bigint,
  room: bigint,
): [bigint, bigint, State] {
  const [out, after] = mintForPayment(sch, st, offer);
  if (out <= room) return [offer, out, after];
  if (room === 0n) return [0n, 0n, { ...st }];
  let up: [bigint, bigint, State] = [offer, out, after];
  let lo: [bigint, bigint, State] | null = null;
  let prev: [bigint, bigint] = [offer, out];
  let last: [bigint, bigint] = [offer, out];
  for (let k = 1; k < FILL_TO_ROOM_TRIALS; k++) {
    const floorPay = lo ? lo[0] : 0n;
    if (lo && (room - lo[1] <= room >> 20n || up[0] - lo[0] <= 2n)) break;
    let next: bigint;
    if (k === 1) {
      const n = up[0] * room;
      next = u128(n / up[1] + (n % up[1] !== 0n ? 1n : 0n));
    } else {
      let p: bigint | null;
      try {
        p = powInterp(last, prev, room);
      } catch {
        p = null;
      }
      next = p ?? (floorPay + up[0]) / 2n;
    }
    if (next <= floorPay || next >= up[0]) next = (floorPay + up[0]) / 2n;
    if (next <= floorPay || next >= up[0]) break;
    const [g, a] = mintForPayment(sch, st, next);
    prev = last;
    last = [next, g];
    if (g >= room) {
      up = [next, g, a];
      if (g === room) return [next, room, a];
    } else if (!lo || g > lo[1]) {
      lo = [next, g, a];
    }
  }
  if (up[1] - room <= room >> 20n) return [up[0], room, up[2]];
  if (lo && (room - lo[1]) * 100n <= room) return lo;
  if ((up[1] - room) * 100n <= room) return [up[0], room, up[2]];
  if (lo) return lo;
  return [up[0], room, up[2]];
}

/** `⌊√n⌋` (exact; the crate's Newton from above lands on the same integer). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * ⛔ (the crate's `books_at_supply`): the books where the schedule ENDS for supply `s1` (the books' supply + the
 * inventory) — region A's closed form per interval, then its quadratic; null from region B (the ratchet waits).
 */
export function booksAtSupply(
  sch: Schedule,
  st: State,
  s1: bigint,
): State | null {
  if (s1 <= st.s) return { ...st };
  if (!inA(sch, st.floorX64, st.l, st.s)) return null;
  return endInA(sch, st, s1);
}

/** Region A's end for supply `s1 > st.s` from books taken to be in region A (the crate's `end_in_a`). */
function endInA(sch: Schedule, st: State, s1: bigint): State {
  let left = log2(s1) - log2(st.s);
  if (left < 0n) fail('Overflow');
  let l = st.l;
  for (let k = 0; k < MAX_POINTS + 2; k++) {
    const lb = sch.nextPoint(l);
    if (lb !== null) {
      const d = sch.dlog2sA(l, lb);
      if (d <= left) {
        left -= d;
        l = lb;
        continue;
      }
    }
    const [ka, g, e0] = sch.line(l);
    const a = ka + mulQ(g, INV_LN2_X64);
    const ul = mulQ(sch.u, left);
    let d: bigint;
    if (g === 0n) {
      d = divQ(ul, a);
    } else {
      const b = a + mulQ(g, e0);
      const root = isqrt(b * b + 2n * g * ul);
      if (root < b) fail('Overflow');
      d = divQ(root - b + 1n, g);
    }
    l = u128(l + d + 1n);
    const [, , f] = sch.at(l);
    const floorX64 = max(divQ(mulQ(f, pow2(l)), s1), st.floorX64);
    return { s: s1, h: sch.hA(l), l, floorX64 };
  }
  fail('Overflow');
}

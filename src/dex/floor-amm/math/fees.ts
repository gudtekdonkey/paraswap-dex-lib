// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math `fees.rs` bit for bit: THE ONE FEE SET on every trade's quote leg — the skim ramped by the
// price's distance from the floor (into `F` less its `$FLOOR` cut), the creator fee, the FLOOR Platform fee and up to 4
// extra legs; the referral slices and the Team Slot's splits. Every trader leg rounds UP. Held to
// `golden/trade.json`'s `skim`, `take`, `referrals` and `team_slot`.

import { log2X64 } from './fixed';
import { BPS, fail } from './index';
import {
  MAX_EXTRA_LEGS,
  MILESTONES_LIVE_MAX_BPS,
  PRESET_MIN_SKIM_BUY_FAR_BPS,
} from './preset';
import type { PresetSpec } from './preset';

const U128_MAX = (1n << 128n) - 1n;
const u128 = (v: bigint): bigint => (v > U128_MAX ? fail('Overflow') : v);

/** `log2 1.2` in Q64.64, truncated: the skim's ramp spans a price 1.2 × the floor. */
export const SKIM_RAMP_LOG2_X64 = 4_852_128_366_996_249_510n;
/** the trader's referrers' slices of the Platform fee, bps of it. */
export const TRADER_REF_BPS: readonly [number, number, number] = [
  3_000, 500, 200,
];
/** the creator's referrers' slices of the creator fee — 90 / 9 / 1 % of its 10 %. */
export const CREATOR_REF_BPS: readonly [number, number, number] = [900, 90, 10];
export const LIST_MIN_FEE_BPS = 5;
export const MAX_MEMBERS = 5;
export const WEIGHT_ONE = 1_000_000_000n;
export const PPM = 1_000_000n;

/** A launch's rates, copied from its row at create. */
export interface Rates {
  skimBuyFarBps: number;
  skimSellFarBps: number;
  skimBuyAtFloorBps: number;
  skimSellAtFloorBps: number;
  creatorBuyBps: number;
  creatorSellBps: number;
  platformBps: number;
  cutBps: number;
  extraBps: readonly number[];
  /** the leg to `$FLOOR` (→ `cut_owed`). */
  floorTokenBps: number;
  /**
   * (APPENDED) the curved fees' START rates (the fields above are the END) and the three Marketcap Milestones
   * `[START, END]`, copied from the row. `ratesAt` turns them into one trade's flat rates.
   */
  skimFarStartBps: readonly [number, number];
  creatorStartBps: readonly [number, number];
  platformStartBps: number;
  floorTokenStartBps: number;
  teamMsBps: readonly [number, number];
  platformMsBps: readonly [number, number];
  floorMsBps: readonly [number, number];
}

/** `Rates::default()`: every rate 0 (the take-free raise). */
export function zeroRates(): Rates {
  return {
    skimBuyFarBps: 0,
    skimSellFarBps: 0,
    skimBuyAtFloorBps: 0,
    skimSellAtFloorBps: 0,
    creatorBuyBps: 0,
    creatorSellBps: 0,
    platformBps: 0,
    cutBps: 0,
    extraBps: [0, 0, 0, 0],
    floorTokenBps: 0,
    skimFarStartBps: [0, 0],
    creatorStartBps: [0, 0],
    platformStartBps: 0,
    floorTokenStartBps: 0,
    teamMsBps: [0, 0],
    platformMsBps: [0, 0],
    floorMsBps: [0, 0],
  };
}

/**
 * Where a trade sits on the curves, parts per billion — 0 at or under the START's FDV, `CURVE_ONE` at or past the END's,
 * `(log2 FDV − log2 from) ÷ (log2 to − log2 from)` rounded down between.
 */
export const CURVE_ONE = 1_000_000_000n;

/**
 * `fees::live_milestones`, the no-backing bound: the three Milestones scaled down together (each `⌊x · max ÷ Σ⌋`, their
 * split kept) when their sum passes `MILESTONES_LIVE_MAX_BPS`; unchanged under it.
 */
export function liveMilestones(
  team: number,
  platform: number,
  floor: number,
): [number, number, number] {
  return liveMilestonesTo(team, platform, floor, MILESTONES_LIVE_MAX_BPS);
}

/** `fees::live_milestones_to`: `liveMilestones` at a launch's own bound `max` (`Launch.msLiveMaxBps`). */
export function liveMilestonesTo(
  team: number,
  platform: number,
  floor: number,
  max: number,
): [number, number, number] {
  const mx = max;
  const sum = team + platform + floor;
  if (sum <= mx) return [team, platform, floor];
  return [
    Math.floor((team * mx) / sum),
    Math.floor((platform * mx) / sum),
    Math.floor((floor * mx) / sum),
  ];
}

/**
 * `fees::curve_bps`: `a + (b − a) · t` in bps at `t` ppb of `CURVE_ONE` (clamped), rounded UP (`up`: the fees, against the
 * trader) or DOWN (the Milestones).
 */
export function curveBps(a: number, b: number, t: bigint, up: boolean): number {
  const tt = t > CURVE_ONE ? CURVE_ONE : t < 0n ? 0n : t;
  const [lo, hi, fromLo] = a <= b ? [a, b, true] : [b, a, false];
  const d = BigInt(hi - lo) * (fromLo ? tt : CURVE_ONE - tt);
  const q = d / CURVE_ONE;
  const r = d % CURVE_ONE;
  return lo + Number(q) + (up && r > 0n ? 1 : 0);
}

/**
 * `Rates::cheaper_buy`: a BUY's take at the cheaper of two flattened `ratesAt` — the trade's place before it (`r`) and where
 * it ends (`end`) — leg by leg: the Floor Fee (the far buy skim), the Team Fee, the Platform fee and the `$FLOOR` fee. Every
 * curve is monotone in the FDV, so that is the least rate on the buy's path: one buy never pays more than the same money in
 * pieces. Every other field is `r`'s.
 */
export function cheaperBuy(r: Rates, end: Rates): Rates {
  return {
    ...r,
    skimBuyFarBps: Math.min(r.skimBuyFarBps, end.skimBuyFarBps),
    creatorBuyBps: Math.min(r.creatorBuyBps, end.creatorBuyBps),
    platformBps: Math.min(r.platformBps, end.platformBps),
    floorTokenBps: Math.min(r.floorTokenBps, end.floorTokenBps),
  };
}

/** Whether `cheaperBuy` changed anything (only its four legs can differ). */
export function buyRatesDiffer(a: Rates, b: Rates): boolean {
  return (
    a.skimBuyFarBps !== b.skimBuyFarBps ||
    a.creatorBuyBps !== b.creatorBuyBps ||
    a.platformBps !== b.platformBps ||
    a.floorTokenBps !== b.floorTokenBps
  );
}

/**
 * `Rates::at`: ONE trade's rates at curve position `t` (ppb; `CURVE_ONE` the END) — every curved fee and Milestone
 * flattened to its value there (start = end). The fees round UP and the Milestones DOWN (`curveBps`); a far buy skim with
 * a non-zero END never pays under 1 bp (a zero row stays zero). The at-floor skims and the extra legs are not curved. Then
 * `liveMilestones`.
 */
export function ratesAt(r: Rates, t: bigint): Rates {
  return ratesAtCapped(r, t, MILESTONES_LIVE_MAX_BPS);
}

/** `Rates::at_capped`: `ratesAt` with the Milestones' bound `max` together (`liveMilestonesTo`): the launch's own. */
export function ratesAtCapped(r: Rates, t: bigint, max: number): Rates {
  const c = (a: number, b: number, up: boolean): number =>
    curveBps(a, b, t, up);
  let bf = c(r.skimFarStartBps[0], r.skimBuyFarBps, true);
  if (r.skimBuyFarBps > 0 && bf < PRESET_MIN_SKIM_BUY_FAR_BPS)
    bf = PRESET_MIN_SKIM_BUY_FAR_BPS;
  const sf = c(r.skimFarStartBps[1], r.skimSellFarBps, true);
  const cb = c(r.creatorStartBps[0], r.creatorBuyBps, true);
  const cs = c(r.creatorStartBps[1], r.creatorSellBps, true);
  const pl = c(r.platformStartBps, r.platformBps, true);
  const ft = c(r.floorTokenStartBps, r.floorTokenBps, true);
  const [tm, pm, fm] = liveMilestonesTo(
    c(r.teamMsBps[0], r.teamMsBps[1], false),
    c(r.platformMsBps[0], r.platformMsBps[1], false),
    c(r.floorMsBps[0], r.floorMsBps[1], false),
    max,
  );
  return {
    skimBuyFarBps: bf,
    skimSellFarBps: sf,
    skimBuyAtFloorBps: r.skimBuyAtFloorBps,
    skimSellAtFloorBps: r.skimSellAtFloorBps,
    creatorBuyBps: cb,
    creatorSellBps: cs,
    platformBps: pl,
    cutBps: r.cutBps,
    extraBps: [...r.extraBps],
    floorTokenBps: ft,
    skimFarStartBps: [bf, sf],
    creatorStartBps: [cb, cs],
    platformStartBps: pl,
    floorTokenStartBps: ft,
    teamMsBps: [tm, tm],
    platformMsBps: [pm, pm],
    floorMsBps: [fm, fm],
  };
}

/** `Rates::milestones`: the three Milestones' flat rates on a flattened `ratesAt` (its END values): `[team, platform, $FLOOR]`. */
export function milestonesOf(r: Rates): [number, number, number] {
  return [r.teamMsBps[1], r.platformMsBps[1], r.floorMsBps[1]];
}

export function ratesOf(p: PresetSpec): Rates {
  return {
    skimBuyFarBps: p.skimBuyFarBps,
    skimSellFarBps: p.skimSellFarBps,
    skimBuyAtFloorBps: p.skimBuyAtFloorBps,
    skimSellAtFloorBps: p.skimSellAtFloorBps,
    creatorBuyBps: p.creatorBuyBps,
    creatorSellBps: p.creatorSellBps,
    platformBps: p.platformBps,
    cutBps: p.cutBps,
    extraBps: p.extraLegs.map(l => l.bps),
    floorTokenBps: p.floorTokenBps,
    skimFarStartBps: [p.skimFarStartBps[0], p.skimFarStartBps[1]],
    creatorStartBps: [p.creatorStartBps[0], p.creatorStartBps[1]],
    platformStartBps: p.platformStartBps,
    floorTokenStartBps: p.floorTokenStartBps,
    teamMsBps: [p.teamMsBps[0], p.teamMsBps[1]],
    platformMsBps: [p.platformMsBps[0], p.platformMsBps[1]],
    floorMsBps: [p.floorMsBps[0], p.floorMsBps[1]],
  };
}

export interface Take {
  skimBps: number;
  /** Gross skim (the cut inside it). */
  skim: bigint;
  /** The `$FLOOR` cut of the skim → the platform bucket. */
  cut: bigint;
  /** `skim − cut` → `F`. */
  kept: bigint;
  creator: bigint;
  platform: bigint;
  extra: bigint[];
  /** → `cut_owed`, then the `$FLOOR` launch's `F`. */
  floorToken: bigint;
  /** `skim + creator + platform + floorToken + Σ extra`. */
  total: bigint;
}

/** ⛔ `Take::without_kept`: a sell that leaves nobody outside keeps no skim; the cut and the other legs stand. */
export function withoutKept(t: Take): Take {
  return { ...t, skim: t.skim - t.kept, total: t.total - t.kept, kept: 0n };
}

/** `⌊leg · bps ÷ 10⁴⌋`. */
export function part(leg: bigint, bps: number): bigint {
  return u128((leg * BigInt(bps)) / BPS);
}

/** ⛔ (`part_up`): `⌈leg · bps ÷ 10⁴⌉` — what a TRADER pays on a leg rounds UP. */
export function partUp(leg: bigint, bps: number): bigint {
  return u128((leg * BigInt(bps) + BPS - 1n) / BPS);
}

/** 10,000 at or under `f`, 0 at 1.2 × `f` or more and with no floor; `10⁴ − ⌊log2(price ÷ f) · 10⁴ ÷ log2 1.2⌋` between. */
export function closenessBps(priceX64: bigint, floorX64: bigint): number {
  if (floorX64 === 0n) return 0;
  if (priceX64 <= floorX64) return Number(BPS);
  const lp = log2X64(priceX64) ?? 0n;
  const lf = log2X64(floorX64) ?? 0n;
  const d = lp > lf ? lp - lf : 0n;
  if (d >= SKIM_RAMP_LOG2_X64) return 0;
  let far = (d * BPS) / SKIM_RAMP_LOG2_X64;
  if (far > BPS) far = BPS;
  return Number(BPS - far);
}

/** The skim's rate at the books' price and `f` (both before the trade); a sell's skim never ramps down toward the floor. */
export function skimBpsAt(
  r: Rates,
  isBuy: boolean,
  priceX64: bigint,
  floorX64: bigint,
): number {
  const c = closenessBps(priceX64, floorX64);
  const b = 10_000;
  const [bf, sf, ba, sa] = [
    r.skimBuyFarBps,
    r.skimSellFarBps,
    r.skimBuyAtFloorBps,
    r.skimSellAtFloorBps,
  ];
  if (isBuy)
    return bf >= ba
      ? bf - Math.floor(((bf - ba) * c) / b)
      : bf + Math.floor(((ba - bf) * c) / b);
  return sf >= sa ? sf : sf + Math.floor(((sa - sf) * c) / b);
}

/** ⛔ THE TAKE on quote `leg`: a buy's quote in, a sell's gross quote out. `Overflow` if it would exceed the leg. */
export function take(
  r: Rates,
  leg: bigint,
  isBuy: boolean,
  priceX64: bigint,
  floorX64: bigint,
): Take {
  const skimBps = skimBpsAt(r, isBuy, priceX64, floorX64);
  // every trader leg rounds UP, bounded by what is left of the leg, in this order (skim, creator, platform, `$FLOOR`,
  // extras)
  let left = leg;
  const up = (bps: number): bigint => {
    let v = partUp(leg, bps);
    if (v > left) v = left;
    left -= v;
    return v;
  };
  const skim = up(skimBps);
  const creator = up(isBuy ? r.creatorBuyBps : r.creatorSellBps);
  const platform = up(r.platformBps);
  const floorToken = up(r.floorTokenBps);
  const extra: bigint[] = [];
  for (let i = 0; i < MAX_EXTRA_LEGS; i++) extra.push(up(r.extraBps[i] ?? 0));
  // the cut carved from the skim rounds UP too (never more than the skim)
  let cut = partUp(skim, r.cutBps);
  if (cut > skim) cut = skim;
  return {
    skimBps,
    skim,
    cut,
    kept: skim - cut,
    creator,
    platform,
    extra,
    floorToken,
    total: leg - left,
  };
}

/** Slices of `fee` at `bps[i]` for each tier present, each bounded by what is left: `[slices, left]`. */
export function slices(
  fee: bigint,
  present: readonly boolean[],
  bps: readonly number[],
): [bigint[], bigint] {
  const out = [0n, 0n, 0n];
  let left = fee;
  for (let i = 0; i < 3; i++) {
    if (!present[i] || bps[i] === 0) continue;
    let s = part(fee, bps[i]);
    if (s > left) s = left;
    out[i] = s;
    left -= s;
  }
  return [out, left];
}

/** the Platform fee → [the trader's referrers, the platform bucket's rest]. */
export const platformLegs = (
  platform: bigint,
  traderPresent: readonly boolean[],
): [bigint[], bigint] => slices(platform, traderPresent, TRADER_REF_BPS);
/** the creator fee → [the creator's referrers, the rest (the Team Slot's split, or the creator's)]. */
export const creatorLegs = (
  creator: bigint,
  creatorPresent: readonly boolean[],
): [bigint[], bigint] => slices(creator, creatorPresent, CREATOR_REF_BPS);

/** a listed discount off the Platform rate, never under `min` and never above the rate. */
export function discountedBps(
  rate: number,
  listBps: number,
  min: number,
): number {
  return Math.max(Math.max(rate - listBps, 0), Math.min(min, rate));
}

const ppm = (p: number): bigint => (BigInt(p) < PPM ? BigInt(p) : PPM);

/** of a schedule fill's `pay − vault_in`, the Team Slot's `⌊pay · rate · β⌋` (at most it) and the cut: `[slot, cut]`. */
export function splitFill(
  pay: bigint,
  outOfBooks: bigint,
  rateBps: number,
  boughtPpm: number,
): [bigint, bigint] {
  const want = u128((pay * BigInt(rateBps) * ppm(boughtPpm)) / (BPS * PPM));
  const slot = want < outOfBooks ? want : outOfBooks;
  return [slot, outOfBooks - slot];
}

/**
 * `fees::split_milestones`: of a window or schedule fill's `outOfBooks` (`pay − vaultIn`), the three Marketcap Milestones'
 * parts — `⌊pay · rate ÷ 10⁴⌋` each, in the order Team, `$FLOOR`, platform, each at most what is left — and the rest (the
 * books' rounding, → the platform bucket): `[team, floor, platform, rest]`. `ms` is `[team, platform, $FLOOR]`
 * (`milestonesOf`).
 */
export function splitMilestones(
  pay: bigint,
  outOfBooks: bigint,
  ms: readonly [number, number, number],
): [bigint, bigint, bigint, bigint] {
  let left = outOfBooks;
  const tk = (bps: number): bigint => {
    let v = part(pay, bps);
    if (v > left) v = left;
    left -= v;
    return v;
  };
  const team = tk(ms[0]);
  const floor = tk(ms[2]);
  const platform = tk(ms[1]);
  return [team, floor, platform, left];
}

/** the creator fee's rest with a Team Slot: `[slot, backing]`. */
export function splitCreator(
  rest: bigint,
  boughtPpm: number,
): [bigint, bigint] {
  const slot = u128((rest * ppm(boughtPpm)) / PPM);
  return [slot, rest - slot];
}

/** each member's weight, parts per billion of `bought`, rounded down. */
export function weights(paid: readonly bigint[], bought: bigint): number[] {
  if (bought === 0n) return paid.map(() => 0);
  // the members paid more than the slot sold: refused
  const total = paid.reduce((a, p) => a + p, 0n);
  if (total > U128_MAX || total > bought) fail('Overflow');
  return paid.map(p =>
    Number(u128(((p < bought ? p : bought) * WEIGHT_ONE) / bought)),
  );
}

/** A free slot's weights from the creator-named shares; Σshares = 0 → `[WEIGHT_ONE, 0, 0, 0, 0]` (place 0, the creator). */
export function slotWeights(shares: readonly bigint[]): number[] {
  const total = shares.reduce((a, b) => a + b, 0n);
  if (total > U128_MAX) fail('Overflow');
  if (total === 0n)
    return shares.map((_, i) => (i === 0 ? Number(WEIGHT_ONE) : 0));
  return weights(shares, total);
}

/** instant: each member's `⌊amount · w_i ÷ 10⁹⌋` and the dust (to `F`). */
export function splitMembers(
  amount: bigint,
  w: readonly number[],
): [bigint[], bigint] {
  let given = 0n;
  const parts = w.map(x => {
    const wi = BigInt(x) < WEIGHT_ONE ? BigInt(x) : WEIGHT_ONE;
    let v = u128((amount * wi) / WEIGHT_ONE);
    // weights over one in total never pay out more than `amount`
    if (v > amount - given) v = amount - given;
    given += v;
    return v;
  });
  return [parts, amount > given ? amount - given : 0n];
}

/**
 * ⛔ `leg_for_net`: the least leg whose take leaves at least `net`, at the same price
 * and `f`, and its take — the searched span `[⌈net · 10⁴ ÷ keep⌉, ⌈(net + k) · 10⁴ ÷ keep⌉]`, `k` the legs with a rate.
 * `Overflow` when the rates take everything.
 */
export function legForNet(
  r: Rates,
  net: bigint,
  isBuy: boolean,
  priceX64: bigint,
  floorX64: bigint,
): [bigint, Take] {
  const sk = skimBpsAt(r, isBuy, priceX64, floorX64);
  const legs = [
    sk,
    isBuy ? r.creatorBuyBps : r.creatorSellBps,
    r.platformBps,
    r.floorTokenBps,
    ...[0, 1, 2, 3].map(i => r.extraBps[i] ?? 0),
  ];
  const b = BigInt(legs.reduce((a, x) => a + x, 0));
  const k = BigInt(legs.filter(x => x > 0).length);
  if (b >= BPS) fail('Overflow');
  const keep = BPS - b;
  const up = (a: bigint): bigint => u128((a * BPS + keep - 1n) / keep);
  // every leg rounds UP by under one unit, so the least covering leg lies in [⌈net·10⁴ ÷ keep⌉, ⌈(net + k)·10⁴ ÷ keep⌉]
  const lo = up(net);
  const hi = up(net + k);
  for (let g = lo; g <= hi; g++) {
    const t = take(r, g, isBuy, priceX64, floorX64);
    if (g - t.total >= net) return [g, t];
  }
  return fail('Overflow');
}

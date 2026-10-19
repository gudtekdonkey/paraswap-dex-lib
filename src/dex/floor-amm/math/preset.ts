// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math `preset.rs` bit for bit: THE PRESET ROW — a governance-written row of DATA copied into a
// launch for life; `specOk` is the ONE check every chain's `add_preset` / `update_preset` runs; `PRESETS` holds only the seed
// rows (1 WAGMI, 2 Bluechip, 3 Moonshot). ⛔ Ids APPEND-ONLY, id 0 reserved. Held to `golden/schedule.json`'s `presets`,
// `preset_rows` (every field and `to_bytes`) and `spec_ok`.

import { BPS, fail } from './index';
import {
  OPEN_SLOT_MARGIN_BPS,
  Schedule,
  openMcap,
  openSaleFor,
} from './schedule';
import type { ScheduleTerms, State } from './schedule';

const ONE = 1n << 64n;
const U128_MAX = (1n << 128n) - 1n;

export const PRESET_WAGMI = 1;
export const PRESET_BLUECHIP = 2;
export const PRESET_MOONSHOT = 3;
/** ⛔ Id 0 is RESERVED: no row, ever. */
export const PRESET_CUSTOM = 0;
export const PRESET_MAX_ID = 3;
/** every launch mints 1B whole tokens to the program at create. */
export const PRESET_TOTAL_WHOLE = 1_000_000_000n;
/** tail: 1 % of the supply, sold flat after the schedule's end. */
export const PRESET_TAIL_BPS = 100n;
export const PRESET_TAIL_WHOLE =
  (PRESET_TOTAL_WHOLE * PRESET_TAIL_BPS) / 10_000n;
export const PRESET_MAX_SKIM_FAR_BPS = 1_000;
export const PRESET_MAX_SKIM_SELL_AT_FLOOR_BPS = 1_500;
/** The at-floor sell skim is at least 1 %. */
export const PRESET_MIN_SKIM_SELL_AT_FLOOR_BPS = 100;
/** The far buy skim is at least 1 bp. */
export const PRESET_MIN_SKIM_BUY_FAR_BPS = 1;
export const PRESET_MAX_CREATOR_BPS = 500;
/** the creator's free allocation's cap: 5 % of the supply. */
export const PRESET_MAX_CREATOR_ALLOC_BPS = 500;
export const PRESET_MAX_PLATFORM_BPS = 100;
/** the creator's atomic buy is at most 50 % of the window. */
export const PRESET_MAX_CREATOR_BUY_BPS = 5_000;
/** the Team Slot's rate never passes 10 %. */
export const TEAM_SLOT_HARD_MAX_BPS = 1_000;
/** the three Marketcap Milestones together never pass 15 % of a buy on a row (`curves_ok`). */
export const MILESTONES_MAX_BPS = 1_500;
/**
 * the live bound: the three Milestones TOGETHER take at most this much of a buy on a launch opened by `create`;
 * `fees.liveMilestonesTo` scales them down to a launch's own bound (`Launch.msLiveMaxBps`).
 */
export const MILESTONES_LIVE_MAX_BPS = 1_500;
/** the genesis launch's own live bound on the three Milestones together (set by its raise-priced open). */
export const GENESIS_MS_LIVE_MAX_BPS = 650;
export const MAX_EXTRA_LEGS = 4;
export const PRESET_MAX_EXTRA_BPS = 500;
/** The largest dollar amount a row may name (its raise, ramps and knots): `usd · 100` stays far inside u128. */
export const PRESET_MAX_USD = 1_000_000_000_000_000_000n;
/** the creator's buy is locked 1 day after create. */
export const CREATOR_BUY_LOCK_SECS = 86_400n;

/** an extra fee leg — `bps` of every trade's quote leg, to `dest` (32 bytes: a Solana key, or an EVM address right-aligned). */
export interface ExtraLeg {
  bps: number;
  dest: Uint8Array;
}

export const NO_LEG: ExtraLeg = Object.freeze({
  bps: 0,
  dest: new Uint8Array(32),
}) as ExtraLeg;

/** ⛔ ONE PRESET ROW (the crate's `PresetSpec`, field for field). */
export interface PresetSpec {
  id: number;
  raiseUsdCents: bigint;
  saleWhole: bigint;
  polWhole: bigint;
  heldWhole: bigint;
  /** the first `windowWhole` tokens sell flat at `p₀`; 0 = no window; ≤ the sale. */
  windowWhole: bigint;
  /** the creator's atomic buy, bps of the window. */
  creatorBuyMaxBps: number;
  /** slots (Solana) / blocks (EVM) after create while the per-transaction cap runs; 0 = off. */
  snipeSlots: number;
  /** bps of the window (of the sale with no window) one transaction may buy while it runs; 0 = off. */
  windowMaxPerTxBps: number;
  cushionBps: readonly [number, number];
  polBps: readonly [number, number];
  rampCpFromUsd: bigint;
  fullAtUsd: bigint;
  floor0Bps: number;
  rampFromUsd: bigint;
  floorPointsUsd: readonly (readonly [bigint, number])[];
  cutBps: number;
  skimBuyFarBps: number;
  skimSellFarBps: number;
  skimBuyAtFloorBps: number;
  skimSellAtFloorBps: number;
  creatorBuyBps: number;
  creatorSellBps: number;
  /** the FLOOR Platform fee, both ways. */
  platformBps: number;
  /** ≤ 800. */
  teamSlotMaxBps: number;
  /** 4 legs, empty by default. */
  extraLegs: readonly ExtraLeg[];
  /** the 0.25 % to `$FLOOR` on every trade's quote leg (booked to `cut_owed`). */
  floorTokenBps: number;
  /** the creator's FREE allocation, bps of the total supply, out of the inventory, locked until `creatorUnlockUsd`. */
  creatorAllocBps: number;
  /** the market cap (price × total supply, whole US dollars, at the declared quote price) that unlocks it. */
  creatorUnlockUsd: bigint;
  /** the pots' money (`F + C`, whole US dollars, at the declared quote price) the unlock also needs; 0 = none. */
  unlockBackingUsd: bigint;
  /** (APPENDED) the Token Option: the allocation is released in `allocReleaseCount` releases (1 ..= 8), each `allocReleaseBps[i]` of it, `allocReleaseSecs` apart. */
  allocReleaseCount: number;
  allocReleaseBps: readonly number[];
  allocReleaseSecs: number;
  /**
   * (APPENDED) the curves: every fee and Marketcap Milestone is a curve on the launch's FDV (the books' price × the live
   * supply), linear in `log2(FDV)` from `curveFromUsd` (the START) to `curveToUsd` (the END), flat outside. Whole USD at the
   * declared quote price, fixed at create.
   */
  curveFromUsd: bigint;
  curveToUsd: bigint;
  /** the fees' START rates `[buy, sell]` (the fee fields above are the END; start = end is a flat fee). The at-floor skims are not curved. */
  skimFarStartBps: readonly [number, number];
  creatorStartBps: readonly [number, number];
  platformStartBps: number;
  floorTokenStartBps: number;
  /**
   * the Marketcap Milestones `[START, END]`, bps of each window / schedule buy, inside the price (never on a sell, never after
   * the schedule's end): the Team Slot's (the creator's with no slot), the platform bucket's and `$FLOOR`'s.
   */
  teamMsBps: readonly [number, number];
  platformMsBps: readonly [number, number];
  floorMsBps: readonly [number, number];
}

/** `PresetSpec::ms_top_bps`: the three Milestones' largest total (each curve's larger end, summed). */
export const msTopBps = (p: PresetSpec): number =>
  Math.max(p.teamMsBps[0], p.teamMsBps[1]) +
  Math.max(p.platformMsBps[0], p.platformMsBps[1]) +
  Math.max(p.floorMsBps[0], p.floorMsBps[1]);
/** `preset::slot_room`: the headroom the open leaves under 100 % — max(`teamSlotMaxBps`, `msTopBps`). */
export const slotRoom = (p: PresetSpec): number =>
  Math.max(p.teamSlotMaxBps, msTopBps(p));

/** The Token Option: at most 8 releases; the seed rows' placeholders (4 equal releases, 30 days apart). */
export const MAX_ALLOC_RELEASES = 8;
const SEED_ALLOC_RELEASE_BPS: readonly number[] = Object.freeze([
  2_500, 2_500, 2_500, 2_500, 0, 0, 0, 0,
]);

export const inventoryWhole = (p: PresetSpec): bigint =>
  p.polWhole + p.heldWhole;
export const totalWhole = (p: PresetSpec): bigint =>
  p.saleWhole + inventoryWhole(p);
export const tailWhole = (p: PresetSpec): bigint =>
  (totalWhole(p) * PRESET_TAIL_BPS) / 10_000n;
export const resellableWhole = (p: PresetSpec): bigint =>
  inventoryWhole(p) - tailWhole(p);
/** the schedule's room once the window has sold — everything but the tail and the window. */
export const scheduleWhole = (p: PresetSpec): bigint =>
  totalWhole(p) - tailWhole(p) - p.windowWhole - creatorAllocWhole(p);
/** the creator's free allocation, whole tokens (10M at 100 bps), out of the schedule's inventory. */
export const creatorAllocWhole = (p: PresetSpec): bigint =>
  (totalWhole(p) * BigInt(p.creatorAllocBps)) / 10_000n;
export const extraBps = (p: PresetSpec): number =>
  p.extraLegs.reduce((a, l) => a + l.bps, 0);

const legs = (): ExtraLeg[] => [NO_LEG, NO_LEG, NO_LEG, NO_LEG];

/**
 * The seed rows' curves (all three alike; preset DATA): $100K → $100M FDV; the far skim 0 → 2 bps both ways; the creator
 * fee 100 → 1; Platform 10 → 1; `$FLOOR` 10 → 1 (the ENDs are the rows' fee fields); Milestones Team a flat 10 %, Platform
 * 10 → 100, `$FLOOR` 10 → 100.
 */
const SEED_CURVES = {
  curveFromUsd: 100_000n,
  curveToUsd: 100_000_000n,
  skimFarStartBps: [0, 0] as const,
  creatorStartBps: [100, 100] as const,
  platformStartBps: 10,
  floorTokenStartBps: 10,
  teamMsBps: [1_000, 1_000] as const,
  platformMsBps: [10, 100] as const,
  floorMsBps: [10, 100] as const,
};

/** ⛔ Seed row 1, WAGMI. The values are SEEDS. */
export const WAGMI: PresetSpec = {
  id: PRESET_WAGMI,
  raiseUsdCents: 60_000n,
  saleWhole: 1_200_000n,
  polWhole: 1_000_000n,
  heldWhole: 997_800_000n,
  windowWhole: 1_200_000n,
  creatorBuyMaxBps: 5_000,
  snipeSlots: 0,
  windowMaxPerTxBps: 0,
  cushionBps: [200, 200],
  polBps: [100, 100],
  rampCpFromUsd: 300_000n,
  fullAtUsd: 1_000_000n,
  floor0Bps: 5_000,
  rampFromUsd: 500_000n,
  floorPointsUsd: [
    [1_000_000n, 5_000],
    [10_000_000n, 5_000],
    [100_000_000n, 5_000],
    [1_000_000_000n, 5_000],
  ],
  cutBps: 0,
  skimBuyFarBps: 2,
  skimSellFarBps: 2,
  skimBuyAtFloorBps: 0,
  skimSellAtFloorBps: 100,
  creatorBuyBps: 1,
  creatorSellBps: 1,
  platformBps: 1,
  teamSlotMaxBps: 1_000,
  extraLegs: legs(),
  floorTokenBps: 1,
  creatorAllocBps: 100,
  creatorUnlockUsd: 100_000_000n,
  unlockBackingUsd: 21_600_000n,
  allocReleaseCount: 4,
  allocReleaseBps: SEED_ALLOC_RELEASE_BPS,
  allocReleaseSecs: 2_592_000,
  ...SEED_CURVES,
};

/** ⛔ Seed row 2, Bluechip. */
export const BLUECHIP: PresetSpec = {
  id: PRESET_BLUECHIP,
  raiseUsdCents: 1_000_000n,
  saleWhole: 10_000_000n,
  polWhole: 1_000_000n,
  heldWhole: 989_000_000n,
  windowWhole: 10_000_000n,
  creatorBuyMaxBps: 5_000,
  snipeSlots: 0,
  windowMaxPerTxBps: 0,
  cushionBps: [800, 800],
  polBps: [200, 400],
  rampCpFromUsd: 300_000n,
  fullAtUsd: 1_000_000n,
  floor0Bps: 2_500,
  rampFromUsd: 272_000n,
  floorPointsUsd: [
    [4_490_000n, 3_000],
    [20_700_000n, 4_000],
    [137_900_000n, 5_000],
    [297_000_000n, 5_000],
  ],
  cutBps: 0,
  skimBuyFarBps: 2,
  skimSellFarBps: 2,
  skimBuyAtFloorBps: 0,
  skimSellAtFloorBps: 100,
  creatorBuyBps: 1,
  creatorSellBps: 1,
  platformBps: 1,
  teamSlotMaxBps: 1_000,
  extraLegs: legs(),
  floorTokenBps: 1,
  creatorAllocBps: 100,
  creatorUnlockUsd: 100_000_000n,
  unlockBackingUsd: 6_600_000n,
  allocReleaseCount: 4,
  allocReleaseBps: SEED_ALLOC_RELEASE_BPS,
  allocReleaseSecs: 2_592_000,
  ...SEED_CURVES,
};

/** ⛔ Seed row 3, Moonshot. */
export const MOONSHOT: PresetSpec = {
  id: PRESET_MOONSHOT,
  raiseUsdCents: 200_000n,
  saleWhole: 28_000_000n,
  polWhole: 1_000_000n,
  heldWhole: 971_000_000n,
  windowWhole: 28_000_000n,
  creatorBuyMaxBps: 5_000,
  snipeSlots: 0,
  windowMaxPerTxBps: 0,
  cushionBps: [400, 400],
  polBps: [100, 100],
  rampCpFromUsd: 300_000n,
  fullAtUsd: 1_000_000n,
  floor0Bps: 1_000,
  rampFromUsd: 40_716n,
  floorPointsUsd: [
    [4_210_112n, 1_000],
    [15_249_268n, 3_500],
    [15_249_269n, 3_500],
    [15_249_270n, 3_500],
  ],
  cutBps: 0,
  skimBuyFarBps: 2,
  skimSellFarBps: 2,
  skimBuyAtFloorBps: 0,
  skimSellAtFloorBps: 100,
  creatorBuyBps: 1,
  creatorSellBps: 1,
  platformBps: 1,
  teamSlotMaxBps: 1_000,
  extraLegs: legs(),
  floorTokenBps: 1,
  creatorAllocBps: 100,
  creatorUnlockUsd: 100_000_000n,
  unlockBackingUsd: 4_200_000n,
  allocReleaseCount: 4,
  allocReleaseBps: SEED_ALLOC_RELEASE_BPS,
  allocReleaseSecs: 2_592_000,
  ...SEED_CURVES,
};

export const PRESETS: readonly PresetSpec[] = [WAGMI, BLUECHIP, MOONSHOT];

/** The seed row `id`, or null (id 0 included). */
export function presetSpec(id: number): PresetSpec | null {
  return id >= 1 && id <= PRESET_MAX_ID ? PRESETS[id - 1] : null;
}

/** ⛔ THE ONE CHECK every chain's registry runs (`spec_ok`). */
function allocReleasesOk(p: PresetSpec): boolean {
  const n = p.allocReleaseCount;
  if (
    n === 0 ||
    n > MAX_ALLOC_RELEASES ||
    p.allocReleaseBps.length !== MAX_ALLOC_RELEASES
  )
    return false;
  let t = 0;
  for (let i = 0; i < MAX_ALLOC_RELEASES; i++) {
    const b = p.allocReleaseBps[i];
    if (i < n === (b === 0)) return false;
    t += b;
  }
  return (
    t === 10_000 &&
    p.allocReleaseSecs <= 31_536_000 &&
    (n === 1 || p.allocReleaseSecs > 0)
  );
}

export function specOk(p: PresetSpec): boolean {
  const k = p.floorPointsUsd;
  if (k.length !== 4 || p.extraLegs.length !== MAX_EXTRA_LEGS) return false;
  const legsOk = p.extraLegs.every(
    l => l.bps === 0 || l.dest.some(b => b !== 0),
  );
  const usdOk =
    p.raiseUsdCents <= PRESET_MAX_USD * 100n &&
    p.rampCpFromUsd <= PRESET_MAX_USD &&
    p.fullAtUsd <= PRESET_MAX_USD &&
    p.rampFromUsd <= PRESET_MAX_USD &&
    k[3][0] <= PRESET_MAX_USD;
  return (
    usdOk &&
    p.saleWhole + p.polWhole + p.heldWhole === PRESET_TOTAL_WHOLE &&
    p.id !== PRESET_CUSTOM &&
    totalWhole(p) === PRESET_TOTAL_WHOLE &&
    tailWhole(p) === PRESET_TAIL_WHOLE &&
    p.heldWhole > PRESET_TAIL_WHOLE &&
    p.polWhole > 0n &&
    p.saleWhole > 0n &&
    p.raiseUsdCents >= 100n &&
    p.windowWhole <= p.saleWhole &&
    p.creatorBuyMaxBps <= PRESET_MAX_CREATOR_BUY_BPS &&
    BigInt(p.windowMaxPerTxBps) <= BPS &&
    p.cushionBps[0] <= p.cushionBps[1] &&
    p.polBps[0] <= p.polBps[1] &&
    BigInt(p.cutBps) < BPS &&
    p.rampFromUsd < k[0][0] &&
    k[0][0] < k[1][0] &&
    k[1][0] < k[2][0] &&
    k[2][0] < k[3][0] &&
    p.floor0Bps <= k[0][1] &&
    k[0][1] <= k[1][1] &&
    k[1][1] <= k[2][1] &&
    k[2][1] <= k[3][1] &&
    BigInt(k[3][1]) < BPS &&
    p.skimBuyFarBps >= PRESET_MIN_SKIM_BUY_FAR_BPS &&
    p.skimBuyFarBps <= PRESET_MAX_SKIM_FAR_BPS &&
    p.skimSellFarBps <= PRESET_MAX_SKIM_FAR_BPS &&
    p.skimBuyAtFloorBps <= p.skimBuyFarBps &&
    p.skimSellAtFloorBps >= PRESET_MIN_SKIM_SELL_AT_FLOOR_BPS &&
    p.skimSellAtFloorBps <= PRESET_MAX_SKIM_SELL_AT_FLOOR_BPS &&
    p.creatorBuyBps <= PRESET_MAX_CREATOR_BPS &&
    p.creatorSellBps <= PRESET_MAX_CREATOR_BPS &&
    p.platformBps <= PRESET_MAX_PLATFORM_BPS &&
    p.teamSlotMaxBps <= TEAM_SLOT_HARD_MAX_BPS &&
    extraBps(p) <= PRESET_MAX_EXTRA_BPS &&
    legsOk &&
    // the cut inside the price is removed: a row carries none
    p.cutBps === 0 &&
    p.floorTokenBps <= PRESET_MAX_PLATFORM_BPS &&
    p.creatorAllocBps <= PRESET_MAX_CREATOR_ALLOC_BPS &&
    p.heldWhole > PRESET_TAIL_WHOLE + creatorAllocWhole(p) &&
    roundTripLoses(p) &&
    p.unlockBackingUsd <= p.creatorUnlockUsd &&
    // the Token Option: 1 ..= 8 releases, each in range > 0 and none past it, summing to 10,000; a clock (≤ 365 days, ≥ 1 s with > 1)
    allocReleasesOk(p) &&
    // the open keeps headroom for every admissible Team Slot rate, or the Milestones' largest total (`slotRoom`)
    BigInt(p.cushionBps[0] + p.polBps[0] + slotRoom(p) + OPEN_SLOT_MARGIN_BPS) <
      BPS &&
    curvesOk(p)
  );
}

/**
 * `preset::curves_ok`: a real span (`0 < from < to ≤ PRESET_MAX_USD`), each START under its END's cap, the at-floor buy
 * skim ≤ max(min(start, end far buy), 1 bp), the Team Milestone ≤ the row's Team Slot max, each Milestone and the three
 * together (`msTopBps`) ≤ `MILESTONES_MAX_BPS`.
 */
export function curvesOk(p: PresetSpec): boolean {
  const [sb, ss] = p.skimFarStartBps;
  const [cb, cs] = p.creatorStartBps;
  return (
    p.curveFromUsd > 0n &&
    p.curveFromUsd < p.curveToUsd &&
    p.curveToUsd <= PRESET_MAX_USD &&
    sb <= PRESET_MAX_SKIM_FAR_BPS &&
    ss <= PRESET_MAX_SKIM_FAR_BPS &&
    p.skimBuyAtFloorBps <=
      Math.max(Math.min(sb, p.skimBuyFarBps), PRESET_MIN_SKIM_BUY_FAR_BPS) &&
    cb <= PRESET_MAX_CREATOR_BPS &&
    cs <= PRESET_MAX_CREATOR_BPS &&
    p.platformStartBps <= PRESET_MAX_PLATFORM_BPS &&
    p.floorTokenStartBps <= PRESET_MAX_PLATFORM_BPS &&
    Math.max(p.teamMsBps[0], p.teamMsBps[1]) <= p.teamSlotMaxBps &&
    Math.max(p.platformMsBps[0], p.platformMsBps[1]) <= MILESTONES_MAX_BPS &&
    Math.max(p.floorMsBps[0], p.floorMsBps[1]) <= MILESTONES_MAX_BPS &&
    msTopBps(p) <= MILESTONES_MAX_BPS
  );
}

/**
 * `round_trip_loses`: no round trip can profit on the row under the backing line — a seller who is not the last pays the
 * whole sell take, and the last seller's gross is at most the pots. A 0-take row fails.
 */
export function roundTripLoses(p: PresetSpec): boolean {
  const b = BPS;
  // every curved leg at its least (linear between its two ends, so the least is at one of them)
  const out = BigInt(
    Math.min(p.platformBps, p.platformStartBps) +
      Math.min(p.floorTokenBps, p.floorTokenStartBps) +
      extraBps(p),
  );
  const far = Math.min(p.skimSellFarBps, p.skimFarStartBps[1]);
  const skimMin = BigInt(Math.min(far, p.skimSellAtFloorBps));
  const creator = BigInt(Math.min(p.creatorSellBps, p.creatorStartBps[1]));
  const tsMin = skimMin + creator + out;
  const ns = creator + out;
  return (
    tsMin < b &&
    ns < b &&
    b * (b - tsMin) < b * b &&
    (b - out) * (b - ns) < b * b
  );
}

// ---- the row's bytes (PRESET_LEN 486 since the curves; 430 and 409 before; field order, little-endian, no padding) -----------------------

/** The row before (409 B). */
export const PRESET_LEN_V2 =
  1 +
  16 * 4 +
  16 +
  2 +
  4 +
  2 +
  4 +
  4 +
  16 * 2 +
  2 +
  16 +
  4 * 18 +
  2 +
  2 * 8 +
  MAX_EXTRA_LEGS * 34 +
  2 +
  2 +
  16 +
  16;
/** The Token Option: + `allocReleaseCount` u8, `allocReleaseBps` 8 × u16, `allocReleaseSecs` u32. */
export const PRESET_LEN_V3 = PRESET_LEN_V2 + 1 + 2 * MAX_ALLOC_RELEASES + 4;
/**
 * The curves: + `curveFromUsd` u128 @430, `curveToUsd` u128 @446, `skimFarStartBps` @462 / @464, `creatorStartBps` @466 /
 * @468, `platformStartBps` @470, `floorTokenStartBps` @472, `teamMsBps` @474 / @476, `platformMsBps` @478 / @480,
 * `floorMsBps` @482 / @484 (all u16 but the two spans).
 */
export const PRESET_LEN = PRESET_LEN_V3 + 16 * 2 + 2 * 6 + 2 * 6;

function put(b: Uint8Array, o: number, v: bigint, n: number): number {
  const max = (1n << BigInt(8 * n)) - 1n;
  if (v < 0n || v > max)
    throw new RangeError(`a ${8 * n}-bit field out of range`);
  for (let i = 0; i < n; i++) b[o + i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return o + n;
}

function get(b: Uint8Array, o: number, n: number): bigint {
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

/** `PresetSpec::to_bytes`: what a Solana account stores and an event's preset hash is taken over. */
export function presetToBytes(p: PresetSpec): Uint8Array {
  const b = new Uint8Array(PRESET_LEN);
  let o = put(b, 0, BigInt(p.id), 1);
  for (const v of [
    p.raiseUsdCents,
    p.saleWhole,
    p.polWhole,
    p.heldWhole,
    p.windowWhole,
  ])
    o = put(b, o, v, 16);
  o = put(b, o, BigInt(p.creatorBuyMaxBps), 2);
  o = put(b, o, BigInt(p.snipeSlots), 4);
  o = put(b, o, BigInt(p.windowMaxPerTxBps), 2);
  for (const v of [p.cushionBps[0], p.cushionBps[1], p.polBps[0], p.polBps[1]])
    o = put(b, o, BigInt(v), 2);
  o = put(b, o, p.rampCpFromUsd, 16);
  o = put(b, o, p.fullAtUsd, 16);
  o = put(b, o, BigInt(p.floor0Bps), 2);
  o = put(b, o, p.rampFromUsd, 16);
  if (p.floorPointsUsd.length !== 4) throw new RangeError('four floor points');
  for (const [m, bps] of p.floorPointsUsd) {
    o = put(b, o, m, 16);
    o = put(b, o, BigInt(bps), 2);
  }
  for (const v of [
    p.cutBps,
    p.skimBuyFarBps,
    p.skimSellFarBps,
    p.skimBuyAtFloorBps,
    p.skimSellAtFloorBps,
    p.creatorBuyBps,
    p.creatorSellBps,
    p.platformBps,
    p.teamSlotMaxBps,
  ]) {
    o = put(b, o, BigInt(v), 2);
  }
  if (p.extraLegs.length !== MAX_EXTRA_LEGS)
    throw new RangeError('four extra legs');
  for (const l of p.extraLegs) {
    o = put(b, o, BigInt(l.bps), 2);
    if (l.dest.length !== 32)
      throw new RangeError("a leg's destination is 32 bytes");
    b.set(l.dest, o);
    o += 32;
  }
  o = put(b, o, BigInt(p.floorTokenBps), 2);
  o = put(b, o, BigInt(p.creatorAllocBps), 2);
  o = put(b, o, p.creatorUnlockUsd, 16);
  o = put(b, o, p.unlockBackingUsd, 16);
  // (APPENDED) the Token Option: count @409, 8 × u16 @410, u32 secs @426
  o = put(b, o, BigInt(p.allocReleaseCount), 1);
  for (const v of p.allocReleaseBps) o = put(b, o, BigInt(v), 2);
  o = put(b, o, BigInt(p.allocReleaseSecs), 4);
  // (APPENDED) the curves: every earlier offset stands
  o = put(b, o, p.curveFromUsd, 16);
  o = put(b, o, p.curveToUsd, 16);
  for (const v of [
    p.skimFarStartBps[0],
    p.skimFarStartBps[1],
    p.creatorStartBps[0],
    p.creatorStartBps[1],
    p.platformStartBps,
    p.floorTokenStartBps,
    p.teamMsBps[0],
    p.teamMsBps[1],
    p.platformMsBps[0],
    p.platformMsBps[1],
    p.floorMsBps[0],
    p.floorMsBps[1],
  ]) {
    o = put(b, o, BigInt(v), 2);
  }
  return b;
}

/**
 * `PresetSpec::from_bytes`: read back with NO check (run `specOk`). A row from before the curves (409 or 430 bytes) reads
 * its fees FLAT (each START = its END), no Milestones and a 0 span (`specOk` refuses it).
 */
export function presetFromBytes(b: Uint8Array): PresetSpec {
  if (
    b.length !== PRESET_LEN &&
    b.length !== PRESET_LEN_V3 &&
    b.length !== PRESET_LEN_V2
  )
    throw new RangeError(`a preset row is ${PRESET_LEN} bytes`);
  let o = 0;
  const n = (len: number): bigint => {
    const v = get(b, o, len);
    o += len;
    return v;
  };
  const u = (len: number): number => Number(n(len));
  const id = u(1);
  const [raiseUsdCents, saleWhole, polWhole, heldWhole, windowWhole] = [
    n(16),
    n(16),
    n(16),
    n(16),
    n(16),
  ];
  const creatorBuyMaxBps = u(2);
  const snipeSlots = u(4);
  const windowMaxPerTxBps = u(2);
  const cushionBps: [number, number] = [u(2), u(2)];
  const polBps: [number, number] = [u(2), u(2)];
  const rampCpFromUsd = n(16);
  const fullAtUsd = n(16);
  const floor0Bps = u(2);
  const rampFromUsd = n(16);
  const floorPointsUsd: [bigint, number][] = [];
  for (let i = 0; i < 4; i++) floorPointsUsd.push([n(16), u(2)]);
  const [
    cutBps,
    skimBuyFarBps,
    skimSellFarBps,
    skimBuyAtFloorBps,
    skimSellAtFloorBps,
  ] = [u(2), u(2), u(2), u(2), u(2)];
  const [creatorBuyBps, creatorSellBps, platformBps, teamSlotMaxBps] = [
    u(2),
    u(2),
    u(2),
    u(2),
  ];
  const extraLegs: ExtraLeg[] = [];
  for (let i = 0; i < MAX_EXTRA_LEGS; i++) {
    const bps = u(2);
    extraLegs.push({ bps, dest: b.slice(o, o + 32) });
    o += 32;
  }
  const floorTokenBps = u(2);
  const creatorAllocBps = u(2);
  const creatorUnlockUsd = n(16);
  const unlockBackingUsd = n(16);
  // the Token Option: a 409-byte row (before the releases) reads as ONE release of 10,000 bps, no clock
  const v3 = b.length >= PRESET_LEN_V3;
  const allocReleaseCount = v3 ? u(1) : 1;
  const allocReleaseBps: number[] = [];
  for (let i = 0; i < MAX_ALLOC_RELEASES; i++)
    allocReleaseBps.push(v3 ? u(2) : i === 0 ? 10_000 : 0);
  const allocReleaseSecs = v3 ? u(4) : 0;
  const v4 = b.length === PRESET_LEN;
  const pair = (a: number, z: number): [number, number] =>
    v4 ? [u(2), u(2)] : [a, z];
  const curveFromUsd = v4 ? n(16) : 0n;
  const curveToUsd = v4 ? n(16) : 0n;
  const skimFarStartBps = pair(skimBuyFarBps, skimSellFarBps);
  const creatorStartBps = pair(creatorBuyBps, creatorSellBps);
  const platformStartBps = v4 ? u(2) : platformBps;
  const floorTokenStartBps = v4 ? u(2) : floorTokenBps;
  const teamMsBps = pair(0, 0);
  const platformMsBps = pair(0, 0);
  const floorMsBps = pair(0, 0);
  return {
    id,
    raiseUsdCents,
    saleWhole,
    polWhole,
    heldWhole,
    windowWhole,
    creatorBuyMaxBps,
    snipeSlots,
    windowMaxPerTxBps,
    cushionBps,
    polBps,
    rampCpFromUsd,
    fullAtUsd,
    floor0Bps,
    rampFromUsd,
    floorPointsUsd,
    cutBps,
    skimBuyFarBps,
    skimSellFarBps,
    skimBuyAtFloorBps,
    skimSellAtFloorBps,
    creatorBuyBps,
    creatorSellBps,
    platformBps,
    teamSlotMaxBps,
    extraLegs,
    floorTokenBps,
    creatorAllocBps,
    creatorUnlockUsd,
    unlockBackingUsd,
    allocReleaseCount,
    allocReleaseBps,
    allocReleaseSecs,
    curveFromUsd,
    curveToUsd,
    skimFarStartBps,
    creatorStartBps,
    platformStartBps,
    floorTokenStartBps,
    teamMsBps,
    platformMsBps,
    floorMsBps,
  };
}

// ---- the declared quote price ------------------------------------------------------------------------------------------

/** `usd_to_quote`: `⌊cents · 10^decimals · 2^64 ÷ quote_usd_cents_x64⌋`. */
export function usdToQuote(
  usdCents: bigint,
  quoteUsdCentsX64: bigint,
  quoteDecimals: number,
): bigint {
  if (quoteUsdCentsX64 === 0n) fail('Zero');
  const v = (usdCents * 10n ** BigInt(quoteDecimals) * ONE) / quoteUsdCentsX64;
  if (v > U128_MAX) fail('Overflow');
  return v;
}

/** `preset_of`: a row's terms with every market cap in quote base units, and the raise rounded DOWN to a multiple of the sale. */
export function presetOf(
  p: PresetSpec,
  quoteUsdCentsX64: bigint,
  quoteDecimals: number,
): { terms: ScheduleTerms; raise: bigint } {
  const m = (usd: bigint): bigint =>
    usdToQuote(
      usd * 100n > U128_MAX ? fail('Overflow') : usd * 100n,
      quoteUsdCentsX64,
      quoteDecimals,
    );
  const raw = m(p.raiseUsdCents / 100n);
  const raise = raw - (raw % p.saleWhole);
  if (raise === 0n) fail('Zero');
  const terms: ScheduleTerms = {
    cushionBps: [p.cushionBps[0], p.cushionBps[1]],
    polBps: [p.polBps[0], p.polBps[1]],
    rampCpFrom: m(p.rampCpFromUsd),
    fullAt: m(p.fullAtUsd),
    floor0Bps: p.floor0Bps,
    rampFrom: m(p.rampFromUsd),
    floorPoints: p.floorPointsUsd.map(([usd, bps]) => ({
      mcap: m(usd),
      bps,
    })) as unknown as ScheduleTerms['floorPoints'],
    cutBps: p.cutBps,
  };
  return { terms, raise };
}

/** `preset`: the seed row `id` (`UnknownPreset` for any other). */
export function preset(
  id: number,
  quoteUsdCentsX64: bigint,
  quoteDecimals: number,
): { terms: ScheduleTerms; raise: bigint } {
  const p = presetSpec(id);
  if (p === null) fail('UnknownPreset');
  return presetOf(p, quoteUsdCentsX64, quoteDecimals);
}

export function unit(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}
export const saleTokens = (p: PresetSpec, decimals: number): bigint =>
  p.saleWhole * unit(decimals);
export const windowTokens = (p: PresetSpec, decimals: number): bigint =>
  p.windowWhole * unit(decimals);
/** `⌊window · creator_buy_max_bps ÷ 10⁴⌋`. */
export const creatorBuyMaxTokens = (p: PresetSpec, decimals: number): bigint =>
  (windowTokens(p, decimals) * BigInt(p.creatorBuyMaxBps)) / BPS;

/** `p₀ = ⌈raise · 2^64 ÷ sale tokens⌉`. */
export function openPriceX64(raise: bigint, saleTokensBase: bigint): bigint {
  if (saleTokensBase === 0n) fail('Zero');
  const n = raise << 64n;
  const v = n / saleTokensBase + (n % saleTokensBase !== 0n ? 1n : 0n);
  if (v > U128_MAX) fail('Overflow');
  return v;
}

/**
 * A launch's schedule and opening books (`Schedule::new` at `open_mcap(raise, sale, 0)`, `open_sale_for`), and `p₀`. The
 * books open with the headroom `slotRoom(p)`, as `Launch` opens them; `slotMaxBps` overrides it.
 */
export function launchSchedule(
  p: PresetSpec,
  quoteUsdCentsX64: bigint,
  quoteDecimals: number,
  tokenDecimals: number,
  slotMaxBps: number = slotRoom(p),
): {
  terms: ScheduleTerms;
  raise: bigint;
  schedule: Schedule;
  open: State;
  p0X64: bigint;
} {
  const { terms, raise } = presetOf(p, quoteUsdCentsX64, quoteDecimals);
  const sale = saleTokens(p, tokenDecimals);
  const schedule = Schedule.create(terms, openMcap(raise, sale, 0n));
  return {
    terms,
    raise,
    schedule,
    open: openSaleFor(
      schedule,
      raise,
      sale,
      p.polWhole * unit(tokenDecimals),
      slotMaxBps,
    ),
    p0X64: openPriceX64(raise, sale),
  };
}

// ---- the Team Slot -----------------------------------------------------------------------------------

// The Team Slot is free: no price is charged for a rate.

/** may a launch of row `p` choose this rate? */
export function teamSlotRateOk(p: PresetSpec, rateBps: number): boolean {
  return rateBps <= p.teamSlotMaxBps && rateBps <= TEAM_SLOT_HARD_MAX_BPS;
}

/** ⛔ `slot_cut_q`: `rate_bps · bought_ppm` as a Q64.64 share of every schedule payment, rounded down. */
export function slotCutQ(rateBps: number, boughtPpm: number): bigint {
  const ppm = BigInt(Math.min(boughtPpm, 1_000_000));
  return (BigInt(rateBps) * ppm * ONE) / (BPS * 1_000_000n);
}

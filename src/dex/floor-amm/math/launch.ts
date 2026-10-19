// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math `launch.rs` bit for bit: THE REFERENCE TRADE — one launch's
// whole market state and `create` / `buy` / `sell` / `burn`, composed from `trade`, `fees`, `bid`, `schedule` and `supply` in
// the order (the take on the spent leg; graduation at the window's sell-out; the end's inventory to the tail;
// the creator's locked buy OUTSIDE). Held to `golden/launch.json`'s 18 walks receipt for receipt and state for state
// (`test/launch.test.ts`). The quoter (`src/quote.ts`) runs these on a copy.
// The cushion's top is 1.00 × `price · u′` (the cut-adjusted keep) and comes down to it at the start of every buy before the
// end (`capTop`); once a buy sells from the lot every later credit in it is capped at the lot's top. At the schedule's end
// the tail opens as ONE range from the frozen price to an infinite price (`tail.ts`): a buy after the end takes the lot
// while its ask is under the range's price, then the range; a sell after the end goes to the range first.

import {
  bidTopX64,
  capTop,
  credit,
  curveLive,
  floorX64,
  priceOfSqrt,
  sell as bidSell,
  sqrtX64,
  BidMathError,
} from './bid';
import type { Pots } from './bid';
import { FloorMathError, fail, log2X64 } from './index';
import {
  CURVE_ONE,
  PPM,
  buyRatesDiffer,
  cheaperBuy,
  creatorLegs,
  legForNet,
  milestonesOf,
  ratesAtCapped,
  ratesOf,
  splitCreator,
  splitMembers,
  splitMilestones,
  take,
} from './fees';
import type { Rates, Take } from './fees';
import {
  MILESTONES_LIVE_MAX_BPS,
  creatorAllocWhole,
  creatorBuyMaxTokens,
  openPriceX64,
  presetOf,
  saleTokens,
  slotCutQ,
  slotRoom,
  specOk,
  tailWhole,
  totalWhole,
  unit,
  usdToQuote,
  windowTokens,
} from './preset';
import type { PresetSpec } from './preset';
import {
  Schedule,
  cpTargets,
  openMcap,
  openSaleFor,
  priceX64,
  raiseToBacking,
} from './schedule';
import type { ScheduleTerms, State } from './schedule';
import { sOut as supplySOut, sweepIfEmpty, syncSupply } from './supply';
import {
  allocNextReleaseAt,
  allocReleasedAfter,
  splitRelease,
  backingLineX64,
  fillKeeperless,
  flatCreditTop,
  flatFill,
  lotAskX64,
  lotBackingLineX64,
  lotCreditTopX64,
  snipeCap,
  windowPriceX64,
  windowRoom,
} from './trade';
import {
  noTailSell,
  tailBuy,
  tailOpen,
  tailOwed,
  tailPriceX64,
  tailSell,
} from './tail';
import type { TailBuy } from './tail';
import {
  LOT_BINS,
  cloneLot,
  emptyLot,
  lotAddSell,
  lotBinsInUse,
  lotTake,
} from './lot';
import type { Lot } from './lot';

const U128_MAX = (1n << 128n) - 1n;
const u128 = (v: bigint): bigint => (v > U128_MAX ? fail('Overflow') : v);

/** `v`, or `null` where the reference's `.ok()` is `None` (an `Overflow` refusal). */
function ok(f: () => bigint): bigint | null {
  try {
    return f();
  } catch (e) {
    if (e instanceof FloorMathError && e.code === 'Overflow') return null;
    throw e;
  }
}
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** A launch's whole market state (both chains hold these values; the layout is theirs). */
export interface Launch {
  /** The preset row, copied at create. */
  spec: PresetSpec;
  rates: Rates;
  /** The schedule's terms in quote base units. */
  terms: ScheduleTerms;
  sch: Schedule;
  /** The books; frozen once `ended`. */
  st: State;
  /** The window's flat price `p₀`. */
  p0X64: bigint;
  pots: Pots;
  /** The supply as last synced (only falls: burns). */
  supply: bigint;
  windowLeft: bigint;
  /** The schedule's inventory (the window and the tail apart). */
  inventory: bigint;
  lotTokens: bigint;
  lotCost: bigint;
  tail: bigint;
  /** The creator's FREE allocation, held and LOCKED until `creatorUnlockMcap`; 0 once claimed. */
  creatorAlloc: bigint;
  /** The market cap that unlocks it, quote base units (the row's unlock at the declared quote price). */
  creatorUnlockMcap: bigint;
  /** The pots' money (`F + C`) the unlock also needs, quote base units. */
  creatorUnlockBacking: bigint;
  /** (APPENDED) the Token Option: releases done, and when the next is due (unix s; 0 before the first and once all are done). */
  allocReleasesDone: number;
  allocNextReleaseAt: bigint;
  /** The schedule is done; the books' price is frozen. */
  ended: boolean;
  /** the window is sold out. */
  graduated: boolean;
  /** The Team Slot's rate and bought fraction (0 / 0 without a slot). */
  slotRateBps: number;
  slotBoughtPpm: number;
  /** the slot members' weights (`weights`, parts per billion of what is bought). */
  slotWeights: number[];
  /** which of the creator's referrer tiers exist (fixed at create). */
  creatorRefs: boolean[];
  createdSlot: bigint;
  /** The decimals the math runs at (`mathDecimals`): the token's, or the quote's when an 18-dp token trades on a 6-dp quote. */
  tokenDecimals: number;
  /** H1-SCHED: chain base units per math unit (`10^(token decimals − tokenDecimals)`; 1 when they agree). */
  tokenScale: bigint;
  /**
   * The tail range opened at the schedule's end (`tailOpen`): its liquidity `L` (0 before the end), its `√p · 2^64` now and
   * at the frozen price, and the quote it holds (in the launch's vault beside `F` and `C`). Its tokens are `tail`.
   */
  tailLiq: bigint;
  tailSqrtX64: bigint;
  tailSqrtEndX64: bigint;
  tailMoney: bigint;
  /**
   * (APPENDED) the curves: `log2` of the curves' START and END FDV in quote base units, Q64.64 (the row's `curveFromUsd` /
   * `curveToUsd` at the declared quote price, fixed at create: `curveLogs`). `curveT` reads the trade's place between them.
   */
  curveL: readonly [bigint, bigint];
  /**
   * (APPENDED) this launch's live bound on the three Milestones together, bps: `MILESTONES_LIVE_MAX_BPS` at create (the
   * genesis launch's raise-priced open sets its own). Fixed for life; every rate read caps at it (`launchRatesAt`).
   */
  msLiveMaxBps: number;
  /**
   * (APPENDED) the bought-back lot's bins (`lot.ts`): what each bought-back token cost, resold the cheapest first.
   * `lotTokens` / `lotCost` stay the bins' totals.
   */
  lot: Lot;
}

/** H1-SCHED: the math runs at `min(token, max(6, quote))` decimals, so an 18-dp token on a 6-dp quote prices whole micro-units. */
export function mathDecimals(
  tokenDecimals: number,
  quoteDecimals: number,
): number {
  return Math.min(tokenDecimals, Math.max(6, quoteDecimals));
}

const scaleOf = (l: Launch): bigint => (l.tokenScale > 1n ? l.tokenScale : 1n);

/** Math units to chain units. */
export function chainUnits(l: Launch, math: bigint): bigint {
  return u128(math * scaleOf(l));
}

/** What one buy did. */
export interface BuyReceipt {
  leg: bigint;
  /** The SPENT leg (`leg − refund`) and the take on it. */
  spent: bigint;
  refund: bigint;
  take: Take;
  /** Swept to the platform bucket by the supply's sync before the trade (nothing was outside). */
  swept: bigint;
  out: bigint;
  windowOut: bigint;
  windowPay: bigint;
  scheduleOut: bigint;
  schedulePay: bigint;
  /** The bought-back lot's tokens, sold first at its own ask (not a part of `scheduleOut`); paid `lotPay`. */
  lotOut: bigint;
  flatLotOut: bigint;
  flatTailOut: bigint;
  flatPay: bigint;
  /**
   * What left the fills for the platform bucket (the books' rounding) and the Team Marketcap Milestone (the Team Slot's;
   * with no slot, the creator's — `routing.toCreator`).
   */
  fillCut: bigint;
  fillSlot: bigint;
  /** The legs' rounding over what was spent, kept in `F`. */
  dust: bigint;
  /** The creator fee's and the Team Slot's routing (`creatorBacking` and `slotDust` credited to `F` with the skim). */
  routing: Routing;
  graduatedNow: boolean;
  /** The books' price where the curve takes over (`trade::graduates`); 0 unless `graduatedNow`. */
  graduationPriceX64: bigint;
  endedNow: boolean;
  /** The quote the lot's tokens (`lotOut`) took. */
  lotPay: bigint;
  /** What the tail range took (part of `flatPay`), and of what it kept the part to `F` (the rest is the range's money). */
  tailPay: bigint;
  tailToFloor: bigint;
  /**
   * (APPENDED) the Platform Marketcap Milestone (→ the platform bucket) and the `$FLOOR` Marketcap Milestone (→ the
   * `$FLOOR` launch's `F`), out of the window's and the schedule's fills.
   */
  msPlatform: bigint;
  msFloor: bigint;
}

/**
 * ⛔ Where a trade's creator fee and Team Slot take go (`launch::Routing`): the creator's referrers (900 / 90 / 10 bps of
 * it), then with a Team Slot the slot's bought share and the rest stays in `F` as backing; with no slot the rest is the
 * creator's. The slot's take (`fillSlot` + the creator fee's share) is split among the members now; the dust stays in `F`.
 */
export interface Routing {
  creatorRefs: bigint[];
  toCreator: bigint;
  creatorToSlot: bigint;
  /** → `F`. */
  creatorBacking: bigint;
  slotMembers: bigint[];
  /** → `F`. */
  slotDust: bigint;
}

/** What one sell did. */
export interface SellReceipt {
  tokens: bigint;
  gross: bigint;
  fromCushion: bigint;
  fromFloor: bigint;
  take: Take;
  /** What the seller receives: `gross − take.total`. */
  payout: bigint;
  /** Swept before the sell (a burn) and after it. */
  swept: bigint;
  routing: Routing;
  /** H-3: the seller's own share of the kept skim, to the platform bucket. */
  keptToPlatform: bigint;
  /** The tokens the tail range took back first (chain units, as `tokens`) and their pay from `F` and from the range's money (in `gross`). */
  tailTokens: bigint;
  tailFromFloor: bigint;
  tailFromMoney: bigint;
}

const ZERO_TAKE: Take = {
  skimBps: 0,
  skim: 0n,
  cut: 0n,
  kept: 0n,
  creator: 0n,
  platform: 0n,
  extra: [0n, 0n, 0n, 0n],
  floorToken: 0n,
  total: 0n,
};

function zeroRouting(): Routing {
  return {
    creatorRefs: [0n, 0n, 0n],
    toCreator: 0n,
    creatorToSlot: 0n,
    creatorBacking: 0n,
    slotMembers: [0n, 0n, 0n, 0n, 0n],
    slotDust: 0n,
  };
}

function emptyBuy(leg: bigint): BuyReceipt {
  return {
    leg,
    spent: 0n,
    refund: 0n,
    take: { ...ZERO_TAKE, extra: [...ZERO_TAKE.extra] },
    swept: 0n,
    out: 0n,
    windowOut: 0n,
    windowPay: 0n,
    scheduleOut: 0n,
    schedulePay: 0n,
    lotOut: 0n,
    flatLotOut: 0n,
    flatTailOut: 0n,
    flatPay: 0n,
    fillCut: 0n,
    fillSlot: 0n,
    dust: 0n,
    routing: zeroRouting(),
    graduatedNow: false,
    graduationPriceX64: 0n,
    endedNow: false,
    lotPay: 0n,
    tailPay: 0n,
    tailToFloor: 0n,
    msPlatform: 0n,
    msFloor: 0n,
  };
}

/** A deep copy (the quoter runs a trade on one). */
export function cloneLaunch(l: Launch): Launch {
  return {
    ...l,
    st: { ...l.st },
    pots: { ...l.pots },
    slotWeights: [...l.slotWeights],
    creatorRefs: [...l.creatorRefs],
    lot: cloneLot(l.lot),
  };
}

/** Every token the program holds: the window, the inventory, the lot, the tail and the creator's LOCKED free allocation
 * (the creator's locked BUY is outside). */
export function held(l: Launch): bigint {
  return l.windowLeft + l.inventory + l.lotTokens + l.tail + l.creatorAlloc;
}

/**
 * `trade::creator_alloc_unlocked`: the market cap `⌊price · supply ÷ 2^64⌋` has reached `unlockMcap` AND the pots' money
 * `band` (`F + C`) has reached `unlockBacking`.
 */
export function creatorAllocUnlocked(
  priceX64v: bigint,
  supply: bigint,
  unlockMcap: bigint,
  band: bigint,
  unlockBacking: bigint,
): boolean {
  return (priceX64v * supply) >> 64n >= unlockMcap && band >= unlockBacking;
}

/** The Token Option: what one Token Option release did (floor-math `AllocRelease`; MATH units). */
export interface AllocRelease {
  releaseIndex: number;
  tokens: bigint;
  /** The release split pro rata by the Team Slot's weights at it, by place (Σ = `tokens`). */
  members: bigint[];
  released: bigint;
  nextReleaseAt: bigint;
}

/** `Launch::token_option_state(now)`: the Token Option in one read (MATH units); moves nothing. */
export interface TokenOptionState {
  total: bigint;
  released: bigint;
  releasesDone: number;
  releaseCount: number;
  nextReleaseIndex: number;
  nextReleaseAt: bigint;
  nextReleaseTokens: bigint;
  linesMet: boolean;
  due: boolean;
}

/** `Launch::alloc_total`: the whole allocation at create (math units). */
export function allocTotal(l: Launch): bigint {
  return creatorAllocWhole(l.spec) * unit(l.tokenDecimals);
}

function allocLinesMet(l: Launch): boolean {
  return creatorAllocUnlocked(
    launchLiveBuyPriceX64(l),
    l.supply,
    l.creatorUnlockMcap,
    l.pots.floor + l.pots.cushion,
    l.creatorUnlockBacking,
  );
}

/** `Launch::alloc_release_due(now)`: throws `NotDue` on the clock, then `Locked` on the lines (EVERY release re-checks). */
export function allocReleaseDue(l: Launch, now: bigint): void {
  if (l.creatorAlloc === 0n) return;
  if (l.allocReleasesDone > 0 && now < l.allocNextReleaseAt) fail('NotDue');
  if (!allocLinesMet(l)) fail('Locked');
}

function releasedThrough(
  l: Launch,
  total: bigint,
  k: number,
  count: number,
): bigint {
  return k + 1 >= count
    ? total
    : allocReleasedAfter(total, l.spec.allocReleaseBps, k + 1);
}

/** `Launch::token_option_state(now)`. */
export function tokenOptionState(l: Launch, now: bigint): TokenOptionState {
  const total = allocTotal(l);
  const count = Math.max(l.spec.allocReleaseCount, 1);
  const k = l.allocReleasesDone;
  const s: TokenOptionState = {
    total,
    released: total - l.creatorAlloc,
    releasesDone: k,
    releaseCount: count,
    nextReleaseIndex: 0,
    nextReleaseAt: 0n,
    nextReleaseTokens: 0n,
    linesMet: allocLinesMet(l),
    due: false,
  };
  if (l.creatorAlloc > 0n) {
    const to = releasedThrough(l, total, k, count);
    s.nextReleaseIndex = k;
    s.nextReleaseAt = l.allocNextReleaseAt;
    s.nextReleaseTokens = min(
      to > s.released ? to - s.released : 0n,
      l.creatorAlloc,
    );
    try {
      allocReleaseDue(l, now);
      s.due = true;
    } catch (e) {
      if (!(e instanceof FloorMathError)) throw e;
    }
  }
  return s;
}

/**
 * THE TOKEN OPTION: `Launch::unlock_creator_alloc(now)`: ONE release a call, `NotDue` before its clock, then
 * `Locked` until the market cap and the backing lines are met (every release re-checks both); the release's tokens join
 * `S_out` and are split pro rata by the Team Slot's weights now. `now` is unix seconds (EVM `block.timestamp`).
 */
export function unlockCreatorAlloc(l: Launch, now: bigint): AllocRelease {
  const total = allocTotal(l);
  if (l.creatorAlloc === 0n)
    return {
      releaseIndex: l.allocReleasesDone,
      tokens: 0n,
      members: [0n, 0n, 0n, 0n, 0n],
      released: total,
      nextReleaseAt: 0n,
    };
  allocReleaseDue(l, now);
  const k = l.allocReleasesDone;
  const count = Math.max(l.spec.allocReleaseCount, 1);
  const released = releasedThrough(l, total, k, count);
  const before = total - l.creatorAlloc;
  if (released < before) fail('Overflow');
  const n = min(released - before, l.creatorAlloc);
  const members = splitRelease(n, l.slotWeights);
  l.creatorAlloc -= n;
  l.allocReleasesDone = k + 1;
  l.allocNextReleaseAt =
    l.creatorAlloc === 0n
      ? 0n
      : allocNextReleaseAt(k + 1, count, now, l.spec.allocReleaseSecs) ?? 0n;
  return {
    releaseIndex: k,
    tokens: n,
    members,
    released: total - l.creatorAlloc,
    nextReleaseAt: l.allocNextReleaseAt,
  };
}

/** `S_out` at the stored supply. */
export function launchSOut(l: Launch): bigint {
  return supplySOut(l.supply, held(l));
}

/**
 * `Launch::live_buy_price_x64`: the price a buyer pays for the next token now — the next token's own price (after the end
 * the range's ask, `launchTailAskX64`; in the window the window's quote-free ask; else the books') or the lot's cheapest
 * bin's ask, the lower.
 */
export function launchLiveBuyPriceX64(l: Launch): bigint {
  const next = l.ended
    ? launchTailAskX64(l)
    : l.windowLeft > 0n
    ? launchWindowAskX64(
        l,
        launchFloorX64(l),
        launchSOut(l),
        ZERO_TAKE,
        1n,
        slotSchedule(l).u,
      )
    : priceX64(l.st);
  const a = launchLotAskX64(l);
  return a !== null && a < next ? a : next;
}

/**
 * `Launch::window_ask_x64`: the window's ask for a buy (`take0` on `leg`) — `p₀` raised to the floor's line while the bid's
 * line `backingLineX64` stays under it (the window flat in normal flow); once it binds, the lot's line `lotBackingLineX64`
 * (it does not fall as the window sells).
 */
export function launchWindowAskX64(
  l: Launch,
  f: bigint,
  sOut: bigint,
  take0: Take,
  leg: bigint,
  u2: bigint,
): bigint {
  const wp = windowPriceX64(l.p0X64, f, u2);
  const fc = l.pots.floor + l.pots.cushion;
  const band = fc > U128_MAX ? U128_MAX : fc;
  if (backingLineX64(band, sOut, take0.total, leg, u2) > wp)
    return max(
      wp,
      lotBackingLineX64(band, sOut, take0.total, take0.kept, leg, u2),
    );
  return wp;
}

/** `Launch::lot_ask_x64`: the lot's quote-free ask now, its cheapest bin's that asks (`null`: none). */
export function launchLotAskX64(l: Launch): bigint | null {
  const sOut = launchSOut(l);
  for (const b of lotBinsInUse(l.lot)) {
    const a = lotAskX64(
      l.pots,
      sOut,
      b.cost,
      b.tokens,
      l.sch.u,
      0n,
      0n,
      1n,
      launchRangeBidX64(l),
    );
    if (a !== null) return a;
  }
  return null;
}

/** `Launch::cheapest_bin`: the first bin that asks for this buy (`tk` on `leg`): `[bin, ask]`, null with none. */
function cheapestBin(
  l: Launch,
  sOut: bigint,
  u: bigint,
  tk: Take,
  leg: bigint,
): [number, bigint] | null {
  const range = launchRangeBidX64(l);
  for (let i = 0; i < l.lot.len; i++) {
    const b = l.lot.bins[i];
    const a = lotAskX64(
      l.pots,
      sOut,
      b.cost,
      b.tokens,
      u,
      tk.total,
      tk.kept,
      leg,
      range,
    );
    if (a !== null) return [i, a];
  }
  return null;
}

/** `Launch::range_bid_x64`: the range's price while it stands above its frozen price, else 0 (a lower bound of every bin's ask). */
export function launchRangeBidX64(l: Launch): bigint {
  return l.ended && l.tailSqrtX64 > l.tailSqrtEndX64
    ? launchTailPriceX64(l)
    : 0n;
}

/** `Launch::tail_price_x64`: the tail range's price now, Q64.64 (0 before the end). */
export function launchTailPriceX64(l: Launch): bigint {
  return l.ended ? tailPriceX64(l.tailSqrtX64) : 0n;
}

/**
 * `Launch::tail_ask_x64`: what the range's next token costs a buyer before the fees on top — `max(⌈price · 2^64 ÷ u′⌉,
 * ⌈f · 2^64 ÷ u′⌉, backingLineX64(F + C, S_out, 0, 1, u′))`; 0 before the end.
 */
export function launchTailAskX64(l: Launch): bigint {
  if (!l.ended) return 0n;
  const u = slotSchedule(l).u;
  const um = u > 1n ? u : 1n;
  const ceilSat = (x: bigint): bigint => {
    const v = ((x << 64n) + um - 1n) / um;
    return v > U128_MAX ? U128_MAX : v;
  };
  const f = launchFloorX64(l);
  const fLine = f === 0n ? 0n : ceilSat(f);
  const band = l.pots.floor + l.pots.cushion;
  const line = backingLineX64(
    band > U128_MAX ? U128_MAX : band,
    launchSOut(l),
    0n,
    1n,
    u,
  );
  return max(max(ceilSat(launchTailPriceX64(l)), fLine), line);
}

/** `Launch::tail_owed`: what the tail range's curve owes a seller down to the frozen price. */
export function launchTailOwed(l: Launch): bigint {
  return tailOwed(l.tailLiq, l.tailSqrtX64, l.tailSqrtEndX64);
}

/** The published floor `F ÷ S_out`. */
export function launchFloorX64(l: Launch): bigint {
  return floorX64(l.pots.floor, launchSOut(l));
}

/**
 * `Launch::slot_schedule`: the schedule with the three Marketcap Milestones at the launch's FDV now
 * (`u′ = u − team − platform − $FLOOR`), what window and schedule money is kept at.
 */
export function slotSchedule(l: Launch): Schedule {
  return msSchedule(l, milestonesOf(ratesNow(l)));
}

function msSchedule(
  l: Launch,
  ms: readonly [number, number, number],
): Schedule {
  return l.sch.withSlotCut(slotCutQ(ms[0] + ms[1] + ms[2], Number(PPM)));
}

/**
 * `launch::curve_logs`: `log2` of the row's curve span in quote base units (Q64.64) at the declared quote price — `Zero`
 * if either end is under one base unit, `PresetInvalid` unless the END's is above the START's.
 */
export function curveLogs(
  spec: PresetSpec,
  quoteUsdCentsX64: bigint,
  quoteDecimals: number,
): [bigint, bigint] {
  const q = (usd: bigint): bigint => {
    const c = usd * 100n;
    if (c > U128_MAX) fail('Overflow');
    return (
      log2X64(usdToQuote(c, quoteUsdCentsX64, quoteDecimals)) ?? fail('Zero')
    );
  };
  const a = q(spec.curveFromUsd);
  const b = q(spec.curveToUsd);
  if (b <= a) fail('PresetInvalid');
  return [a, b];
}

/**
 * `Launch::curve_t_at`: where the launch sits on its curves at the books' price `priceX64`, ppb of `CURVE_ONE` — the FDV
 * `⌊priceX64 · supply ÷ 2⁶⁴⌋` (the stored live supply; saturating), `log2` of it against `curveL`: 0 at or under the
 * START, `CURVE_ONE` at or past the END, `⌊(log2 FDV − l₀) · 10⁹ ÷ (l₁ − l₀)⌋` between.
 */
export function curveTAt(l: Launch, priceX64: bigint): bigint {
  let fdv = (priceX64 * l.supply) >> 64n;
  if (fdv > U128_MAX) fdv = U128_MAX;
  const lg = log2X64(fdv);
  if (lg === null) return 0n;
  const [a, b] = l.curveL;
  if (lg <= a || b <= a) return 0n;
  if (lg >= b) return CURVE_ONE;
  return ((lg - a) * CURVE_ONE) / (b - a);
}

/** `Launch::curve_t`: `curveTAt` at the books' price; after the schedule's end at the tail range's price. */
export function curveT(l: Launch): bigint {
  return curveTAt(l, l.ended ? launchTailPriceX64(l) : priceX64(l.st));
}

/** `Launch::rates_now`: the launch's rates for a trade now (`launchRatesAt` at `curveT`). */
export function ratesNow(l: Launch): Rates {
  return launchRatesAt(l, curveT(l));
}

/** `Launch::rates_at`: the rates at curve position `t`, the Milestones capped at this launch's bound (`msLiveMaxBps`). */
export function launchRatesAt(l: Launch, t: bigint): Rates {
  return ratesAtCapped(l.rates, t, l.msLiveMaxBps);
}

function sync(l: Launch, liveSupply: bigint): bigint {
  l.supply = syncSupply(l.supply, liveSupply);
  return sweep(l, launchSOut(l));
}

/** `Launch::sweep`: with nothing outside, `F + C` and the tail range's money go to the platform bucket. */
function sweep(l: Launch, sOut: bigint): bigint {
  const [p, swept0] = sweepIfEmpty(l.pots, sOut);
  let swept = swept0;
  l.pots = p;
  if (sOut === 0n && l.tailMoney > 0n) {
    swept = u128(swept + l.tailMoney);
    l.tailMoney = 0n;
  }
  return swept;
}

function room(l: Launch, st: State): bigint {
  const [c, p] = cpTargets(l.sch, l.terms, st);
  return c + p > l.pots.cushion ? c + p - l.pots.cushion : 0n;
}

/**
 * ⛔ `Launch::create`: the row checked (`PresetInvalid`), the books opened on the sale, the supply split into the window, the
 * schedule's inventory and the tail; then the creator's atomic buy of `creatorQuote` (at most `creator_buy_max_bps`
 * of the window, no snipe cap, its tokens locked — and outside).
 */
/** the reference: the creator's referrer tiers are an INPUT, set before the creator's atomic buy (so it pays them). */
export function createLaunch(
  spec: PresetSpec,
  quoteUsdCentsX64: bigint,
  quoteDecimals: number,
  tokenDecimals: number,
  createdSlot: bigint,
  creatorRefs: readonly boolean[],
  creatorQuote: bigint,
): [Launch, BuyReceipt | null] {
  if (!specOk(spec)) fail('PresetInvalid');
  const { terms, raise } = presetOf(spec, quoteUsdCentsX64, quoteDecimals);
  const chainDecimals = tokenDecimals;
  tokenDecimals = mathDecimals(chainDecimals, quoteDecimals);
  const tokenScale = unit(chainDecimals - tokenDecimals);
  const tok = unit(tokenDecimals);
  const sale = saleTokens(spec, tokenDecimals);
  const sch = Schedule.create(terms, openMcap(raise, sale, 0n));
  const st = openSaleFor(sch, raise, sale, spec.polWhole * tok, slotRoom(spec));
  const supply = totalWhole(spec) * tok;
  const window = windowTokens(spec, tokenDecimals);
  const tail = tailWhole(spec) * tok;
  const alloc = creatorAllocWhole(spec) * tok;
  const creatorUnlockMcap = usdToQuote(
    spec.creatorUnlockUsd * 100n,
    quoteUsdCentsX64,
    quoteDecimals,
  );
  const creatorUnlockBacking = usdToQuote(
    spec.unlockBackingUsd * 100n,
    quoteUsdCentsX64,
    quoteDecimals,
  );
  // the curves' span, fixed at create
  const curveL = curveLogs(spec, quoteUsdCentsX64, quoteDecimals);
  const l: Launch = {
    spec,
    rates: ratesOf(spec),
    terms,
    sch,
    st,
    p0X64: openPriceX64(raise, sale),
    pots: { floor: 0n, cushion: 0n, bidSqrtX64: 0n, liq: 0n },
    supply,
    windowLeft: window,
    inventory: supply - window - tail - alloc,
    lotTokens: 0n,
    lotCost: 0n,
    tail,
    creatorAlloc: alloc,
    creatorUnlockMcap,
    creatorUnlockBacking,
    allocReleasesDone: 0,
    allocNextReleaseAt: 0n,
    ended: false,
    graduated: window === 0n,
    slotRateBps: 0,
    slotBoughtPpm: 0,
    slotWeights: [0, 0, 0, 0, 0],
    creatorRefs: [
      creatorRefs[0] ?? false,
      creatorRefs[1] ?? false,
      creatorRefs[2] ?? false,
    ],
    createdSlot,
    tokenDecimals,
    tokenScale,
    tailLiq: 0n,
    tailSqrtX64: 0n,
    tailSqrtEndX64: 0n,
    tailMoney: 0n,
    curveL,
    msLiveMaxBps: MILESTONES_LIVE_MAX_BPS,
    lot: emptyLot(),
  };
  const r =
    creatorQuote > 0n
      ? buyCapped(
          l,
          creatorQuote,
          chainUnits(l, supply),
          creatorBuyMaxTokens(spec, tokenDecimals),
        )
      : null;
  return [l, r];
}

/** ⛔ `Launch::buy` (in place): a BUY of `leg` at slot / block `nowSlot` with the mint's `liveSupply`. Refuses nothing: what no stage takes is refunded. */
export function launchBuy(
  l: Launch,
  leg: bigint,
  nowSlot: bigint,
  liveSupply: bigint,
): BuyReceipt {
  const cap = snipeCap(
    l.spec,
    l.tokenDecimals,
    nowSlot > l.createdSlot ? nowSlot - l.createdSlot : 0n,
  );
  return buyCapped(l, leg, liveSupply, cap);
}

/** `Launch::buy_capped`: chain units in and out, the math in math units (H1-SCHED). */
export function buyCapped(
  l: Launch,
  leg: bigint,
  liveSupply: bigint,
  cap: bigint | null,
): BuyReceipt {
  const k = scaleOf(l);
  const r = buyMath(l, leg, liveSupply / k, cap);
  if (k > 1n) {
    r.out = u128(r.out * k);
    r.windowOut = u128(r.windowOut * k);
    r.scheduleOut = u128(r.scheduleOut * k);
    r.lotOut = u128(r.lotOut * k);
    r.flatLotOut = u128(r.flatLotOut * k);
    r.flatTailOut = u128(r.flatTailOut * k);
  }
  return r;
}

function buyMath(
  l: Launch,
  leg: bigint,
  liveSupply: bigint,
  cap: bigint | null,
): BuyReceipt {
  const r = emptyBuy(leg);
  r.swept = sync(l, liveSupply);
  // `(F + C) ÷ S_out` past u128: no token is priceable, the buy is refunded whole
  if (
    ok(() => floorX64(l.pots.floor + l.pots.cushion, launchSOut(l))) === null
  ) {
    r.refund = leg;
    return r;
  }
  // 1. the take on the whole leg, at the books' price and `f` BEFORE the trade; nothing is credited yet
  const price0 = priceX64(l.st);
  const f0 = launchFloorX64(l);
  // one trade, one place on the curves: the fees and the Milestones at the FDV BEFORE the trade
  const rates = ratesNow(l);
  const ms = milestonesOf(rates);
  const take0 = take(rates, leg, true, price0, f0);
  const s: Stages = {
    rem: leg - take0.total,
    budget: cap ?? U128_MAX,
    sOut: launchSOut(l),
    lotTop: null,
    cpTotal: null,
    ch: { base: rates, rates, take: take0, leg, price0, f0 },
  };
  const slot = msSchedule(l, ms);
  const u = l.sch.u;
  // the bid's top (`price · u′`, 1.00 ×) at what the schedule keeps (`u′`: the three Marketcap Milestones at this trade's
  // FDV paid out), the stored top capped to it at the start of every buy before the end
  const uTop = slot.u;
  if (!l.ended)
    l.pots = capTop(l.pots, s.sOut, bidTopX64(priceX64(l.st), uTop));
  const windowWas = l.windowLeft;
  // 2. the window, flat at its ask: the lot's bins whose ask is under the window's sell first (the cheapest first)
  if (l.windowLeft > 0n && s.rem > 0n && s.budget > 0n) {
    const ask = launchWindowAskX64(
      l,
      floorX64(l.pots.floor, s.sOut),
      s.sOut,
      take0,
      leg,
      slot.u,
    );
    if (l.lotTokens > 0n) lotWalk(l, ask, null, s, take0, leg, u, uTop, r);
  }
  if (l.windowLeft > 0n && s.rem > 0n && s.budget > 0n) {
    const ask = launchWindowAskX64(
      l,
      floorX64(l.pots.floor, s.sOut),
      s.sOut,
      take0,
      leg,
      slot.u,
    );
    const ff = flatFill(
      ask,
      s.rem,
      windowRoom(l.windowLeft, s.budget),
      slot.u,
      l.pots.floor,
      s.sOut,
    );
    if (ff.out > 0n) {
      // after a lot sale in the same buy, at most the lot's top
      const top = min(
        flatCreditTop(bidTopX64(priceX64(l.st), uTop), ask, slot.u),
        s.lotTop ?? U128_MAX,
      );
      const c = credit(l.pots, s.sOut, ff.out, ff.kept, room(l, l.st), top);
      const [sl, fl, pl, cut] = splitMilestones(ff.pay, ff.cut, ms);
      l.pots = c.after;
      l.windowLeft -= ff.out;
      s.sOut += ff.out;
      s.rem -= ff.pay;
      s.budget -= ff.out;
      r.windowOut = ff.out;
      r.windowPay = ff.pay;
      r.fillCut += cut;
      r.fillSlot += sl;
      r.msFloor += fl;
      r.msPlatform += pl;
    }
  }
  // `trade::graduates`: this buy sold the window out
  if (windowWas > 0n && r.windowOut === windowWas) {
    l.graduated = true;
    r.graduatedNow = true;
    r.graduationPriceX64 = priceX64(l.st);
  }
  // 3–5. the lot's bins under where the schedule's fill would start, the schedule, then after the end the bins and the range
  curveStages(l, take0, leg, slot, ms, u, uTop, s, r);
  // 6. fill-and-refund: the CHARGED take (⛔ `Charge`: fixed once inside the curve's first re-fill) on the SPENT leg only
  const { rates: charged, take: takeC } = s.ch;
  const rem0 = leg - takeC.total;
  const net = rem0 - s.rem;
  const [spent, tk] =
    s.rem === 0n ? [leg, takeC] : legForNet(charged, net, true, price0, f0);
  r.spent = spent;
  r.refund = leg - spent;
  r.take = tk;
  r.dust = spent - tk.total - net;
  r.out = r.windowOut + r.lotOut + r.scheduleOut + r.flatLotOut + r.flatTailOut;
  // D8: a buy that gets no token is refunded in full and pays no fee
  if (r.out === 0n) {
    r.spent = 0n;
    r.refund = leg;
    r.take = { ...ZERO_TAKE, extra: [...ZERO_TAKE.extra] };
    r.dust = 0n;
  }
  // 7. only now the kept skim, the rounding dust, the creator fee's backing and the slot's dust to `F`
  r.routing = route(l, r.take.creator, r.fillSlot);
  const k =
    r.take.kept + r.dust + r.routing.creatorBacking + r.routing.slotDust;
  if (k > 0n) l.pots = credit(l.pots, s.sOut, 0n, k, 0n, 0n).after;
  return r;
}

/**
 * A buy's running state across its stages: what is left to spend, the token budget, the tokens outside, the lowest lot
 * credit top so far (every later credit in the buy is capped at it) and the schedule's cushion + POL target at the books
 * (read at most once while the books do not move).
 */
interface Stages {
  rem: bigint;
  budget: bigint;
  sOut: bigint;
  lotTop: bigint | null;
  cpTotal: bigint | null;
  ch: Charge;
}

/**
 * ⛔ `launch::Charge`: a buy's take as CHARGED — `base` the rates before the
 * trade; `rates` / `take` what is charged: `base` until the curve's first re-fill fixes it ONCE at `cheaperBuy(base, end)`.
 */
interface Charge {
  base: Rates;
  rates: Rates;
  take: Take;
  leg: bigint;
  price0: bigint;
  f0: bigint;
}

/** `Charge::cheaper`: the charge at `cheaperBuy(base, end)` when it is cheaper than what is charged now and not yet fixed. */
function chargeCheaper(ch: Charge, end: Rates): [Rates, Take] | null {
  if (buyRatesDiffer(ch.rates, ch.base)) return null;
  const c = cheaperBuy(ch.base, end);
  if (!buyRatesDiffer(c, ch.base)) return null;
  const t = take(c, ch.leg, true, ch.price0, ch.f0);
  return t.total < ch.take.total ? [c, t] : null;
}

/**
 * `Launch::curve_stages`: steps 3–5 of a buy once the window is sold out — the lot's bins under where the schedule's fill
 * would start, the schedule, then after the end the bins and the tail range. `tk` is the take every ask and line prices.
 */
function curveStages(
  l: Launch,
  tk: Take,
  leg: bigint,
  slot: Schedule,
  ms: readonly [number, number, number],
  u: bigint,
  uTop: bigint,
  s: Stages,
  r: BuyReceipt,
): void {
  if (
    l.windowLeft === 0n &&
    !l.ended &&
    s.rem > 0n &&
    s.budget > 0n &&
    l.lotTokens > 0n
  )
    lotWalk(l, priceX64(l.st), slot, s, tk, leg, u, uTop, r);
  // 4. the schedule, once the window is sold out: its inventory alone
  if (l.windowLeft === 0n && !l.ended && s.rem > 0n && s.budget > 0n)
    scheduleStage(l, slot, ms, uTop, s, r);
  // 5. after the end: the bins and the tail range, the cheaper first
  if (l.ended && s.rem > 0n && s.budget > 0n)
    afterEnd(l, tk, leg, slot, uTop, ms, s, r);
}

function msScheduleOrNull(
  l: Launch,
  ms: readonly [number, number, number],
): Schedule | null {
  try {
    return msSchedule(l, ms);
  } catch (e) {
    if (!(e instanceof FloorMathError)) throw e;
    return null;
  }
}

/** `Launch::schedule_stage`: step 4, the schedule's fill of the inventory alone at the Milestones' schedule `slot`. */
function scheduleStage(
  l: Launch,
  slot: Schedule,
  ms: readonly [number, number, number],
  uTop: bigint,
  s: Stages,
  r: BuyReceipt,
): void {
  // a schedule fill takes the Milestones at the FDV it ENDS at, so one big buy across the rising curve never pays less
  // than the same money in pieces: filled at the rate before the trade; if the end's rate differs, filled again ONCE from
  // the same state at the end's (that fill is kept; if its schedule or fill fails, the first stands)
  let msS = ms;
  let uS = slot.u;
  let sf = scheduleFill(l, slot, s.rem, s.budget, s.sOut);
  if (sf !== null && sf.f.out > 0n) {
    const rEnd = launchRatesAt(l, curveTAt(l, priceX64(sf.f.after)));
    const msEnd = milestonesOf(rEnd);
    // ⛔ the same ONE re-fill fixes the charged take at the cheaper of the rates before and at the end, and spends what
    // that frees
    const cheaper = chargeCheaper(s.ch, rEnd);
    const freed = cheaper === null ? 0n : s.ch.take.total - cheaper[1].total;
    const msMoved =
      msEnd[0] !== ms[0] || msEnd[1] !== ms[1] || msEnd[2] !== ms[2];
    if (msMoved || freed > 0n) {
      const at = msMoved ? msScheduleOrNull(l, msEnd) : slot;
      const g =
        at !== null
          ? scheduleFill(l, at, s.rem + freed, s.budget, s.sOut)
          : null;
      if (g !== null) {
        sf = g;
        msS = msEnd;
        uS = at!.u;
        if (cheaper !== null) {
          s.ch.rates = cheaper[0];
          s.ch.take = cheaper[1];
          s.rem += freed;
        }
      }
    }
  }
  if (sf === null) return;
  const { f, have, rm } = sf;
  if (f.out > 0n) {
    l.inventory -= f.out;
    const rc = room(l, f.after);
    // the top at what THIS fill kept (`u′` at the rate it was charged)
    const top = min(
      bidTopX64(priceX64(f.after), min(uS, uTop)),
      s.lotTop ?? U128_MAX,
    );
    l.pots = credit(l.pots, s.sOut, f.out, f.vaultIn, rc, top).after;
    const [sl, fl, pl, cut] = splitMilestones(f.pay, f.cut, msS);
    l.st = f.after;
    s.cpTotal = null;
    s.sOut += f.out;
    s.rem -= f.pay;
    s.budget -= f.out;
    r.scheduleOut += f.out;
    r.schedulePay += f.pay;
    r.fillCut += cut;
    r.fillSlot += sl;
    r.msFloor += fl;
    r.msPlatform += pl;
  }
  // the inventory bound the fill (not the snipe cap): the schedule is DONE
  if ((f.ended && rm === have) || l.inventory === 0n) {
    end(l);
    r.endedNow = true;
  }
}

/** `⌈x·2⁶⁴ ÷ u⌉`, saturating (`u` at least 1). */
function ceilQSat(x: bigint, u: bigint): bigint {
  const um = u > 1n ? u : 1n;
  const v = ((x << 64n) + um - 1n) / um;
  return v > U128_MAX ? U128_MAX : v;
}

/** `⌈F·2⁶⁴ ÷ S_out⌉`, saturating (0 with nothing outside): the floor rounded up. */
function fCeilX64(floor: bigint, sOut: bigint): bigint {
  if (sOut === 0n) return 0n;
  const v = ((floor << 64n) + sOut - 1n) / sOut;
  return v > U128_MAX ? U128_MAX : v;
}

/** `Launch::after_end`: step 5, the lot's bins at their asks and the tail range, the cheaper first. */
function afterEnd(
  l: Launch,
  tk: Take,
  leg: bigint,
  slot: Schedule,
  uTop: bigint,
  ms: readonly [number, number, number],
  s: Stages,
  r: BuyReceipt,
): void {
  const u = l.sch.u;
  const line = (): bigint => {
    const band = l.pots.floor + l.pots.cushion;
    return backingLineX64(
      band > U128_MAX ? U128_MAX : band,
      s.sOut,
      tk.total,
      leg,
      slot.u,
    );
  };
  const rangeBuy = (cap: bigint, uR: bigint): TailBuy =>
    tailBuy(
      l.tailLiq,
      l.tailSqrtX64,
      l.tail,
      s.rem,
      uR,
      l.pots.floor,
      s.sOut,
      line(),
      cap,
      s.budget,
    );
  for (let i = 0; i < 2 * LOT_BINS + 4; i++) {
    if (s.rem === 0n || s.budget === 0n) break;
    // the range's price as a buy pays it: its curve's, raised to `f ÷ u′` and the bid's line (`tailBuy`'s least prices)
    const tailPx = max(
      max(
        launchTailPriceX64(l),
        ceilQSat(fCeilX64(l.pots.floor, s.sOut), slot.u),
      ),
      line(),
    );
    const cheapest = cheapestBin(l, s.sOut, u, tk, leg);
    // the cheapest bin at or under the range's price; else the range, stopped at that bin's ask — and when the range
    // cannot move under that cap, the bin sells at its ask (a lot that waits never freezes a buy)
    let tb: TailBuy = {
      pay: 0n,
      out: 0n,
      kept: 0n,
      cut: 0n,
      toFloor: 0n,
      toMoney: 0n,
      sqrtAfter: 0n,
    };
    let tbCap = U128_MAX;
    let lotNow: [number, bigint] | null = null;
    if (cheapest !== null && cheapest[1] <= tailPx) lotNow = cheapest;
    else if (cheapest !== null) {
      tbCap = sqrtX64(cheapest[1]);
      tb = rangeBuy(tbCap, slot.u);
      if (tb.out === 0n) lotNow = cheapest;
    } else tb = rangeBuy(U128_MAX, slot.u);
    if (lotNow !== null) {
      const [pay, out] = lotSale(l, lotNow[0], lotNow[1], s, u, uTop, r);
      if (out > 0n) {
        s.sOut += out;
        s.rem -= pay;
        s.budget -= out;
        r.flatLotOut += out;
        r.flatPay += pay;
        continue;
      }
      // the bin sold nothing (its flat rounding): the range, uncapped
      tbCap = U128_MAX;
      tb = rangeBuy(U128_MAX, slot.u);
    }
    // the three Marketcap Milestones apply to range buys, inside the price, at the FDV the step ENDS at (as the
    // schedule's fill): filled at this trade's rate, then once again at the end's if it differs (the same cap)
    let msT = ms;
    if (tb.out > 0n) {
      const rEnd = launchRatesAt(l, curveTAt(l, priceOfSqrt(tb.sqrtAfter)));
      const msEnd = milestonesOf(rEnd);
      // ⛔ that re-fill also fixes the charged take (`Charge`, once a buy) and spends what it frees
      const cheaper = chargeCheaper(s.ch, rEnd);
      const freed = cheaper === null ? 0n : s.ch.take.total - cheaper[1].total;
      const msMoved =
        msEnd[0] !== ms[0] || msEnd[1] !== ms[1] || msEnd[2] !== ms[2];
      if (msMoved || freed > 0n) {
        const uEnd = msMoved ? msScheduleOrNull(l, msEnd)?.u ?? null : slot.u;
        if (uEnd !== null) {
          let g: TailBuy | null;
          try {
            g = tailBuy(
              l.tailLiq,
              l.tailSqrtX64,
              l.tail,
              s.rem + freed,
              uEnd,
              l.pots.floor,
              s.sOut,
              line(),
              tbCap,
              s.budget,
            );
          } catch (e) {
            if (!(e instanceof FloorMathError || e instanceof BidMathError))
              throw e;
            g = null;
          }
          if (g !== null && g.out > 0n) {
            tb = g;
            msT = msEnd;
            if (cheaper !== null) {
              s.ch.rates = cheaper[0];
              s.ch.take = cheaper[1];
              s.rem += freed;
            }
          }
        }
      }
    }
    if (tb.out === 0n) break;
    // floor first, the rest is the range's money; the curve moved by what it kept
    l.pots = { ...l.pots, floor: u128(l.pots.floor + tb.toFloor) };
    l.tailMoney = u128(l.tailMoney + tb.toMoney);
    l.tailSqrtX64 = tb.sqrtAfter;
    l.tail -= tb.out;
    const [sl, fl, pl, cut] = splitMilestones(tb.pay, tb.cut, msT);
    s.sOut += tb.out;
    s.rem -= tb.pay;
    s.budget -= tb.out;
    r.flatTailOut += tb.out;
    r.flatPay += tb.pay;
    r.tailPay += tb.pay;
    r.tailToFloor += tb.toFloor;
    r.fillCut += cut;
    r.fillSlot += sl;
    r.msFloor += fl;
    r.msPlatform += pl;
  }
}

/**
 * One keeperless schedule fill of the inventory alone (the lot sells first, outside the fill) at the Milestones' schedule
 * `slot`, with the tokens on offer and the room; null if it fails (a failing fill sells nothing and the rest is refunded:
 * a buy never reverts on the curve's own state).
 */
function scheduleFill(
  l: Launch,
  slot: Schedule,
  rem: bigint,
  budget: bigint,
  sOut: bigint,
): {
  f: NonNullable<ReturnType<typeof fillKeeperless>>;
  have: bigint;
  rm: bigint;
} | null {
  const have = l.inventory;
  const rm = min(have, budget);
  let f: ReturnType<typeof fillKeeperless> = null;
  try {
    f = fillKeeperless(
      slot,
      l.st,
      rem,
      rm,
      l.pots.floor + l.pots.cushion,
      sOut,
      l.pots.floor,
      0n,
    );
  } catch (e) {
    if (!(e instanceof FloorMathError || e instanceof BidMathError)) throw e;
  }
  return f === null ? null : { f, have, rm };
}

/** `Launch::route`: the creator fee and the slot's take (`fillSlot`) — what goes where, and what stays in `F`. */
function route(l: Launch, creator: bigint, fillSlot: bigint): Routing {
  const g = zeroRouting();
  const [refs, rest] = creatorLegs(creator, l.creatorRefs);
  g.creatorRefs = refs;
  if (l.slotRateBps > 0) {
    const [sl, back] = splitCreator(rest, l.slotBoughtPpm);
    g.creatorToSlot = sl;
    g.creatorBacking = back;
    const [parts, dust] = splitMembers(
      fillSlot + g.creatorToSlot,
      l.slotWeights,
    );
    g.slotMembers = parts;
    g.slotDust = dust;
  } else {
    // with no Team Slot the Team Marketcap Milestone is the creator's, as a slot with no shares pays place 0
    g.toCreator = rest + fillSlot;
  }
  return g;
}

/**
 * The schedule is done: its books freeze, the inventory it did not sell joins the tail, and the tail opens as ONE range
 * from the frozen price to an infinite price.
 */
function end(l: Launch): void {
  l.ended = true;
  l.tail += l.inventory;
  l.inventory = 0n;
  const [liq, se] = tailOpen(l.tail, priceX64(l.st));
  l.tailLiq = liq;
  l.tailSqrtX64 = se;
  l.tailSqrtEndX64 = se;
}

/**
 * `Launch::lot_walk`: the lot's bins, the cheapest first, each at its own ask while that is under `capX64` (strictly) —
 * with `sched` (the slot-cut schedule, before the end) also while it is under the price the schedule's fill of what is left
 * would start at (`raiseToBacking`'s price, at least `⌈⌈F·2⁶⁴ ÷ S_out⌉·2⁶⁴ ÷ u′⌉`, read once, the first time a bin reaches
 * `capX64`; no fill: every bin that asks may sell). Its tokens and pay go to `lotOut` / `lotPay`.
 */
function lotWalk(
  l: Launch,
  capX64: bigint,
  sched: Schedule | null,
  s: Stages,
  tk: Take,
  leg: bigint,
  u: bigint,
  uTop: bigint,
  r: BuyReceipt,
): void {
  let start: bigint | null = null;
  for (let i = 0; i < LOT_BINS; i++) {
    if (s.rem === 0n || s.budget === 0n) break;
    const c = cheapestBin(l, s.sOut, u, tk, leg);
    if (c === null) break;
    const [bin, ask] = c;
    if (ask >= capX64) {
      if (sched === null) break;
      if (start === null) {
        let p = U128_MAX;
        try {
          const band = l.pots.floor + l.pots.cushion;
          const g = raiseToBacking(
            sched,
            l.st,
            band > U128_MAX ? U128_MAX : band,
            s.sOut,
            s.rem,
            1n,
          );
          if (g !== null) p = priceX64(g);
        } catch (e) {
          if (!(e instanceof FloorMathError || e instanceof BidMathError))
            throw e;
        }
        start = max(p, ceilQSat(fCeilX64(l.pots.floor, s.sOut), sched.u));
      }
      if (ask >= start) break;
    }
    const [pay, out] = lotSale(l, bin, ask, s, u, uTop, r);
    if (out === 0n) break;
    s.sOut += out;
    s.rem -= pay;
    s.budget -= out;
    r.lotOut += out;
    r.lotPay += pay;
  }
}

/**
 * `Launch::lot_sale`: bin `bin`'s flat sale at `ask` — floor first, its cost home to the cushion (the schedule's room at
 * least) while the curve is live, nothing into a dead curve; its credit top `lotCreditTopX64`, never over an earlier lot
 * sale's in the same buy. No slot cut (`u`). Returns `[pay, out]`; the caller books the tokens.
 */
function lotSale(
  l: Launch,
  bin: number,
  ask: bigint,
  s: Stages,
  u: bigint,
  uTop: bigint,
  r: BuyReceipt,
): [bigint, bigint] {
  const ff = flatFill(
    ask,
    s.rem,
    min(l.lot.bins[bin].tokens, s.budget),
    u,
    l.pots.floor,
    s.sOut,
  );
  if (ff.out === 0n) return [0n, 0n];
  const cost = lotTake(l.lot, bin, ff.out);
  const top = min(
    lotCreditTopX64(bidTopX64(priceX64(l.st), uTop), ask, u),
    s.lotTop ?? U128_MAX,
  );
  s.lotTop = top;
  let rc = 0n;
  if (curveLive(l.pots, s.sOut)) {
    if (s.cpTotal === null) {
      const [c, p] = cpTargets(l.sch, l.terms, l.st);
      s.cpTotal = c + p;
    }
    const r0 = s.cpTotal > l.pots.cushion ? s.cpTotal - l.pots.cushion : 0n;
    rc = r0 > cost ? r0 : cost;
  }
  l.pots = credit(l.pots, s.sOut, ff.out, ff.kept, rc, top).after;
  l.lotTokens -= ff.out;
  l.lotCost -= cost;
  r.fillCut += ff.cut;
  return [ff.pay, ff.out];
}

/** ⛔ `Launch::sell` (in place): `bid::sell`, the take at the price and `f` BEFORE the sell, the tokens to the lot, the kept skim after. */
export function launchSell(
  l: Launch,
  tokens: bigint,
  liveSupply: bigint,
): SellReceipt {
  // H1-SCHED: whole math units are sold (a remainder under one is not)
  const k = scaleOf(l);
  const r = sellMath(l, tokens / k, liveSupply / k);
  r.tokens = u128(r.tokens * k);
  r.tailTokens = u128(r.tailTokens * k);
  return r;
}

function sellMath(l: Launch, tokens: bigint, liveSupply: bigint): SellReceipt {
  const swept0 = sync(l, liveSupply);
  const sOut = launchSOut(l);
  if (tokens > sOut) fail('NotOutside');
  // past u128 the floor saturates (it only picks the at-floor skim)
  const f0 = ok(() => floorX64(l.pots.floor, sOut)) ?? U128_MAX;
  // after the end the tail range takes the tokens back first, down its curve to the frozen price
  const ts = l.ended
    ? tailSell(
        l.tailLiq,
        l.tailSqrtX64,
        l.tailSqrtEndX64,
        l.tailMoney,
        tokens,
        l.pots.floor,
        sOut,
      )
    : noTailSell(0n);
  const pots = { ...l.pots, floor: l.pots.floor - ts.fromFloor };
  const fill = bidSell(pots, sOut - ts.tokens, tokens - ts.tokens);
  const gross = ts.gross + fill.quoteOut;
  // M-1: the skim ramps on the price the sell STARTS at — the cushion's top while it has money, else the floor itself
  const pStart =
    l.pots.cushion > 0n ? max(priceOfSqrt(l.pots.bidSqrtX64), f0) : f0;
  // the sell's fees at the FDV before it (a sell never moves the books; after the end, the range's price); no Milestones
  const tk = take(ratesNow(l), gross, false, pStart, f0);
  const sAfter = sOut - tokens;
  // H-3: the kept skim backs only the holders who stay; the seller's own share goes to the platform bucket
  const keptStay = u128((tk.kept * sAfter) / max(sOut, 1n));
  const keptToPlatform = tk.kept - keptStay;
  tk.kept = keptStay;
  l.pots = fill.after;
  if (ts.tokens > 0n) {
    l.tail += ts.tokens;
    l.tailMoney -= ts.fromMoney;
    l.tailSqrtX64 = ts.sqrtAfter;
  }
  l.lotTokens += fill.cushionTokens + fill.floorTokens;
  l.lotCost += fill.fromCushion + fill.fromFloor;
  // each token by what it cost
  lotAddSell(l.lot, fill);
  const routing = route(l, tk.creator, 0n);
  const k = tk.kept + routing.creatorBacking + routing.slotDust;
  if (k > 0n) l.pots = credit(l.pots, sAfter, 0n, k, 0n, 0n).after;
  const swept = sweep(l, sAfter);
  return {
    tokens,
    gross,
    fromCushion: fill.fromCushion,
    fromFloor: fill.fromFloor,
    take: tk,
    payout: gross - tk.total,
    swept: swept0 + swept,
    routing,
    keptToPlatform,
    tailTokens: ts.tokens,
    tailFromFloor: ts.fromFloor,
    tailFromMoney: ts.fromMoney,
  };
}

/** `Launch::burn`: the live supply after a holder burns `tokens` (`NotOutside` past what is outside). Nothing else moves until the next trade. */
export function launchBurn(
  l: Launch,
  liveSupply: bigint,
  tokens: bigint,
): bigint {
  const k = scaleOf(l);
  const outside =
    chainUnits(l, supplySOut(min(liveSupply / k, l.supply), held(l))) +
    (liveSupply % k);
  if (tokens > outside) fail('NotOutside');
  return liveSupply - tokens;
}

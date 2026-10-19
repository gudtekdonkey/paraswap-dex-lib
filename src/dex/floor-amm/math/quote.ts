// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// The quoter: what a FLOOR Program trade does, run on a COPY of the launch's state by the reference trade
// (`src/math/launch.ts`, held to `golden/launch.json` receipt for receipt). No pool, no walk, no ticks. A quote returns the
// crate's receipt, the state after (to chain quotes), and what a site shows: tokens out, the refund, the floor before and
// after, ⛔ (`graduates`: this buy sells the window out — the site plays the transition), the schedule's end.
//
// ⛔ Trades are never paused: there is no "paused" refusal here. A buy refuses nothing (fill-and-refund); the
// quoter adds the caller's slippage check and `NothingToBuy` when no token would come out.

import { bidPriceX64, floorX64 } from './bid';
import {
  cloneLaunch,
  curveT,
  held,
  launchBuy,
  launchFloorX64,
  launchSOut,
  launchSell,
  ratesNow,
  slotSchedule,
} from './launch';
import { sOut as supplySOut, syncSupply } from './supply';
import { windowPriceX64 } from './trade';
import type { BuyReceipt, Launch, SellReceipt } from './launch';
import { priceX64 } from './schedule';
import {
  CURVE_ONE,
  LIST_MIN_FEE_BPS,
  curveBps,
  discountedBps,
  milestonesOf,
} from './fees';
import type { Rates } from './fees';

const U64_MAX = (1n << 64n) - 1n;

export type QuoteErrorCode =
  | 'Zero'
  | 'Overflow'
  | 'SlippageExceeded'
  | 'NothingToBuy';

export class FloorQuoteError extends Error {
  readonly code: QuoteErrorCode;
  constructor(code: QuoteErrorCode, detail?: string) {
    super(`floor quote: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'FloorQuoteError';
    this.code = code;
  }
}

/**
 * A copy with the governance list's discount on the Platform rate, as the program applies it: off THIS trade's curved
 * Platform rate (at the launch's place on the curve now), written flat to both ends of the curve.
 */
function withList(state: Launch, listBps: number | undefined): Launch {
  const l = cloneLaunch(state);
  if (listBps) {
    const now = curveBps(
      l.rates.platformStartBps,
      l.rates.platformBps,
      curveT(l),
      true,
    );
    const d = discountedBps(now, listBps, LIST_MIN_FEE_BPS);
    l.rates = { ...l.rates, platformBps: d, platformStartBps: d };
  }
  return l;
}

/**
 * The Marketcap Milestones a buy paid, from its receipt (inside the price, out of the window's and the schedule's fills;
 * never on a sell or after the schedule's end): the Team Milestone (`fillSlot`: the Team Slot's, the creator's with no
 * slot), the Platform Milestone and the `$FLOOR` Milestone, quote base units.
 */
export interface Milestones {
  team: bigint;
  platform: bigint;
  floor: bigint;
}

/** Where a launch sits on its curves now and the rates a trade now pays (what a site shows beside the price). */
export interface CurveView {
  /** The curve position, ppb of `CURVE_ONE` (0 at or under the START's FDV, `CURVE_ONE` at or past the END's). */
  t: bigint;
  /** `t` as a fraction 0 ..= 1 (display only). */
  progress: number;
  /** One trade's flat rates now (`ratesNow`): the fees in their fields, the Milestones in `teamMsBps` / … (start = end). */
  rates: Rates;
  /** The three Milestones' rates now, bps of a buy (after the live bound, `MILESTONES_LIVE_MAX_BPS`). */
  milestoneBps: { team: number; platform: number; floor: number };
}

/** The launch's place on its curves and the rates a trade pays now (the governance list's discount with `listBps`). */
export function curveView(
  state: Launch,
  opts: { listBps?: number } = {},
): CurveView {
  const l = withList(state, opts.listBps);
  const t = curveT(l);
  const rates = ratesNow(l);
  const [team, platform, floor] = milestonesOf(rates);
  return {
    t,
    progress: Number(t) / Number(CURVE_ONE),
    rates,
    milestoneBps: { team, platform, floor },
  };
}

function legIn(v: bigint): bigint {
  if (v <= 0n)
    throw new FloorQuoteError('Zero', 'exact-in only: the amount must be > 0');
  if (v > U64_MAX) throw new FloorQuoteError('Overflow');
  return v;
}

export interface BuyQuote {
  receipt: BuyReceipt;
  tokensOut: bigint;
  /** The spent leg (charged) and the quote returned. */
  charged: bigint;
  refund: bigint;
  /** this buy sells the window out (the launch graduates in it), at the window's price `graduationPriceX64`. */
  graduates: boolean;
  graduationPriceX64: bigint | null;
  scheduleDone: boolean;
  sOutBefore: bigint;
  sOutAfter: bigint;
  floorBeforeX64: bigint;
  floorAfterX64: bigint;
  /** The books' price after (frozen after the end; after it the next buy fills on the tail range, `launchLiveBuyPriceX64`). */
  priceAfterX64: bigint;
  /** The rates this buy was charged at (`ratesNow` before it: the fees; the schedule fill's Milestones may be the END's). */
  rates: Rates;
  /** The Marketcap Milestones this buy paid (inside the price; not on top of the charged amount). */
  milestones: Milestones;
  /** The curve position before and after the buy (ppb of `CURVE_ONE`). */
  curveTBefore: bigint;
  curveTAfter: bigint;
  after: Launch;
}

/** The window's flat price a buy pays first (the graduation event's price): `window_price_x64` at the synced `S_out`. */
function windowAsk(l: Launch, liveSupply: bigint): bigint {
  const so = supplySOut(syncSupply(l.supply, liveSupply), held(l));
  return windowPriceX64(
    l.p0X64,
    so === 0n ? 0n : floorX64(l.pots.floor, so),
    slotSchedule(l).u,
  );
}

/**
 * Quote a BUY of `quoteIn` (exact-in) at `nowSlot` (the snipe cap's clock: Solana slot / EVM block; default past the cap)
 * with the mint's `liveSupply` (default: the stored supply).
 */
export function quoteBuy(
  state: Launch,
  quoteIn: bigint,
  opts: {
    nowSlot?: bigint;
    liveSupply?: bigint;
    minTokensOut?: bigint;
    listBps?: number;
  } = {},
): BuyQuote {
  const leg = legIn(quoteIn);
  const l = withList(state, opts.listBps);
  const sOutBefore = launchSOut(l);
  const fBefore = launchFloorX64(l);
  const rates = ratesNow(l);
  const curveTBefore = curveT(l);
  const r = launchBuy(
    l,
    leg,
    opts.nowSlot ?? state.createdSlot + BigInt(state.spec.snipeSlots),
    opts.liveSupply ?? state.supply,
  );
  l.rates = state.rates; // the discount was this trader's only
  if (r.out === 0n) throw new FloorQuoteError('NothingToBuy');
  if (opts.minTokensOut !== undefined && r.out < opts.minTokensOut)
    throw new FloorQuoteError('SlippageExceeded');
  return {
    receipt: r,
    tokensOut: r.out,
    charged: r.spent,
    refund: r.refund,
    graduates: r.graduatedNow,
    graduationPriceX64: r.graduatedNow ? r.graduationPriceX64 : null,
    scheduleDone: r.endedNow,
    sOutBefore,
    sOutAfter: launchSOut(l),
    floorBeforeX64: fBefore,
    floorAfterX64: launchFloorX64(l),
    priceAfterX64: priceX64(l.st),
    rates,
    milestones: { team: r.fillSlot, platform: r.msPlatform, floor: r.msFloor },
    curveTBefore,
    curveTAfter: curveT(l),
    after: l,
  };
}

export interface SellQuote {
  receipt: SellReceipt;
  /** The seller's net. */
  quoteOut: bigint;
  sOutBefore: bigint;
  sOutAfter: bigint;
  floorBeforeX64: bigint;
  floorAfterX64: bigint;
  /** The fee rates this sell was charged at (`ratesNow` before it; a sell pays no Milestone). */
  rates: Rates;
  after: Launch;
}

/** Quote a SELL of `tokensIn` (exact-in). The bid always fills; `NotOutside` (the crate's) past what is outside. */
export function quoteSell(
  state: Launch,
  tokensIn: bigint,
  opts: { liveSupply?: bigint; minQuoteOut?: bigint; listBps?: number } = {},
): SellQuote {
  const x = legIn(tokensIn);
  const l = withList(state, opts.listBps);
  const sOutBefore = launchSOut(l);
  const fBefore = launchFloorX64(l);
  const rates = ratesNow(l);
  const r = launchSell(l, x, opts.liveSupply ?? state.supply);
  l.rates = state.rates;
  if (opts.minQuoteOut !== undefined && r.payout < opts.minQuoteOut)
    throw new FloorQuoteError('SlippageExceeded');
  return {
    receipt: r,
    quoteOut: r.payout,
    sOutBefore,
    sOutAfter: launchSOut(l),
    floorBeforeX64: fBefore,
    floorAfterX64: launchFloorX64(l),
    rates,
    after: l,
  };
}

/** The window has sold out: the launch has graduated to the curve. */
export function isGraduated(l: Launch): boolean {
  return l.graduated;
}

/** What a site shows: `f = F ÷ S_out` (a holder is BACKED by it), the best bid now, and the price a buy fills at. */
export function displayFloor(l: Launch): {
  floorX64: bigint;
  bidX64: bigint;
  priceX64: bigint;
  floor: bigint;
  cushion: bigint;
  sOut: bigint;
} {
  const so = launchSOut(l);
  return {
    floorX64: floorX64(l.pots.floor, so),
    bidX64: bidPriceX64(l.pots, so),
    priceX64: l.windowLeft > 0n ? l.p0X64 : priceX64(l.st),
    floor: l.pots.floor,
    cushion: l.pots.cushion,
    sOut: so,
  };
}

/** `/api/dex`'s liquidity: the quote side only, `F + C`. */
export function dexLiquidity(l: Launch): bigint {
  return l.pots.floor + l.pots.cushion;
}

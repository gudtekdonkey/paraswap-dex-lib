// FloorAmm's views → the reference trade's state (`math/launch.ts`), so the dex prices a live launch with the one
// math every chain reproduces (the golden `launch.json`).
//
// The launch is RESTORED from what the contract stores, never re-created: the row (`launchSpec`, `PresetSpec::to_bytes`)
// and the schedule (`launchMarket`'s, `abi.encode(FloorSchedule.Schedule)`) are fixed at create; the views give every
// field a trade moves. EVM ↔ the reference math, field for field:
// launchMarket = (book (s, h, l, curveFloorX64), bidSqrtX64, bidLiq, schedule) → st, pots.bidSqrtX64 / pots.liq, sch
// launchState (LaunchView): floor, cushion → pots; supply, windowLeft, inventory, lotTokens, tailTokens ÷ k (they are
// chain units; launchMarket is math units, see `units.ts`); lotCost 1:1; p0 recomputed from `raise` (the view's is per
// chain unit, floored); ended; graduated; createdBlock → createdSlot; slotRateBps, slotBoughtPpm → the Team Slot.
// creatorAlloc = (tokens ÷ k, unlockMcap, unlockBacking) → the creator's held free allocation (the Token Option: what is still held);
// tokenOptionState → its releases done and the next one's time.
// teamSlot.members[i].paid (shares) → the members' weights (`fees::slot_weights(paid)`); creatorRefs → the paid tiers.
// The tail range after the schedule's end (`L`, `√p` now and at the frozen price, its money) → tailLiq, tailSqrtX64,
// tailSqrtEndX64, tailMoney, from `launchTail(id)` (its fifth output, the range's price, is derived, not stored); a
// contract without it reads as no range, which prices a launch restored after its end without the range — the pool's
// replay carries it forward from any state that has it.
// launchQuoteInfo(id).quoteUsdCentsX64 (the quote's declared price at create) → curveL (`curveLogs`, as create fixes it).
// launchMsLiveMaxBps(id) → msLiveMaxBps (optional: a contract without the view reads as the general bound).
// The bought-back lot's bins (what each token cost) have no view yet: optional, an empty lot without them (the lot then
// waits in a quote); the pool's replay carries the bins forward from any state that has them.
// The token's live supply is totalSupply() − balanceOf(DEAD) (the program's own supply read).

import { curveLogs, mathDecimals } from './math/launch';
import { cloneLot, emptyLot, lotBinsInUse } from './math/lot';
import type { Lot } from './math/lot';
import type { Launch } from './math/launch';
import { ratesOf, slotWeights } from './math/fees';
import {
  MILESTONES_LIVE_MAX_BPS,
  PRESET_LEN,
  openPriceX64,
  presetFromBytes,
  saleTokens,
} from './math/preset';
import { tokenScale } from './units';
import { SCHEDULE_LEN, Schedule } from './math/schedule';
import { hexToBytes } from './evm/abi';
import type { AbiValue } from './evm/abi';
import { DEAD, FN, LV, OUT, calldata, decode } from './abi';
import type { PoolState } from './types';

/** EVM tokens have 18 decimals. */
export const TOKEN_DECIMALS = 18;
const NATIVE = '0x0000000000000000000000000000000000000000';

export type ChainViews = {
  /** `launchState(id)`: the LaunchView tuple. */
  view: AbiValue[];
  /** `launchSpec(id)`: the row's bytes. */
  spec: string;
  /** `launchMarket(id)`'s schedule: `abi.encode(FloorSchedule.Schedule)`. */
  schedule: string;
  /** `launchMarket(id)`'s book `(s, h, l, curveFloorX64)`, then `bidSqrtX64`, `bidLiq`. */
  books: bigint[];
  /** `creatorRefs(id)`. */
  creatorRefs: string[];
  /** `teamSlot(id)`'s members' `paid` and its `bought` (Σ paid). */
  slotPaid: bigint[];
  /** `creatorAlloc(id)`: tokens (chain units, still HELD since), unlockMcap, unlockBacking, unlocked. */
  creatorAlloc: [bigint, bigint, bigint, boolean];
  /** `tokenOptionState(id)`: releasesDone, nextReleaseAt. */
  tokenOption: [number, bigint];
  slotBought: bigint;
  /** The quote's decimals: the math runs at `mathDecimals(18, quoteDecimals)` (H1-SCHED). */
  quoteDecimals: number;
  /** The tail range: `L`, `√p · 2^64` now and at the frozen price, the quote it holds (math units). Optional: 0 when absent. */
  tail?: [bigint, bigint, bigint, bigint];
  /** `launchQuoteInfo(id)`'s declared quote price at create (US cents, Q64.64): the curves' span is fixed from it. */
  quoteUsdCentsX64: bigint;
  /** `launchMsLiveMaxBps(id)`: the launch's own bound on the three Milestones together. Optional: the general bound. */
  msLiveMaxBps?: number;
  /** The bought-back lot's bins (math units); their totals must be the view's `lotTokens ÷ k` / `lotCost`. Optional: empty. */
  lot?: Lot;
};

const n = (v: AbiValue): bigint => v as bigint;

const PRESET_LEN_V1 = 373;

/** A v1 launch's row (373 bytes) is zero-padded to `PRESET_LEN`: no `$FLOOR` leg, no allocation, as it was built. */
export function specBytes(b: Uint8Array): Uint8Array {
  if (b.length !== PRESET_LEN_V1) return b;
  const out = new Uint8Array(PRESET_LEN);
  out.set(b);
  return out;
}

/** `abi.encode(FloorSchedule.Schedule)`'s length: n, l[8], cp[8], f[8], gcp[8], gf[8], u — 42 words. */
export const SCHEDULE_ABI_LEN = 32 * (2 + 5 * 8);

/**
 * The EVM contract's schedule (`abi.encode(FloorSchedule.Schedule)`) as the reference's `Schedule`: the same fields as
 * `Schedule::to_bytes`, each a big-endian word that must fit 128 bits, `n` at most 8.
 */
export function scheduleFromAbi(b: Uint8Array): Schedule {
  if (b.length !== SCHEDULE_ABI_LEN)
    throw new RangeError(
      `a schedule is ${SCHEDULE_ABI_LEN} bytes, got ${b.length}`,
    );
  const word = (k: number): bigint => {
    let v = 0n;
    for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[32 * k + i]);
    if (v >> 128n !== 0n)
      throw new RangeError(`schedule word ${k} past 128 bits`);
    return v;
  };
  const count = word(0);
  if (count > 8n)
    throw new RangeError(`a schedule has at most 8 points, got ${count}`);
  const out = new Uint8Array(SCHEDULE_LEN);
  out[0] = Number(count);
  const put = (o: number, v: bigint): void => {
    for (let i = 0; i < 16; i++)
      out[o + i] = Number((v >> BigInt(8 * i)) & 0xffn);
  };
  for (let k = 1; k <= 41; k++) put(8 + (k - 1) * 16, word(k));
  return Schedule.fromBytes(out);
}

export function launchFromChain(c: ChainViews): Launch {
  const v = c.view;
  const spec = presetFromBytes(specBytes(hexToBytes(c.spec)));
  const [s, h, l, curveFloorX64, bidSqrtX64, liq] = c.books;
  const creator = (v[LV.creator] as string).toLowerCase();
  const slotRateBps = Number(v[LV.slotRateBps]);
  const slotBoughtPpm = Number(v[LV.slotBoughtPpm]);
  const md = mathDecimals(TOKEN_DECIMALS, c.quoteDecimals);
  const k = tokenScale(TOKEN_DECIMALS, c.quoteDecimals);
  const tok = (f: number): bigint => n(v[f]) / k;
  const launch: Launch = {
    spec,
    rates: ratesOf(spec),
    // the trade reads only the cushion / POL shares (`cp_targets`); the rest shaped the stored schedule
    terms: {
      cushionBps: spec.cushionBps,
      polBps: spec.polBps,
      rampCpFrom: 0n,
      fullAt: 0n,
      floor0Bps: 0,
      rampFrom: 0n,
      floorPoints: [
        { mcap: 0n, bps: 0 },
        { mcap: 0n, bps: 0 },
        { mcap: 0n, bps: 0 },
        { mcap: 0n, bps: 0 },
      ],
      cutBps: spec.cutBps,
    },
    sch: scheduleFromAbi(hexToBytes(c.schedule)),
    st: { s, h, l, floorX64: curveFloorX64 },
    // the view's p0 is per chain unit, floored: an unscaled launch's is exact, a scaled one's is recomputed as at create
    p0X64:
      k === 1n
        ? n(v[LV.p0X64])
        : openPriceX64(n(v[LV.raise]), saleTokens(spec, md)),
    pots: { floor: n(v[LV.floor]), cushion: n(v[LV.cushion]), bidSqrtX64, liq },
    supply: tok(LV.supply),
    windowLeft: tok(LV.windowLeft),
    inventory: tok(LV.inventory),
    lotTokens: tok(LV.lotTokens),
    lotCost: n(v[LV.lotCost]),
    tail: tok(LV.tailTokens),
    creatorAlloc: 0n,
    allocReleasesDone: 0,
    allocNextReleaseAt: 0n,
    creatorUnlockMcap: 0n,
    creatorUnlockBacking: 0n,
    ended: v[LV.ended] as boolean,
    graduated: v[LV.graduated] as boolean,
    slotRateBps,
    slotBoughtPpm,
    slotWeights: slotRateBps > 0 ? slotWeights(c.slotPaid) : [0, 0, 0, 0, 0],
    creatorRefs: c.creatorRefs.map(
      a => a.toLowerCase() !== NATIVE && a.toLowerCase() !== creator,
    ),
    createdSlot: n(v[LV.createdBlock]),
    // H1-SCHED: the math runs in math units; trades take and return chain units
    tokenDecimals: md,
    tokenScale: k,
    tailLiq: c.tail?.[0] ?? 0n,
    tailSqrtX64: c.tail?.[1] ?? 0n,
    tailSqrtEndX64: c.tail?.[2] ?? 0n,
    tailMoney: c.tail?.[3] ?? 0n,
    // the fee and Milestone curves' span, as create fixed it (a row with no span is flat: its curves are never read)
    curveL:
      spec.curveToUsd > 0n
        ? curveLogs(spec, c.quoteUsdCentsX64, c.quoteDecimals)
        : [0n, 0n],
    // the Milestones' live bound: every launch a FloorAmm opens with `createLaunch` has the general one (the genesis's own
    // bound is set only by its raise-priced open, not an EVM launch)
    msLiveMaxBps: c.msLiveMaxBps ?? MILESTONES_LIVE_MAX_BPS,
    lot: lotOf(c.lot, tok(LV.lotTokens), n(v[LV.lotCost])),
  };
  // the creator's held free allocation (0 once released) and its unlock's marks
  const [allocTokens, unlockMcap, unlockBacking] = c.creatorAlloc;
  launch.creatorAlloc = allocTokens / k;
  [launch.allocReleasesDone, launch.allocNextReleaseAt] = c.tokenOption;
  launch.creatorUnlockMcap = unlockMcap;
  launch.creatorUnlockBacking = unlockBacking;
  return launch;
}

/** The views' lot bins, checked against the view's totals (stale bins refused); none → an empty lot. */
function lotOf(lot: Lot | undefined, tokens: bigint, cost: bigint): Lot {
  if (lot === undefined) return emptyLot();
  const bins = lotBinsInUse(lot);
  const t = bins.reduce((a, b) => a + b.tokens, 0n);
  const c = bins.reduce((a, b) => a + b.cost, 0n);
  if (t !== tokens || c !== cost)
    throw new RangeError(
      `the lot's bins hold ${t} for ${c}, not the view's ${tokens} for ${cost}`,
    );
  return cloneLot(lot);
}

/** An `eth_call` at a block: dex-lib's `provider.call`, or any RPC. */
export type EthCall = (
  to: string,
  data: string,
  blockNumber: number | 'latest',
) => Promise<string>;

/** Every view a launch's state needs, at one block, → the pool state (the token's live supply included). */
export async function readPoolState(
  call: EthCall,
  floorAmm: string,
  token: string,
  id: bigint,
  blockNumber: number | 'latest',
): Promise<PoolState> {
  const view = async (
    to: string,
    sig: string,
    args: AbiValue[],
    out: readonly string[],
  ): Promise<AbiValue[]> =>
    decode(out, await call(to, calldata(sig, args), blockNumber));
  const [st, spec, market, alloc, refs, slot, total, dead, option, qi] =
    await Promise.all([
      view(floorAmm, FN.launchState, [id], OUT.launchState),
      view(floorAmm, FN.launchSpec, [id], OUT.launchSpec),
      view(floorAmm, FN.launchMarket, [id], OUT.launchMarket),
      view(floorAmm, FN.creatorAlloc, [id], OUT.creatorAlloc),
      view(floorAmm, FN.creatorRefs, [id], OUT.creatorRefs),
      view(floorAmm, FN.teamSlot, [id], OUT.teamSlot),
      view(token, FN.totalSupply, [], OUT.totalSupply),
      view(token, FN.balanceOf, [DEAD], OUT.balanceOf),
      view(floorAmm, FN.tokenOptionState, [id], OUT.tokenOptionState),
      view(floorAmm, FN.launchQuoteInfo, [id], OUT.launchQuoteInfo),
    ]);
  const o = option[0] as AbiValue[];
  // the tail range: optional (a contract without the view, or before the end, reads as none)
  let tail: [bigint, bigint, bigint, bigint] | undefined;
  try {
    const t = (await view(
      floorAmm,
      FN.launchTail,
      [id],
      OUT.launchTail,
    )) as bigint[];
    tail = [t[0], t[1], t[2], t[3]];
  } catch {
    tail = undefined;
  }
  // the launch's own Milestones bound: optional (a contract without the view reads as the general bound)
  let msLiveMaxBps: number | undefined;
  try {
    const b = await view(
      floorAmm,
      FN.launchMsLiveMaxBps,
      [id],
      OUT.launchMsLiveMaxBps,
    );
    msLiveMaxBps = Number(b[0] as bigint);
  } catch {
    msLiveMaxBps = undefined;
  }
  const v = st[0] as AbiValue[];
  const members = (slot[0] as AbiValue[])[6] as AbiValue[][];
  const quote = (v[LV.quote] as string).toLowerCase();
  const quoteDecimals =
    quote === NATIVE
      ? 18
      : Number((await view(quote, FN.decimals, [], OUT.decimals))[0]);
  const launch = launchFromChain({
    view: v,
    spec: spec[0] as string,
    schedule: market[3] as string,
    creatorAlloc: [
      alloc[0] as bigint,
      alloc[1] as bigint,
      alloc[2] as bigint,
      alloc[4] as boolean,
    ],
    tokenOption: [Number(o[2] as bigint), o[5] as bigint],
    books: [
      ...(market[0] as bigint[]),
      market[1] as bigint,
      market[2] as bigint,
    ],
    creatorRefs: refs[0] as string[],
    slotPaid: members.map(m => m[3] as bigint),
    slotBought: (slot[0] as AbiValue[])[4] as bigint,
    quoteDecimals,
    tail,
    quoteUsdCentsX64: qi[1] as bigint,
    msLiveMaxBps,
  });
  return {
    launch,
    liveSupply: (total[0] as bigint) - (dead[0] as bigint),
    quoteDecimals,
    slotPaid: members.map(m => m[3] as bigint),
    slotBought: (slot[0] as AbiValue[])[4] as bigint,
    diverged: false,
  };
}

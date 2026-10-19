// ONE launch's market, kept by events (dex-lib's `StatefulEventSubscriber`): `generateState` reads FloorAmm's views
// (`launch-state.ts`); `processLog` REPLAYS each `Trade` through the reference trade (`math/launch.ts`) — a buy of
// `quoteGross + refund` at the log's block (the snipe cap counts blocks), a sell of `tokens` — and holds the replay to
// the event's own state after (the books' price, `f`, F, C, the tokens held, `S_out`). `PotsMoved` is the chain's word on the
// pots and the lot; a burn (a Transfer to 0x0 or to `0x…dEaD`) lowers the live supply (count burns). A replay that
// disagrees marks the state `diverged` and the dex prices nothing for it until `generateState` runs again.

import { liqPerChain, perChain, sqrtPerChain } from './units';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import type { IDexHelper } from '../../dex-helper/idex-helper';
import type { DeepReadonly } from 'ts-essentials';
import type { BlockHeader, Log, Logger } from '../../types';
import {
  cloneLaunch,
  held,
  launchBuy,
  launchSOut,
  launchSell,
  launchFloorX64,
  tokenOptionState,
} from './math/launch';
import { slotWeights } from './math/fees';
import { priceX64 } from './math/schedule';
import { DEAD, EV_DATA, TOPIC, decode, topicAddress, topicUint } from './abi';
import { eventTopic } from './evm/abi';
import { readPoolState } from './launch-state';
import { cloneLot, lotBinsInUse } from './math/lot';
import type { Lot } from './math/lot';
import type { LaunchMeta, PoolState } from './types';

const ZERO = '0x0000000000000000000000000000000000000000';

export class FloorAmmEventPool extends StatefulEventSubscriber<PoolState> {
  readonly floorAmm: string;
  readonly meta: LaunchMeta;
  /** The bought-back lot's bins of the last state this pool held in step with the chain (no view returns them). */
  private knownLot: Lot | null = null;

  constructor(
    dexKey: string,
    dexHelper: IDexHelper,
    floorAmm: string,
    meta: LaunchMeta,
    logger: Logger,
  ) {
    super(
      dexKey,
      `${dexKey}_${floorAmm}_${meta.id}`.toLowerCase(),
      dexHelper,
      logger,
    );
    this.floorAmm = floorAmm.toLowerCase();
    this.meta = meta;
    this.addressesSubscribed = [this.floorAmm, meta.token.toLowerCase()];
  }

  async generateState(
    blockNumber: number | 'latest' = 'latest',
  ): Promise<DeepReadonly<PoolState>> {
    const call = (to: string, data: string, at: number | 'latest') =>
      this.dexHelper.provider.call({ to, data }, at);
    const st = await readPoolState(
      call,
      this.floorAmm,
      this.meta.token,
      this.meta.id,
      blockNumber,
    );
    // the views carry the lot's totals, not its bins: keep the bins the replay holds while their totals are the view's
    const k = this.knownLot;
    if (k !== null && st.launch.lot.len === 0) {
      const bins = lotBinsInUse(k);
      const t = bins.reduce((a, b) => a + b.tokens, 0n);
      const c = bins.reduce((a, b) => a + b.cost, 0n);
      if (t === st.launch.lotTokens && c === st.launch.lotCost && t > 0n)
        st.launch.lot = cloneLot(k);
    }
    this.knownLot = cloneLot(st.launch.lot);
    return st as DeepReadonly<PoolState>;
  }

  processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
    _blockHeader?: Readonly<BlockHeader>,
  ): DeepReadonly<PoolState> | null {
    const next = applyLog(
      this.floorAmm,
      this.meta,
      state as PoolState,
      log,
      m => this.logger.warn(`${this.name}: ${m}`),
    );
    if (next !== null && !next.diverged)
      this.knownLot = cloneLot(next.launch.lot);
    return next as DeepReadonly<PoolState> | null;
  }
}

/**
 * ⛔ One log on one launch's state — pure (the event pool's `processLog`): the next
 * state, or `null` when the log does not touch it. `warn` hears why a replay was refused (`diverged`).
 */
export function applyLog(
  floorAmm: string,
  meta: LaunchMeta,
  s: PoolState,
  log: Readonly<Log>,
  warn: (m: string) => void = () => {},
): PoolState | null {
  const addr = log.address.toLowerCase();
  const t0 = log.topics[0];
  if (addr === meta.token.toLowerCase()) {
    if (t0 !== TOPIC.Transfer) return null;
    const to = topicAddress(log.topics[2]);
    if (to !== ZERO && to !== DEAD) return null;
    const [v] = decode(EV_DATA.Transfer, log.data) as bigint[];
    return { ...s, liveSupply: s.liveSupply - v };
  }
  if (
    addr !== floorAmm.toLowerCase() ||
    log.topics.length < 2 ||
    topicUint(log.topics[1]) !== meta.id
  )
    return null;
  if (s.diverged) return null;
  if (t0 === TOPIC.Trade) return onTrade(s, log, warn);
  if (t0 === TOPIC.PotsMoved) {
    const [floor, cushion, bidSqrtX64, liq, lotTokens, lotCost] = decode(
      EV_DATA.PotsMoved,
      log.data,
    ) as bigint[];
    const k = scaleOf(s.launch);
    if (k === 1n) {
      const launch = cloneLaunch(s.launch);
      launch.pots = { floor, cushion, bidSqrtX64, liq };
      launch.lotTokens = lotTokens;
      launch.lotCost = lotCost;
      return { ...s, launch };
    }
    // a scaled launch publishes the curve per chain unit (`units.ts`), which cannot be inverted exactly: the replayed
    // math state stands when it publishes as the event, else the pool is refetched
    const p = s.launch.pots;
    const same =
      p.floor === floor &&
      p.cushion === cushion &&
      sqrtPerChain(k, p.bidSqrtX64) === bidSqrtX64 &&
      liqPerChain(k, p.liq) === liq &&
      s.launch.lotTokens * k === lotTokens &&
      s.launch.lotCost === lotCost;
    if (same) return null;
    warn(
      `PotsMoved at block ${log.blockNumber} differs from the replayed state; pricing paused until regenerated`,
    );
    return { ...s, diverged: true };
  }
  if (t0 === TOPIC.TeamSlotOpened) {
    const [rateBps] = decode(EV_DATA.TeamSlotOpened, log.data) as bigint[];
    const launch = cloneLaunch(s.launch);
    launch.slotRateBps = Number(rateBps);
    return { ...s, launch };
  }
  if (t0 === TOPIC.TeamSlotMember) {
    // a member written (requested, paid, cancelled): its `paid`, and the slot's `bought` / `boughtPpm` after it. The
    // payment itself books the platform bucket, so the pots do not move; the members' weights are re-derived as the
    // contract does (a free slot: `slot_weights(paid)`, the shares; none yet → the whole take is place 0's)
    const d = decode(EV_DATA.TeamSlotMember, log.data);
    const index = Number(d[0] as bigint);
    const [paid, , bought, boughtPpm] = d.slice(4) as bigint[];
    const slotPaid = [...s.slotPaid];
    slotPaid[index] = paid;
    const launch = cloneLaunch(s.launch);
    launch.slotBoughtPpm = Number(boughtPpm);
    try {
      launch.slotWeights =
        launch.slotRateBps > 0 ? slotWeights(slotPaid) : [0, 0, 0, 0, 0];
    } catch {
      warn(
        `TeamSlotMember at block ${log.blockNumber} does not re-derive; pricing paused until regenerated`,
      );
      return { ...s, diverged: true };
    }
    return { ...s, launch, slotPaid, slotBought: bought };
  }
  if (t0 === TOPIC.CreatorAllocUnlocked) {
    // the Token Option: ONE release of the free allocation leaves the hold (it joins S_out); chain units. The release is the next one
    // the replayed state expects (its index and its tokens), its clock the event's
    const [tokens, , index, , nextAt] = decode(
      EV_DATA.CreatorAllocUnlocked,
      log.data,
    ) as bigint[];
    const launch = cloneLaunch(s.launch);
    const k = scaleOf(launch);
    const o = tokenOptionState(launch, 0n);
    if (
      Number(index) === launch.allocReleasesDone &&
      o.nextReleaseTokens * k === tokens &&
      tokens > 0n
    ) {
      launch.creatorAlloc -= tokens / k;
      launch.allocReleasesDone += 1;
      launch.allocNextReleaseAt = nextAt;
      return { ...s, launch };
    }
    warn(
      `CreatorAllocUnlocked at block ${log.blockNumber} differs from the replayed state; pricing paused until regenerated`,
    );
    return { ...s, diverged: true };
  }
  if (NO_STATE.has(t0)) return null;
  // ⛔ the safety net: an event this replay does not know may move what a trade reads — refetch the views
  warn(
    `unknown event ${t0} at block ${log.blockNumber}; pricing paused until regenerated`,
  );
  return { ...s, diverged: true };
}

/**
 * The FloorAmm events `applyLog` takes no state from: those indexed by a launch whose effect a replayed `Trade` already
 * carries or that a trade never reads (`LaunchCreated`, `Graduated`, `ScheduleDone`, `PotsSwept`, `CreatorBuyUnlocked`,
 * the creator's locked buy being outside `held`, and `TradeCredits`), and those indexed by something else (a wallet, a
 * quote, a preset id, a handle), whose first topic may equal a launch id by accident. Any other event of this launch marks
 * the pool diverged.
 */
const NO_STATE = new Set<string>(
  [
    TOPIC.LaunchCreated,
    TOPIC.Graduated,
    TOPIC.ScheduleDone,
    TOPIC.PotsSwept,
    TOPIC.CreatorBuyUnlocked,
    TOPIC.TradeCredits,
  ].concat(
    [
      'Claimed(address,address,address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
      'ClaimSkipped(address,address,uint256)',
      'PlatformWithdrawn(address,address,uint256,uint256)',
      'TreasurySet(address,address)',
      'ConfigWritten(address,address,address,address,bool,address)',
      'HandleBound(bytes32,address,uint256)',
      'TraderRefOpened(address,address[3])',
      'TraderListSet(address,uint16)',
      'PayoutOwed(address,address,uint256)',
      'PayoutClaimed(address,address,address,address,uint256)',
      'QuoteCapSet(address,uint128)',
      'PresetWritten(uint8,uint32,bool,bool)',
      'QuoteWritten(address,bool,uint256,uint256)',
      // the proxy's own (ERC-1967)
      'Upgraded(address)',
      'AdminChanged(address,address)',
      'Initialized(uint64)',
    ].map(eventTopic),
  ),
);

/** Chain token base units per math unit (1 for an unscaled launch). */
const scaleOf = (l: { tokenScale: bigint }): bigint =>
  l.tokenScale > 0n ? l.tokenScale : 1n;

function onTrade(
  s: PoolState,
  log: Readonly<Log>,
  warn: (m: string) => void,
): PoolState {
  const d = decode(EV_DATA.Trade, log.data);
  const [isBuy, gross, net, refund, tokens] = d as [
    boolean,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const [
    priceAfter,
    floorAfter,
    floor,
    cushion,
    reserveTokens,
    sOut,
    floorToken,
  ] = d.slice(10) as bigint[];
  const launch = cloneLaunch(s.launch);
  let ok: boolean;
  try {
    if (isBuy) {
      const r = launchBuy(
        launch,
        gross + refund,
        BigInt(log.blockNumber),
        s.liveSupply,
      );
      ok =
        r.out === tokens &&
        r.refund === refund &&
        r.spent === gross &&
        r.take.floorToken === floorToken;
    } else {
      const r = launchSell(launch, tokens, s.liveSupply);
      ok =
        r.payout === net &&
        r.gross === gross &&
        r.take.floorToken === floorToken;
    }
    // the event's tokens are chain units and its prices per chain unit (`units.ts`)
    const k = scaleOf(launch);
    ok =
      ok &&
      perChain(k, priceX64(launch.st)) === priceAfter &&
      perChain(k, launchFloorX64(launch)) === floorAfter &&
      launch.pots.floor === floor &&
      launch.pots.cushion === cushion &&
      held(launch) * k === reserveTokens &&
      launchSOut(launch) * k === sOut;
  } catch (e) {
    warn(`replay threw at block ${log.blockNumber}: ${String(e)}`);
    ok = false;
  }
  if (!ok) {
    warn(
      `the math's replay disagrees with Trade at block ${log.blockNumber} (tx ${
        log.transactionHash ?? '?'
      }); pricing paused until regenerated`,
    );
    return { ...s, diverged: true };
  }
  return { ...s, launch };
}

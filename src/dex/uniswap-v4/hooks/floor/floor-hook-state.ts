import { Interface } from 'ethers/lib/utils';
import { BytesLike } from 'ethers';
import { DeepReadonly } from 'ts-essentials';
import {
  InitializeStateOptions,
  StatefulEventSubscriber,
} from '../../../../stateful-event-subscriber';
import { IDexHelper } from '../../../../dex-helper';
import { BlockHeader, Logger, Log } from '../../../../types';
import { MultiCallParams, MultiResult } from '../../../../lib/multi-wrapper';
import { extractSuccessAndValue } from '../../../../lib/decoders';
import FloorHookABI from '../../../../abi/uniswap-v4/hooks/floor/floor-hook.abi.json';
import FloorStairsABI from '../../../../abi/uniswap-v4/hooks/floor/floor-stairs.abi.json';
import UniswapV4PoolManagerABI from '../../../../abi/uniswap-v4/pool-manager.abi.json';
import { FloorHookConfig } from './config';
import { FloorHookState, FloorPoolHookState } from './types';

// Hook events after which a pool's floor, cushion or rates may have moved
const REFRESH_EVENTS = [
  'PoolRegistered',
  'Ratcheted',
  'BidReplaced',
  'Seeded',
  'LadderSeeded',
  'CushionPlaced',
  'CushionParked',
  'StairsPlaced',
  'StairsCollected',
  'VaultTokensFed',
  'ReserveSplit',
];

/**
 * Per-pool state of the FLOOR hook that its swap fees read: the rates,
 * the floor tick, the quote's side and the staircase cushion.
 *
 * Any hook event keyed by a tracked pool that may move them, and any
 * PoolManager ModifyLiquidity on a tracked pool (every bid, cushion and
 * staircase move is one), re-reads that pool's state at the block.
 */
export class FloorHookStateSubscriber extends StatefulEventSubscriber<FloorHookState> {
  readonly hookAddress: string;

  readonly poolManagerAddress: string;

  protected poolIds: Set<string> = new Set();

  // pools whose state could not be read yet; retried on the next block
  protected pendingPoolIds: Set<string> = new Set();

  private readonly refreshTopics: Set<string>;

  private readonly modifyLiquidityTopic: string;

  constructor(
    readonly parentName: string,
    protected network: number,
    protected dexHelper: IDexHelper,
    logger: Logger,
    readonly hookIface = new Interface(FloorHookABI),
    readonly stairsIface = new Interface(FloorStairsABI),
    readonly poolManagerIface = new Interface(UniswapV4PoolManagerABI),
  ) {
    super(parentName, 'FloorHookState', dexHelper, logger, false);

    this.hookAddress = FloorHookConfig[network].hookAddress.toLowerCase();
    this.poolManagerAddress =
      FloorHookConfig[network].poolManagerAddress.toLowerCase();

    this.refreshTopics = new Set(
      REFRESH_EVENTS.map(name =>
        this.hookIface.getEventTopic(name).toLowerCase(),
      ),
    );
    this.modifyLiquidityTopic = this.poolManagerIface
      .getEventTopic('ModifyLiquidity')
      .toLowerCase();

    this.addressesSubscribed = [this.hookAddress, this.poolManagerAddress];
  }

  async initialize(
    blockNumber: number,
    options?: InitializeStateOptions<FloorHookState>,
  ) {
    return super.initialize(blockNumber, options);
  }

  addPoolId(poolId: string) {
    const id = poolId.toLowerCase();
    if (this.poolIds.has(id)) return;
    this.poolIds.add(id);

    // read on the next block that has logs for the hook or the PoolManager
    if (this.isInitialized) this.pendingPoolIds.add(id);
  }

  getPoolState(poolId: string): DeepReadonly<FloorPoolHookState> | null {
    const state = this.getStaleState();
    return state?.pools[poolId.toLowerCase()] ?? null;
  }

  protected processLog(
    _state: DeepReadonly<FloorHookState>,
    _log: Readonly<Log>,
  ): DeepReadonly<FloorHookState> | null {
    // logs are handled per block in processBlockLogs
    return null;
  }

  protected async processBlockLogs(
    state: DeepReadonly<FloorHookState>,
    logs: Readonly<Log>[],
    blockHeader: Readonly<BlockHeader>,
  ): Promise<DeepReadonly<FloorHookState> | null> {
    const touched = new Set(this.pendingPoolIds);

    for (const log of logs) {
      const poolId = this.poolIdToRefresh(log);
      if (poolId && this.poolIds.has(poolId)) touched.add(poolId);
    }

    if (touched.size === 0) return null;

    const ids = Array.from(touched);
    const fetched = await this.fetchPoolStates(ids, blockHeader.number);

    const pools = { ...state.pools };
    for (const id of ids) {
      if (fetched[id]) {
        pools[id] = fetched[id];
        this.pendingPoolIds.delete(id);
      } else {
        // never price a pool on state that may be stale
        delete pools[id];
        this.pendingPoolIds.add(id);
      }
    }

    return { pools };
  }

  async generateState(
    blockNumber: number | 'latest' = 'latest',
  ): Promise<DeepReadonly<FloorHookState>> {
    const ids = Array.from(this.poolIds);
    const pools = await this.fetchPoolStates(ids, blockNumber);

    for (const id of ids) {
      if (pools[id]) this.pendingPoolIds.delete(id);
      else this.pendingPoolIds.add(id);
    }

    return { pools };
  }

  private poolIdToRefresh(log: Readonly<Log>): string | null {
    const address = log.address.toLowerCase();
    const topic0 = log.topics[0]?.toLowerCase();
    const topic1 = log.topics[1]?.toLowerCase();

    if (!topic0 || !topic1) return null;

    if (address === this.hookAddress && this.refreshTopics.has(topic0)) {
      return topic1;
    }

    if (
      address === this.poolManagerAddress &&
      topic0 === this.modifyLiquidityTopic
    ) {
      return topic1;
    }

    return null;
  }

  async fetchPoolStates(
    poolIds: string[],
    blockNumber: number | 'latest',
  ): Promise<Record<string, FloorPoolHookState>> {
    if (poolIds.length === 0) return {};

    const stairsCallData = this.stairsIface.encodeFunctionData('stairs');

    const calls: MultiCallParams<any>[] = [];
    for (const poolId of poolIds) {
      calls.push({
        target: this.hookAddress,
        callData: this.hookIface.encodeFunctionData('poolState', [poolId]),
        decodeFunction: (result: MultiResult<BytesLike> | BytesLike) => {
          const [, data] = extractSuccessAndValue(result);
          return this.hookIface.decodeFunctionResult('poolState', data)[0];
        },
      });
      calls.push({
        target: this.hookAddress,
        callData: this.hookIface.encodeFunctionData('execute', [
          poolId,
          stairsCallData,
        ]),
        decodeFunction: (result: MultiResult<BytesLike> | BytesLike) => {
          const [, data] = extractSuccessAndValue(result);
          const [bytes] = this.hookIface.decodeFunctionResult('execute', data);
          return this.stairsIface.decodeFunctionResult('stairs', bytes)[0];
        },
      });
    }

    const results = await this.dexHelper.multiWrapper.tryAggregate<any>(
      false,
      calls,
      blockNumber,
      this.dexHelper.multiWrapper.defaultBatchSize,
      false,
    );

    const pools: Record<string, FloorPoolHookState> = {};

    poolIds.forEach((poolId, i) => {
      const st = results[2 * i];
      const stairs = results[2 * i + 1];

      if (!st.success || !stairs.success) {
        this.logger.warn(
          `${this.parentName}: could not read FLOOR hook state of pool ${poolId} on block ${blockNumber}`,
        );
        return;
      }

      pools[poolId.toLowerCase()] = toPoolHookState(
        st.returnData,
        stairs.returnData,
      );
    });

    return pools;
  }
}

export function toPoolHookState(
  poolState: any,
  stairs: any,
): FloorPoolHookState {
  return {
    quoteIsCurrency1: Boolean(poolState.quoteIsCurrency1),
    floorTick: Number(poolState.floorTick),
    tickSpacing: Number(poolState.tickSpacing),
    rates: {
      skimBuyFarBps: Number(poolState.skimBuyFarBps),
      skimSellFarBps: Number(poolState.skimSellFarBps),
      skimBuyAtFloorBps: Number(poolState.skimBuyAtFloorBps),
      skimSellAtFloorBps: Number(poolState.skimSellAtFloorBps),
      creatorBuyBps: Number(poolState.creatorBuyBps),
      creatorSellBps: Number(poolState.creatorSellBps),
      holderBuyBps: Number(poolState.holderBuyBps),
      holderSellBps: Number(poolState.holderSellBps),
      teamFeeBps: Number(poolState.teamFeeBps),
    },
    cushionLower: Number(stairs.cushionLower),
    cushionLiq: BigInt(stairs.cushionLiq.toString()),
  };
}

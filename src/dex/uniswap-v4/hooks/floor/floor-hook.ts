import { Interface } from 'ethers/lib/utils';
import { BytesLike } from 'ethers';
import { DeepReadonly } from 'ts-essentials';
import { IDexHelper } from '../../../../dex-helper';
import { Network } from '../../../../constants';
import { Logger } from '../../../../types';
import { MultiCallParams, MultiResult } from '../../../../lib/multi-wrapper';
import { extractSuccessAndValue } from '../../../../lib/decoders';
import FloorHookABI from '../../../../abi/uniswap-v4/hooks/floor/floor-hook.abi.json';
import FloorRegistryABI from '../../../../abi/uniswap-v4/hooks/floor/floor-registry.abi.json';
import { PoolKey, SubgraphPool } from '../../types';
import { LPFeeLibrary } from '../../contract-math/LPFeeLibrary';
import { toId } from '../../utils';
import {
  BalanceDelta,
  BeforeSwapDelta,
  HookSwapContext,
  HooksPermissions,
  IBaseHook,
  SwapParams,
} from '../types';
import { FloorHookConfig } from './config';
import { FloorHookStateSubscriber } from './floor-hook-state';
import {
  dearEdge,
  FLOOR_LP_FEE,
  gapSkimBps,
  marketTick,
  skimBpsAt,
  takeFees,
} from './floor-hook-math';
import { FloorPoolHookState, HookParams } from './types';

const BEFORE_SWAP_SELECTOR = '0x575e24b4';

const REGISTRY_PAGE_SIZE = 500;

/**
 * The FLOOR hook (SingletonFloorHook): exact input only. A buy (quote in)
 * pays the skim, creator, holder and platform fees off the quote paid in,
 * before the swap, at the skim rate of the pre-swap price (scaled by the
 * cushion gap where the network has it). A sell pays the same four fees
 * off the quote paid out, after the swap, at the skim rate of the post-swap
 * price. The LP fee is overridden to 0.25% on every swap.
 */
export class FloorHook implements IBaseHook {
  readonly name = this.constructor.name;
  readonly address: string;
  readonly config: HookParams;
  readonly hookState: FloorHookStateSubscriber;
  // V4Quoter's estimates on BSC: 283k to 354k
  readonly swapGasCost = 350_000;

  private readonly hookIface = new Interface(FloorHookABI);
  private readonly registryIface = new Interface(FloorRegistryABI);

  constructor(
    readonly dexHelper: IDexHelper,
    readonly network: Network,
    readonly logger: Logger,
  ) {
    this.config = FloorHookConfig[network];
    this.address = this.config.hookAddress.toLowerCase();

    this.hookState = new FloorHookStateSubscriber(
      this.name,
      network,
      dexHelper,
      logger,
    );
  }

  registerPool(poolId: string, _poolKey: PoolKey) {
    this.hookState.addPoolId(poolId);
  }

  async initialize(blockNumber: number) {
    if (!this.hookState.isInitialized) {
      await this.hookState.initialize(blockNumber);
    }
  }

  getHookPermissions(): HooksPermissions {
    return {
      beforeInitialize: true,
      afterInitialize: false,
      beforeAddLiquidity: false,
      afterAddLiquidity: false,
      beforeRemoveLiquidity: false,
      afterRemoveLiquidity: false,
      beforeSwap: true,
      afterSwap: true,
      beforeDonate: false,
      afterDonate: false,
      beforeSwapReturnDelta: true,
      afterSwapReturnDelta: true,
      afterAddLiquidityReturnDelta: false,
      afterRemoveLiquidityReturnDelta: false,
    };
  }

  beforeSwap(
    _sender: string,
    key: PoolKey,
    params: SwapParams,
    _hookData: string,
    context?: HookSwapContext,
  ): [string, BeforeSwapDelta, number] {
    if (BigInt(params.amountSpecified) > 0n) {
      throw new Error(`${this.name}: ExactOutNotSupported`);
    }

    const state = this.getPoolHookState(key);
    const fee = Number(FLOOR_LP_FEE | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    const isBuy = params.zeroForOne !== state.quoteIsCurrency1;

    // a sell's fees are taken in afterSwap, off the quote paid out
    if (!isBuy) {
      return [
        BEFORE_SWAP_SELECTOR,
        { deltaSpecified: 0n, deltaUnspecified: 0n },
        fee,
      ];
    }

    if (!context) {
      throw new Error(`${this.name}: beforeSwap needs the pool's state`);
    }

    const preTick = marketTick(
      Number(context.poolState.slot0.tick),
      state.quoteIsCurrency1,
    );
    const quoteIn = -BigInt(params.amountSpecified);
    const total = takeFees(
      true,
      quoteIn,
      this.buySkimBps(state, preTick),
      state.rates,
    );

    return [
      BEFORE_SWAP_SELECTOR,
      { deltaSpecified: total, deltaUnspecified: 0n },
      fee,
    ];
  }

  afterSwap(
    _sender: string,
    key: PoolKey,
    params: SwapParams,
    delta: BalanceDelta,
    _hookData: string,
    context?: HookSwapContext,
  ): bigint {
    const { zeroForOne } = params;
    const isExactInput = BigInt(params.amountSpecified) < 0n;

    const outputIsToken1 = isExactInput === zeroForOne;
    const unspecifiedDelta = outputIsToken1 ? delta.amount1 : delta.amount0;
    const output = unspecifiedDelta < 0n ? -unspecifiedDelta : unspecifiedDelta;

    const state = this.getPoolHookState(key);
    const isBuy = zeroForOne !== state.quoteIsCurrency1;

    // a buy's fees were taken in beforeSwap
    if (isBuy || output === 0n) return output;

    if (context?.tickAfter === undefined) {
      throw new Error(`${this.name}: afterSwap needs the post-swap tick`);
    }

    const postTick = marketTick(
      Number(context.tickAfter),
      state.quoteIsCurrency1,
    );
    const bps = skimBpsAt(
      false,
      dearEdge(state.floorTick, state.tickSpacing) - postTick,
      state.rates,
    );

    return output - takeFees(false, output, bps, state.rates);
  }

  /**
   * Every FLOOR pool: the registry's launches on this hook, each one's pool
   * id from the hook (poolForAccount, zero before graduation) and its key
   * from poolState.
   */
  async getPools(blockNumber: number): Promise<SubgraphPool[]> {
    const multiWrapper = this.dexHelper.multiWrapper;
    const registry = this.config.registryAddress;

    const [countResult] = await multiWrapper.tryAggregate<bigint>(
      true,
      [
        {
          target: registry,
          callData: this.registryIface.encodeFunctionData('count'),
          decodeFunction: (result: MultiResult<BytesLike> | BytesLike) => {
            const [, data] = extractSuccessAndValue(result);
            return BigInt(
              this.registryIface.decodeFunctionResult('count', data)[0],
            );
          },
        },
      ],
      blockNumber,
    );
    const count = Number(countResult.returnData);

    const pageCalls: MultiCallParams<string[]>[] = [];
    for (let start = 0; start < count; start += REGISTRY_PAGE_SIZE) {
      pageCalls.push({
        target: registry,
        callData: this.registryIface.encodeFunctionData('page', [
          start,
          REGISTRY_PAGE_SIZE,
        ]),
        decodeFunction: (result: MultiResult<BytesLike> | BytesLike) => {
          const [, data] = extractSuccessAndValue(result);
          const [entries] = this.registryIface.decodeFunctionResult(
            'page',
            data,
          );
          return entries
            .filter((entry: any) => entry.hook.toLowerCase() === this.address)
            .map((entry: any) => entry.launch.toLowerCase());
        },
      });
    }
    const pages = await multiWrapper.tryAggregate<string[]>(
      true,
      pageCalls,
      blockNumber,
    );
    const launches = pages.flatMap(page => page.returnData);

    const idResults = await multiWrapper.tryAggregate<string>(
      false,
      launches.map(launch => ({
        target: this.address,
        callData: this.hookIface.encodeFunctionData('poolForAccount', [launch]),
        decodeFunction: (result: MultiResult<BytesLike> | BytesLike) => {
          const [, data] = extractSuccessAndValue(result);
          return String(
            this.hookIface.decodeFunctionResult('poolForAccount', data)[0],
          ).toLowerCase();
        },
      })),
      blockNumber,
      multiWrapper.defaultBatchSize,
      false,
    );
    const poolIds = idResults
      .filter(r => r.success && BigInt(r.returnData) !== 0n)
      .map(r => r.returnData);

    const keyResults = await multiWrapper.tryAggregate<any>(
      false,
      poolIds.map(poolId => ({
        target: this.address,
        callData: this.hookIface.encodeFunctionData('poolState', [poolId]),
        decodeFunction: (result: MultiResult<BytesLike> | BytesLike) => {
          const [, data] = extractSuccessAndValue(result);
          return this.hookIface.decodeFunctionResult('poolState', data)[0];
        },
      })),
      blockNumber,
      multiWrapper.defaultBatchSize,
      false,
    );

    const pools: SubgraphPool[] = [];
    keyResults.forEach((result, i) => {
      if (!result.success || !result.returnData.poolBound) return;

      const key = result.returnData.poolKey;
      const pool: SubgraphPool = {
        id: poolIds[i],
        fee: key.fee.toString(),
        hooks: key.hooks.toLowerCase(),
        token0: { address: key.currency0.toLowerCase() },
        token1: { address: key.currency1.toLowerCase() },
        tickSpacing: key.tickSpacing.toString(),
      };

      // the key must hash to the hook's id for the pool
      const poolKey: PoolKey = {
        currency0: pool.token0.address,
        currency1: pool.token1.address,
        fee: pool.fee,
        tickSpacing: Number(pool.tickSpacing),
        hooks: pool.hooks,
      };
      if (
        toId(poolKey).toLowerCase() !== pool.id ||
        pool.hooks !== this.address
      ) {
        this.logger.warn(
          `${this.name}: pool ${pool.id} has a key that does not match it, skipping`,
        );
        return;
      }

      pools.push(pool);
    });

    return pools;
  }

  private buySkimBps(
    state: DeepReadonly<FloorPoolHookState>,
    preTick: number,
  ): number {
    const bps = skimBpsAt(
      true,
      dearEdge(state.floorTick, state.tickSpacing) - preTick,
      state.rates,
    );

    return this.config.gapSkim
      ? gapSkimBps(bps, state.cushionLower, state.cushionLiq, preTick)
      : bps;
  }

  private getPoolHookState(key: PoolKey): DeepReadonly<FloorPoolHookState> {
    const poolId = toId(key);
    const state = this.hookState.getPoolState(poolId);

    if (!state) {
      throw new Error(`${this.name}: no hook state for pool ${poolId}`);
    }

    return state;
  }
}

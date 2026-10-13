import { DeepReadonly } from 'ts-essentials';
import { PoolKey, PoolState, SubgraphPool } from '../types';
import { IDexHelper } from '../../../dex-helper';
import { Network } from '../../../constants';
import { Logger } from '../../../types';

export type HookConfig<HookParams> = {
  [network: number]: HookParams;
};

export interface BalanceDelta {
  amount0: bigint; // int128
  amount1: bigint; // int128
}

export interface BeforeSwapDelta {
  deltaSpecified: bigint; // int128
  deltaUnspecified: bigint; // int128
}

/**
 * Pool state handed to beforeSwap / afterSwap, standing in for the
 * PoolManager reads (extsload) a hook makes on chain.
 */
export interface HookSwapContext {
  // The pool's state before the swap
  poolState: DeepReadonly<PoolState>;
  // The pool's price and tick right after the swap (afterSwap only)
  sqrtPriceX96After?: bigint;
  tickAfter?: bigint;
}

export interface SwapParams {
  zeroForOne: boolean;
  amountSpecified: string; // int256
  sqrtPriceLimitX96: string; // uint160
}

export interface ModifyLiquidityParams {
  tickLower: number; // int24
  tickUpper: number; // int24
  liquidityDelta: string; // int256
  salt: string; // bytes32
}

export interface HooksPermissions {
  beforeInitialize: boolean;
  afterInitialize: boolean;
  beforeAddLiquidity: boolean;
  afterAddLiquidity: boolean;
  beforeRemoveLiquidity: boolean;
  afterRemoveLiquidity: boolean;
  beforeSwap: boolean;
  afterSwap: boolean;
  beforeDonate: boolean;
  afterDonate: boolean;
  beforeSwapReturnDelta: boolean;
  afterSwapReturnDelta: boolean;
  afterAddLiquidityReturnDelta: boolean;
  afterRemoveLiquidityReturnDelta: boolean;
}

export interface IBaseHook {
  readonly name: string;

  readonly address: string;

  // gas of a swap through the hook, where it differs from a plain v4 swap
  readonly swapGasCost?: number;

  getHookPermissions(): HooksPermissions;

  registerPool(poolId: string, poolKey: PoolKey): void;

  initialize(blockNumber: number): Promise<void>;

  /**
   * Pools the hook lists itself (e.g. from its own registry). They are
   * added to the pool list even on networks with a static pools list.
   */
  getPools?(blockNumber: number): Promise<SubgraphPool[]>;

  beforeInitialize?(sender: string, key: PoolKey, sqrtPriceX96: string): string; // bytes4

  afterInitialize?(
    sender: string,
    key: PoolKey,
    sqrtPriceX96: string,
    tick: number,
  ): string; // bytes4

  beforeAddLiquidity?(
    sender: string,
    key: PoolKey,
    params: ModifyLiquidityParams,
    hookData: string,
  ): string;

  beforeRemoveLiquidity?(
    sender: string,
    key: PoolKey,
    params: ModifyLiquidityParams,
    hookData: string,
  ): string;

  afterAddLiquidity?(
    sender: string,
    key: PoolKey,
    params: ModifyLiquidityParams,
    delta0: BalanceDelta,
    delta1: BalanceDelta,
    hookData: string,
  ): [string, BalanceDelta];

  afterRemoveLiquidity?(
    sender: string,
    key: PoolKey,
    params: ModifyLiquidityParams,
    delta0: BalanceDelta,
    delta1: BalanceDelta,
    hookData: string,
  ): [string, BalanceDelta];

  /**
   * Returns the selector, the hook's delta (applied to the amount to swap
   * when beforeSwapReturnDelta is set) and the LP fee (applied when it
   * carries LPFeeLibrary.OVERRIDE_FEE_FLAG on a dynamic-fee pool).
   * Throws where the hook reverts.
   */
  beforeSwap?(
    sender: string,
    key: PoolKey,
    params: SwapParams,
    hookData: string,
    context?: HookSwapContext,
  ): [string, BeforeSwapDelta, number]; // bytes4, BeforeSwapDelta, uint24

  /**
   * The hook implementing this method should return the final
   * modified amount exactly as swapExactAmountIn/Out would return
   */
  afterSwap?(
    sender: string,
    key: PoolKey,
    params: SwapParams,
    delta: BalanceDelta,
    hookData: string,
    context?: HookSwapContext,
  ): bigint; // int128

  beforeDonate?(
    sender: string,
    key: PoolKey,
    amount0: string,
    amount1: string,
    hookData: string,
  ): string;

  afterDonate?(
    sender: string,
    key: PoolKey,
    amount0: string,
    amount1: string,
    hookData: string,
  ): string;
}

export type HookConstructor = new (
  dexHelper: IDexHelper,
  network: Network,
  logger: Logger,
) => IBaseHook;

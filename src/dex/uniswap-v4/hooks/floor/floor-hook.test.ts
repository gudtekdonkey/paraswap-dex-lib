// npx jest src/dex/uniswap-v4/hooks/floor/floor-hook.test.ts
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Interface } from 'ethers/lib/utils';
import { SwapSide } from '@paraswap/core';
import { Network } from '../../../../constants';
import { IDexHelper } from '../../../../dex-helper';
import { Logger } from '../../../../types';
import { uniswapV4PoolMath } from '../../contract-math/uniswap-v4-pool-math';
import { Pool, PoolState, TickInfo } from '../../types';
import { toId } from '../../utils';
import { FloorHook } from './floor-hook';
import {
  bandTicks,
  dearEdge,
  gapSkimBps,
  marketTick,
  skimBpsAt,
  takeFees,
  GAP_SKIM_MAX_BPS,
  SKIM_RAMP_TICKS,
} from './floor-hook-math';
import { FloorHookState, FloorPoolHookState, FloorPoolRates } from './types';
import FloorHookABI from '../../../../abi/uniswap-v4/hooks/floor/floor-hook.abi.json';
import UniswapV4PoolManagerABI from '../../../../abi/uniswap-v4/pool-manager.abi.json';

// Snapshots of FLOOR pools, with Uniswap's V4Quoter answer for each swap
// (amountOut null: the quoter reverted): base-*.json recorded on a fork of
// Base at six pool states, live-*.json the live Base and BSC pools.
type FixtureCase = {
  state: string;
  block: string;
  poolId: string;
  snapshot: {
    pool: {
      sqrtPriceX96: string;
      tick: number;
      liquidity: string;
      tickSpacing: number;
      protocolFee: number;
      bitmap: [number, string][];
      liquidityNet: [number, string][];
    };
    quoteIsCurrency1: boolean;
    floorTick: number;
    rates: FloorPoolRates;
    cushion: { cushionLower: number; cushionLiq: string };
    gapSkim: boolean;
  };
  expected: {
    side: 'buy' | 'sell';
    amountIn: string;
    amountOut: string | null;
  }[];
};

type Fixture = {
  chainId: number;
  label: string;
  quote: string;
  cases: FixtureCase[];
};

const FIXTURES_DIR = join(__dirname, 'fixtures');
const fixtures: Fixture[] = readdirSync(FIXTURES_DIR)
  .filter(f => f.endsWith('.json'))
  .sort()
  .map(f => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')));

const HOOK = '0xe44886ffe0a894c6c5900d77a51c7d49732c60cc';
const DYNAMIC_FEE = '8388608';
const LOW_TOKEN = '0x0000000000000000000000000000000000000001';
const HIGH_TOKEN = '0xffffffffffffffffffffffffffffffffffffffff';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const dexHelper = {
  config: { isSlave: false, data: { network: Network.BASE } },
} as unknown as IDexHelper;

// The launch token's address is not in the snapshots: a token that sorts on
// the snapshot's side of the quote gives a key with the same orientation
function poolOf(f: Fixture, c: FixtureCase): Pool {
  const quote = f.quote.toLowerCase();
  const [currency0, currency1] = c.snapshot.quoteIsCurrency1
    ? [LOW_TOKEN, quote]
    : [quote, HIGH_TOKEN];
  const key = {
    currency0,
    currency1,
    fee: DYNAMIC_FEE,
    tickSpacing: c.snapshot.pool.tickSpacing,
    hooks: HOOK,
  };
  return { id: toId(key), key };
}

function poolStateOf(pool: Pool, c: FixtureCase): PoolState {
  const p = c.snapshot.pool;

  const ticks: Record<string, TickInfo> = {};
  for (const [tick, net] of p.liquidityNet) {
    const liquidityNet = BigInt(net);
    ticks[tick.toString()] = {
      liquidityGross: liquidityNet < 0n ? -liquidityNet : liquidityNet,
      liquidityNet,
    };
  }

  const tickBitmap: Record<string, bigint> = {};
  for (const [word, value] of p.bitmap) {
    tickBitmap[word.toString()] = BigInt(value);
  }

  return {
    id: pool.id,
    token0: pool.key.currency0,
    token1: pool.key.currency1,
    fee: pool.key.fee,
    hooks: pool.key.hooks,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
    liquidity: BigInt(p.liquidity),
    slot0: {
      sqrtPriceX96: BigInt(p.sqrtPriceX96),
      tick: BigInt(p.tick),
      protocolFee: BigInt(p.protocolFee),
      lpFee: 0n,
    },
    tickSpacing: p.tickSpacing,
    ticks,
    tickBitmap,
    isValid: true,
  };
}

function hookStateOf(c: FixtureCase): FloorPoolHookState {
  return {
    quoteIsCurrency1: c.snapshot.quoteIsCurrency1,
    floorTick: c.snapshot.floorTick,
    tickSpacing: c.snapshot.pool.tickSpacing,
    rates: c.snapshot.rates,
    cushionLower: c.snapshot.cushion.cushionLower,
    cushionLiq: BigInt(c.snapshot.cushion.cushionLiq),
  };
}

function hookWithState(pools: Record<string, FloorPoolHookState>): FloorHook {
  const hook = new FloorHook(dexHelper, Network.BASE, logger);
  hook.hookState.setState({ pools }, 1);
  return hook;
}

const RATES: FloorPoolRates = {
  skimBuyFarBps: 200,
  skimSellFarBps: 200,
  skimBuyAtFloorBps: 0,
  skimSellAtFloorBps: 300,
  creatorBuyBps: 75,
  creatorSellBps: 75,
  holderBuyBps: 0,
  holderSellBps: 0,
  teamFeeBps: 25,
};

describe('FloorHook', () => {
  it('has fixtures for a native quote and an ERC-20 quote on each side', () => {
    const orientations = new Set(
      fixtures.flatMap(f =>
        f.cases.map(
          c =>
            `${BigInt(f.quote) === 0n ? 'native' : 'erc20'}:${
              c.snapshot.quoteIsCurrency1
            }`,
        ),
      ),
    );
    expect([...orientations].sort()).toEqual([
      'erc20:false',
      'erc20:true',
      'native:false',
    ]);
    expect(
      fixtures.reduce(
        (n, f) => n + f.cases.reduce((m, c) => m + c.expected.length, 0),
        0,
      ),
    ).toBe(310);
  });

  describe('replays the V4Quoter through UniswapV4 pool math', () => {
    for (const f of fixtures) {
      for (const c of f.cases) {
        it(`${f.label}: ${c.state}`, () => {
          const pool = poolOf(f, c);
          const poolState = poolStateOf(pool, c);
          const hook = hookWithState({ [pool.id]: hookStateOf(c) });

          for (const e of c.expected) {
            // a buy pays the quote in; Velora's SELL side is exact input
            const zeroForOne =
              e.side === 'buy'
                ? !c.snapshot.quoteIsCurrency1
                : c.snapshot.quoteIsCurrency1;

            const [out] = uniswapV4PoolMath.queryOutputs(
              pool,
              poolState,
              [BigInt(e.amountIn)],
              zeroForOne,
              SwapSide.SELL,
              hook,
            );

            expect(`${e.side} ${e.amountIn}: ${out}`).toBe(
              `${e.side} ${e.amountIn}: ${e.amountOut ?? 0}`,
            );
          }
        });
      }
    }
  });

  it('does not leave the pool state changed by a quote', () => {
    const f = fixtures[0];
    const c = f.cases[f.cases.length - 1];
    const pool = poolOf(f, c);
    const poolState = poolStateOf(pool, c);
    const before = JSON.stringify(poolState, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    const hook = hookWithState({ [pool.id]: hookStateOf(c) });
    uniswapV4PoolMath.queryOutputs(
      pool,
      poolState,
      c.expected.map(e => BigInt(e.amountIn)),
      !c.snapshot.quoteIsCurrency1,
      SwapSide.SELL,
      hook,
    );
    const after = JSON.stringify(poolState, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(JSON.parse(after).slot0).toEqual(JSON.parse(before).slot0);
    expect(JSON.parse(after).liquidity).toEqual(JSON.parse(before).liquidity);
  });

  it('returns nothing for exact output (Velora BUY side)', () => {
    const f = fixtures[0];
    const c = f.cases[0];
    const pool = poolOf(f, c);
    const hook = hookWithState({ [pool.id]: hookStateOf(c) });

    expect(() =>
      uniswapV4PoolMath.queryOutputs(
        pool,
        poolStateOf(pool, c),
        [10n ** 18n],
        !c.snapshot.quoteIsCurrency1,
        SwapSide.BUY,
        hook,
      ),
    ).toThrow('ExactOutNotSupported');
  });

  it('prices nothing for a pool whose hook state is not known', () => {
    const f = fixtures[0];
    const c = f.cases[0];
    const pool = poolOf(f, c);
    const hook = hookWithState({});

    expect(() =>
      uniswapV4PoolMath.queryOutputs(
        pool,
        poolStateOf(pool, c),
        [10n ** 15n],
        !c.snapshot.quoteIsCurrency1,
        SwapSide.SELL,
        hook,
      ),
    ).toThrow('no hook state');
  });

  it('overrides the LP fee to 0.25% and takes a buy fees off the quote in', () => {
    const f = fixtures[0];
    const c = f.cases[0];
    const pool = poolOf(f, c);
    const poolState = poolStateOf(pool, c);
    const hook = hookWithState({ [pool.id]: hookStateOf(c) });

    const [, delta, fee] = hook.beforeSwap(
      '0x0000000000000000000000000000000000000000',
      pool.key,
      {
        zeroForOne: !c.snapshot.quoteIsCurrency1,
        amountSpecified: (-(10n ** 18n)).toString(),
        sqrtPriceLimitX96: '4295128740',
      },
      '0x',
      { poolState },
    );

    expect(fee).toBe(0x400000 | 2500);
    const pre = marketTick(c.snapshot.pool.tick, c.snapshot.quoteIsCurrency1);
    const bps = gapSkimBps(
      skimBpsAt(
        true,
        dearEdge(c.snapshot.floorTick, c.snapshot.pool.tickSpacing) - pre,
        c.snapshot.rates,
      ),
      c.snapshot.cushion.cushionLower,
      BigInt(c.snapshot.cushion.cushionLiq),
      pre,
    );
    expect(delta.deltaSpecified).toBe(
      takeFees(true, 10n ** 18n, bps, c.snapshot.rates),
    );
    expect(delta.deltaUnspecified).toBe(0n);
  });
});

describe('FLOOR hook math', () => {
  it('maps ticks to the engine frame', () => {
    expect(marketTick(100, false)).toBe(100);
    expect(marketTick(100, true)).toBe(-101);
    expect(marketTick(-1, true)).toBe(0);
    expect(bandTicks(60)).toBe(120);
    expect(bandTicks(200)).toBe(200);
    expect(dearEdge(177300, 60)).toBe(177180);
  });

  describe('skim', () => {
    it('ramps a buy from its at-floor rate at the bid to its far rate', () => {
      expect(skimBpsAt(true, 0, RATES)).toBe(0);
      expect(skimBpsAt(true, -500, RATES)).toBe(0);
      expect(skimBpsAt(true, SKIM_RAMP_TICKS, RATES)).toBe(200);
      expect(skimBpsAt(true, 100000, RATES)).toBe(200);
      // closeness 10000 - floor(8047 * 10000 / 16094) = 5000
      expect(skimBpsAt(true, 8047, RATES)).toBe(100);
      // closeness 10000 - floor(1 * 10000 / 16094) = 10000
      expect(skimBpsAt(true, 1, RATES)).toBe(0);
      // closeness 10000 - floor(16093 * 10000 / 16094) = 1
      expect(skimBpsAt(true, 16093, RATES)).toBe(200);
    });

    it('ramps a buy up toward the floor when its at-floor rate is higher', () => {
      const r = { ...RATES, skimBuyFarBps: 100, skimBuyAtFloorBps: 500 };
      expect(skimBpsAt(true, 0, r)).toBe(500);
      expect(skimBpsAt(true, 8047, r)).toBe(300);
      expect(skimBpsAt(true, SKIM_RAMP_TICKS, r)).toBe(100);
    });

    it('ramps a sell up toward the floor', () => {
      expect(skimBpsAt(false, 0, RATES)).toBe(300);
      expect(skimBpsAt(false, 8047, RATES)).toBe(250);
      expect(skimBpsAt(false, SKIM_RAMP_TICKS, RATES)).toBe(200);
      // 200 + floor(100 * 3786 / 10000): closeness 10000 - floor(10000 * 10000 / 16094)
      expect(skimBpsAt(false, 10000, RATES)).toBe(237);
    });

    it('keeps a sell flat when its far rate is at or above its at-floor rate', () => {
      const r = { ...RATES, skimSellFarBps: 300, skimSellAtFloorBps: 100 };
      expect(skimBpsAt(false, 0, r)).toBe(300);
      expect(skimBpsAt(false, 8047, r)).toBe(300);
    });
  });

  describe('gap skim', () => {
    const cushionLower = 200000;

    it('leaves the skim alone with no cushion standing', () => {
      expect(gapSkimBps(200, cushionLower, 0n, 0)).toBe(200);
    });

    it('leaves the skim alone at or under 2,232 ticks of gap', () => {
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower)).toBe(200);
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower - 2232)).toBe(200);
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower + 10)).toBe(200);
    });

    it('scales linearly between 2,232 and 5,109 ticks', () => {
      // m = 10000 + floor(5000 * 1 / 2877) = 10001
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower - 2233)).toBe(200);
      // m = 10000 + floor(5000 * 1438 / 2877) = 12499
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower - 3670)).toBe(249);
      // m = 10000 + floor(5000 * 2876 / 2877) = 14998
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower - 5108)).toBe(299);
    });

    it('applies the full 1.5x from 5,109 ticks', () => {
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower - 5109)).toBe(300);
      expect(gapSkimBps(200, cushionLower, 1n, cushionLower - 50000)).toBe(300);
      expect(gapSkimBps(333, cushionLower, 1n, cushionLower - 5109)).toBe(499);
    });

    it('caps a scaled skim at 1,500 bps', () => {
      expect(gapSkimBps(1200, cushionLower, 1n, cushionLower - 5109)).toBe(
        GAP_SKIM_MAX_BPS,
      );
      // an unscaled skim is not capped
      expect(gapSkimBps(2000, cushionLower, 1n, cushionLower)).toBe(2000);
    });
  });

  it('rounds each of the four fees down on its own', () => {
    // 999 * 200 / 10000 = 19, 999 * 75 / 10000 = 7, 0, 999 * 25 / 10000 = 2
    expect(takeFees(true, 999n, 200, RATES)).toBe(28n);
    expect(takeFees(false, 999n, 300, { ...RATES, holderSellBps: 100 })).toBe(
      29n + 7n + 9n + 2n,
    );
    expect(takeFees(true, 1n, 200, RATES)).toBe(0n);
  });
});

describe('FloorHookStateSubscriber', () => {
  const hookIface = new Interface(FloorHookABI);
  const poolManagerIface = new Interface(UniswapV4PoolManagerABI);
  const POOL_A = `0x${'aa'.repeat(32)}`;
  const POOL_B = `0x${'bb'.repeat(32)}`;
  const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

  const poolHookState = (floorTick: number): FloorPoolHookState => ({
    quoteIsCurrency1: false,
    floorTick,
    tickSpacing: 60,
    rates: RATES,
    cushionLower: 0,
    cushionLiq: 0n,
  });

  const log = (address: string, topic0: string, poolId: string) =>
    ({
      address,
      topics: [topic0, poolId],
      data: '0x',
      blockNumber: 2,
      transactionHash: '0x',
      logIndex: 0,
    } as any);

  const subscriber = () => {
    const hook = new FloorHook(dexHelper, Network.BASE, logger);
    hook.registerPool(POOL_A, {} as any);
    hook.registerPool(POOL_B, {} as any);
    hook.hookState.setState(
      { pools: { [POOL_A]: poolHookState(1), [POOL_B]: poolHookState(1) } },
      1,
    );
    return hook.hookState;
  };

  const process = (
    s: ReturnType<typeof subscriber>,
    logs: any[],
  ): Promise<FloorHookState | null> =>
    (s as any).processBlockLogs(s.getStaleState(), logs, { number: 2 });

  it('re-reads a pool after a hook event that moves its state', async () => {
    const s = subscriber();
    const fetch = jest
      .spyOn(s, 'fetchPoolStates')
      .mockResolvedValue({ [POOL_A]: poolHookState(2) });

    const next = await process(s, [
      log(HOOK, hookIface.getEventTopic('BidReplaced'), POOL_A),
    ]);

    expect(fetch).toHaveBeenCalledWith([POOL_A], 2);
    expect(next!.pools[POOL_A].floorTick).toBe(2);
    expect(next!.pools[POOL_B].floorTick).toBe(1);
  });

  it('re-reads a pool after a PoolManager ModifyLiquidity on it', async () => {
    const s = subscriber();
    const fetch = jest
      .spyOn(s, 'fetchPoolStates')
      .mockResolvedValue({ [POOL_B]: poolHookState(3) });

    const next = await process(s, [
      log(
        POOL_MANAGER,
        poolManagerIface.getEventTopic('ModifyLiquidity'),
        POOL_B,
      ),
      log(POOL_MANAGER, poolManagerIface.getEventTopic('Swap'), POOL_A),
    ]);

    expect(fetch).toHaveBeenCalledWith([POOL_B], 2);
    expect(next!.pools[POOL_B].floorTick).toBe(3);
  });

  it('ignores swaps and pools it does not track', async () => {
    const s = subscriber();
    const fetch = jest.spyOn(s, 'fetchPoolStates');

    const next = await process(s, [
      log(POOL_MANAGER, poolManagerIface.getEventTopic('Swap'), POOL_A),
      log(HOOK, hookIface.getEventTopic('Ratcheted'), `0x${'cc'.repeat(32)}`),
    ]);

    expect(fetch).not.toHaveBeenCalled();
    expect(next).toBeNull();
  });

  it('drops a pool it could not re-read and retries it on the next block', async () => {
    const s = subscriber();
    jest.spyOn(s, 'fetchPoolStates').mockResolvedValueOnce({});

    const next = await process(s, [
      log(HOOK, hookIface.getEventTopic('Ratcheted'), POOL_A),
    ]);
    expect(next!.pools[POOL_A]).toBeUndefined();

    s.setState(next!, 2);
    const retry = jest
      .spyOn(s, 'fetchPoolStates')
      .mockResolvedValueOnce({ [POOL_A]: poolHookState(4) });
    const after = await process(s, [
      log(POOL_MANAGER, poolManagerIface.getEventTopic('Swap'), POOL_B),
    ]);
    expect(retry).toHaveBeenLastCalledWith([POOL_A], 2);
    expect(after!.pools[POOL_A].floorTick).toBe(4);
  });
});

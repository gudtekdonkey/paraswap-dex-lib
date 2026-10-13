/* eslint-disable no-console */
// npx jest src/dex/uniswap-v4/hooks/floor/floor-hook-events.test.ts
import dotenv from 'dotenv';
dotenv.config();

import { Network } from '../../../../constants';
import { DummyDexHelper } from '../../../../dex-helper';
import { testEventSubscriber } from '../../../../../tests/utils-events';
import { UniswapV4Config } from '../../config';
import { PoolState } from '../../types';
import { UniswapV4Pool } from '../../uniswap-v4-pool';
import { FloorHook } from './floor-hook';
import { FloorHookStateSubscriber } from './floor-hook-state';
import { FloorHookState } from './types';

jest.setTimeout(500 * 1000);

const dexKey = 'FloorHook';

// eventName -> blockNumbers
type EventMappings = Record<string, number[]>;

async function fetchHookState(
  subscriber: FloorHookStateSubscriber,
  blockNumber: number,
): Promise<FloorHookState> {
  const state = await subscriber.generateState(blockNumber);
  return { pools: { ...state.pools } } as FloorHookState;
}

describe('FloorHook events', () => {
  describe('BSC', () => {
    const network = Network.BSC;
    const poolId =
      '0x5259c52ce22be9d859d73e8b29bed5d316053fe4b9afab637d986812041d89ff';

    const eventsToTest: EventMappings = {
      // the hook registers the pool (no state before it)
      PoolRegistered: [127476136],
      // graduation: Initialize, Seeded, LadderSeeded, StairsPlaced,
      // Ratcheted and the PoolManager's ModifyLiquidity in one block
      // later ratchets: StairsCollected, ReserveSplit, CushionPlaced too
      Ratcheted: [127476189, 127478515, 127478582, 127478583],
      // swaps and other hook events do not move the pool's pricing state
      Swap: [127478455, 127478467],
      Unrelated: [127476247],
    };

    Object.entries(eventsToTest).forEach(([eventName, blockNumbers]) => {
      describe(eventName, () => {
        blockNumbers.forEach(blockNumber => {
          it(`State after ${blockNumber}`, async () => {
            const dexHelper = new DummyDexHelper(network);
            const logger = dexHelper.getLogger(dexKey);
            const subscriber = new FloorHookStateSubscriber(
              dexKey,
              network,
              dexHelper,
              logger,
            );
            subscriber.addPoolId(poolId);

            await testEventSubscriber(
              subscriber,
              subscriber.addressesSubscribed,
              (_blockNumber: number) =>
                fetchHookState(subscriber, _blockNumber),
              blockNumber,
              `${dexKey}_${poolId}`,
              dexHelper.provider,
            );
          });
        });
      });
    });

    // the FLOOR pool's own v4 state: the hook overrides the LP fee on every
    // swap of this dynamic-fee pool, and ratchets move its positions
    describe('UniswapV4Pool BNB / FLOOR launch', () => {
      const poolEvents: EventMappings = {
        Swap: [
          127478455, // buy
          127478459, // buy
          127478467, // sell
          127478504, // sell
          127478531, // buy
          127478882, // sell
        ],
        ModifyLiquidity: [127478515, 127478582, 127478583],
      };

      Object.entries(poolEvents).forEach(([eventName, blockNumbers]) => {
        describe(eventName, () => {
          blockNumbers.forEach(blockNumber => {
            it(`State after ${blockNumber}`, async () => {
              const dexHelper = new DummyDexHelper(network);
              const logger = dexHelper.getLogger(dexKey);
              const config = UniswapV4Config.UniswapV4[network];

              const uniswapV4Pool = new UniswapV4Pool(
                dexHelper,
                'UniswapV4',
                network,
                config,
                logger,
                '',
                poolId,
                '0x0000000000000000000000000000000000000000',
                '0x7935f6ecc173913ac06186d2892bfa73e2fbdb1d',
                '8388608',
                '0xe44886ffe0a894c6c5900d77a51c7d49732c60cc',
                '60',
                new FloorHook(dexHelper, network, logger),
              );

              await testEventSubscriber(
                uniswapV4Pool,
                uniswapV4Pool.addressesSubscribed,
                (_blockNumber: number): Promise<PoolState> =>
                  uniswapV4Pool.generateState(_blockNumber),
                blockNumber,
                `UniswapV4_${config.poolManager}_${poolId}`,
                dexHelper.provider,
              );
            });
          });
        });
      });
    });
  });
});

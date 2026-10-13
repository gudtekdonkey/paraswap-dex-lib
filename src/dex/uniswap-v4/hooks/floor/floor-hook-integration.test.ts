/* eslint-disable no-console */
// npx jest src/dex/uniswap-v4/hooks/floor/floor-hook-integration.test.ts
import dotenv from 'dotenv';
dotenv.config();
import { DummyDexHelper } from '../../../../dex-helper';
import {
  ETHER_ADDRESS,
  Network,
  NULL_ADDRESS,
  SwapSide,
} from '../../../../constants';
import { Token } from '../../../../types';
import { UniswapV4 } from '../../uniswap-v4';
import { SubgraphPool } from '../../types';
import { FloorHook } from './floor-hook';

jest.setTimeout(500 * 1000);

const dexKey = 'UniswapV4';

// Compares the pool math plus the FLOOR hook against Uniswap's V4Quoter on
// the live chain, on every FLOOR pool the registry lists (up to POOLS_TO_TEST)
const POOLS_TO_TEST = 5;

const AMOUNTS = [0n, 10n ** 12n, 10n ** 15n, 10n ** 17n, 10n ** 18n];

function testNetwork(network: Network) {
  describe(`FLOOR pools on ${network}`, () => {
    const dexHelper = new DummyDexHelper(network);
    let blockNumber: number;
    let uniswapV4: UniswapV4;
    let pools: SubgraphPool[] = [];

    beforeAll(async () => {
      blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
      uniswapV4 = new UniswapV4(network, dexKey, dexHelper);
      await uniswapV4.initializePricing(blockNumber);

      const hook = new FloorHook(
        dexHelper,
        network,
        dexHelper.getLogger(dexKey),
      );
      pools = (await hook.getPools(blockNumber)).slice(0, POOLS_TO_TEST);
    });

    it('lists FLOOR pools', () => {
      expect(pools.length).toBeGreaterThan(0);
    });

    it('prices exact input both ways as the V4Quoter does', async () => {
      for (const pool of pools) {
        for (const zeroForOne of [true, false]) {
          const srcAddress = zeroForOne
            ? pool.token0.address
            : pool.token1.address;
          const destAddress = zeroForOne
            ? pool.token1.address
            : pool.token0.address;

          const toToken = (address: string): Token => ({
            address: address === NULL_ADDRESS ? ETHER_ADDRESS : address,
            decimals: 18,
          });

          const prices = await uniswapV4.getPricesVolume(
            toToken(srcAddress),
            toToken(destAddress),
            AMOUNTS,
            SwapSide.SELL,
            blockNumber,
            [pool.id],
          );

          const onChain = await uniswapV4.queryPriceFromRpc(
            zeroForOne,
            AMOUNTS.slice(1),
            {
              id: pool.id,
              key: {
                currency0: pool.token0.address,
                currency1: pool.token1.address,
                fee: pool.fee,
                tickSpacing: parseInt(pool.tickSpacing),
                hooks: pool.hooks,
              },
            },
            SwapSide.SELL,
            blockNumber,
          );

          console.log(pool.id, zeroForOne, prices?.[0]?.prices, onChain);

          if (onChain.every(amount => amount === 0n)) {
            expect(prices).toEqual([]);
            continue;
          }

          expect(prices![0].prices).toEqual([0n, ...onChain]);
        }
      }
    });

    it('does not price exact output', async () => {
      for (const pool of pools) {
        const prices = await uniswapV4.getPricesVolume(
          {
            address:
              pool.token0.address === NULL_ADDRESS
                ? ETHER_ADDRESS
                : pool.token0.address,
            decimals: 18,
          },
          { address: pool.token1.address, decimals: 18 },
          AMOUNTS,
          SwapSide.BUY,
          blockNumber,
          [pool.id],
        );

        expect(prices).toEqual([]);
      }
    });
  });
}

testNetwork(Network.BASE);
testNetwork(Network.BSC);

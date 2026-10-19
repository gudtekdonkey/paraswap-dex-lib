/* eslint-disable no-console */
// dex-lib's integration test for FloorAmm. It needs a DEPLOYED
// FloorAmm and an archive RPC: `HTTP_PROVIDER_<chainId>`, `FLOOR_AMM_LAUNCH_TOKEN` (a launch's
// token on that chain) and `FLOOR_AMM_QUOTE` (its quote; ETH = 0xeeee…). It holds the dex's prices to the program's OWN
// eth_call quoter `quoteBuy` / `quoteSell` at the same block — the check that the contract and the off-chain math agree
// live.
import dotenv from 'dotenv';
dotenv.config();

import { Interface, Result } from '@ethersproject/abi';
import { DummyDexHelper } from '../../dex-helper/index';
import { Network, SwapSide } from '../../constants';
import { BI_POWS } from '../../bigint-constants';
import { FloorAmm } from './floor-amm';
import { checkPoolPrices, checkPoolsLiquidity } from '../../../tests/utils';
import { FN } from './abi';

const network = Network.BASE;
const dexKey = 'FloorAmm';
const iface = new Interface([
  `function ${FN.quoteBuy} view returns ((uint256 tokensOut, uint256 spent, uint256 refund, uint256 priceAfterX64, bool graduatedNow, bool endedNow) r)`,
  `function ${FN.quoteSell} view returns (uint256 quoteOut)`,
]);
// a beneficiary with no list discount (the dex prices for one)
const beneficiary = '0x0000000000000000000000000000000000000001';

const token = {
  address: process.env.FLOOR_AMM_LAUNCH_TOKEN ?? '',
  decimals: 18,
};
const quote = {
  address:
    process.env.FLOOR_AMM_QUOTE ?? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  decimals: 18,
};
const run = token.address === '' ? describe.skip : describe;

async function onChain(
  dexHelper: DummyDexHelper,
  floorAmm: string,
  id: bigint,
  isBuy: boolean,
  amounts: bigint[],
  blockNumber: number,
): Promise<bigint[]> {
  const out: bigint[] = [];
  for (const a of amounts) {
    const fn = isBuy ? 'quoteBuy' : 'quoteSell';
    const raw = await dexHelper.provider.call(
      {
        to: floorAmm,
        data: iface.encodeFunctionData(fn, [id, a, beneficiary]),
      },
      blockNumber,
    );
    const r: Result = iface.decodeFunctionResult(fn, raw);
    // the dex prices a refunding buy as 0
    out.push(
      isBuy
        ? BigInt(r.r.refund.toString()) === 0n
          ? BigInt(r.r.tokensOut.toString())
          : 0n
        : BigInt(r.quoteOut.toString()),
    );
  }
  return out;
}

run('FloorAmm', () => {
  let dexHelper: DummyDexHelper;
  let blockNumber: number;
  let dex: FloorAmm;

  beforeAll(async () => {
    dexHelper = new DummyDexHelper(network);
    blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
    dex = new FloorAmm(network, dexKey, dexHelper as any);
    await dex.initializePricing(blockNumber);
  });

  for (const [name, src, dest, isBuy] of [
    ['buy', quote, token, true],
    ['sell', token, quote, false],
  ] as const) {
    it(`getPricesVolume ${name} = the program's eth_call quoter`, async () => {
      const amounts = [0n, 1n, 10n, 100n, 1000n].map(k => k * BI_POWS[15]);
      const pools = await dex.getPoolIdentifiers(
        src,
        dest,
        SwapSide.SELL,
        blockNumber,
      );
      expect(pools.length).toBe(1);
      // the pool's state is at `blockNumber`; the program's quoter runs at it too (the dex prices for the next block's snipe count)
      const prices = await dex.getPricesVolume(
        src,
        dest,
        amounts,
        SwapSide.SELL,
        blockNumber,
        pools,
      );
      expect(prices).not.toBeNull();
      checkPoolPrices(prices!, amounts, SwapSide.SELL, dexKey);
      const want = await onChain(
        dexHelper,
        prices![0].data.exchange,
        BigInt(prices![0].data.launchId),
        isBuy,
        amounts,
        blockNumber,
      );
      expect(prices![0].prices).toEqual(want);
    });
  }

  it('getTopPoolsForToken (liquidity = F + C)', async () => {
    const pools = await dex.getTopPoolsForToken(token.address, 10);
    checkPoolsLiquidity(pools, token.address, dexKey);
  });
});

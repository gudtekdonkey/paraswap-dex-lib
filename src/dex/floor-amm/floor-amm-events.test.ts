/* eslint-disable no-console */
// dex-lib's events test for FloorAmm. It needs a DEPLOYED FloorAmm and an archive RPC: `HTTP_PROVIDER_<chainId>`,
// `FLOOR_AMM_LAUNCH_TOKEN` (a launch's token on that chain) and `FLOOR_AMM_EVENT_BLOCKS` (comma-separated blocks that carry
// that launch's `Trade` / `PotsMoved` logs or a burn of its token). For each block the pool's state before it, pushed
// through the block's logs, must equal the state its views give after it.
import dotenv from 'dotenv';
dotenv.config();

import { DummyDexHelper } from '../../dex-helper/index';
import { Network } from '../../constants';
import { testEventSubscriber } from '../../../tests/utils-events';
import { FloorAmmEventPool } from './floor-amm-pool';
import { FloorAmmConfig } from './config';
import { FN, OUT, LV, calldata, decode } from './abi';
import type { AbiValue } from './evm/abi';
import { LaunchMeta, PoolState } from './types';

jest.setTimeout(120 * 1000);

const network = Network.BASE;
const dexKey = 'FloorAmm';
const floorAmm = FloorAmmConfig[dexKey][network].floorAmm.toLowerCase();
const token = (process.env.FLOOR_AMM_LAUNCH_TOKEN ?? '').toLowerCase();
const blocks = (process.env.FLOOR_AMM_EVENT_BLOCKS ?? '')
  .split(',')
  .filter(b => b.trim() !== '')
  .map(Number);
const run = token === '' || blocks.length === 0 ? describe.skip : describe;

async function launchMeta(
  dexHelper: DummyDexHelper,
  blockNumber: number,
): Promise<LaunchMeta> {
  const view = async (sig: string, args: AbiValue[], out: readonly string[]) =>
    decode(
      out,
      await dexHelper.provider.call(
        { to: floorAmm, data: calldata(sig, args) },
        blockNumber,
      ),
    );
  const [id] = (await view(FN.launchOf, [token], OUT.launchOf)) as bigint[];
  const [v] = (await view(
    FN.launchState,
    [id],
    OUT.launchState,
  )) as AbiValue[][];
  return {
    id,
    token,
    quote: (v[LV.quote] as string).toLowerCase(),
    createdBlock: Number(v[LV.createdBlock]),
  };
}

run('FloorAmm events', () => {
  let dexHelper: DummyDexHelper;
  let pool: FloorAmmEventPool;

  beforeAll(async () => {
    dexHelper = new DummyDexHelper(network);
    const meta = await launchMeta(dexHelper, Math.max(...blocks));
    pool = new FloorAmmEventPool(
      dexKey,
      dexHelper,
      floorAmm,
      meta,
      dexHelper.getLogger(dexKey),
    );
  });

  // a skipped run still registers one case
  for (const blockNumber of blocks.length > 0 ? blocks : [0]) {
    it(`replays block ${blockNumber}`, async () => {
      await testEventSubscriber(
        pool,
        pool.addressesSubscribed,
        (b: number) => pool.generateState(b) as Promise<PoolState>,
        blockNumber,
        `${dexKey}_${floorAmm}_${token}`,
        dexHelper.provider,
        (state, expected) => {
          expect(state.diverged).toBe(false);
          expect(state).toEqual(expected);
        },
      );
    });
  }
});

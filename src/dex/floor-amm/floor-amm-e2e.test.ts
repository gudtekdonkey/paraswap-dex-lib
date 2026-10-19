// dex-lib's e2e test for FloorAmm. Needs a DEPLOYED FloorAmm and a launch on the chain (`FLOOR_AMM_LAUNCH_TOKEN`), a holder of it in tests/constants-e2e, and a Tenderly fork.
// Exact-in (SwapSide.SELL) both ways, ETH → token and token → ETH, through Augustus v6.
import dotenv from 'dotenv';
dotenv.config();

import { testE2E } from '../../../tests/utils-e2e';
import {
  Tokens,
  Holders,
  NativeTokenSymbols,
} from '../../../tests/constants-e2e';
import { Network, ContractMethod, SwapSide } from '../../constants';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { generateConfig } from '../../config';

const network = Network.BASE;
const dexKey = 'FloorAmm';
const token = process.env.FLOOR_AMM_LAUNCH_TOKEN_SYMBOL ?? '';
const run = token === '' ? describe.skip : describe;

run('FloorAmm E2E', () => {
  const provider = new StaticJsonRpcProvider(
    generateConfig(network).privateHttpProvider,
    network,
  );
  const tokens = Tokens[network];
  const holders = Holders[network];
  const native = NativeTokenSymbols[network];

  for (const [src, dest, amount] of [
    [native, token, '10000000000000000'],
    [token, native, '1000000000000000000000'],
  ]) {
    it(`${src} -> ${dest} (swapExactAmountIn)`, async () => {
      await testE2E(
        tokens[src],
        tokens[dest],
        holders[src],
        amount,
        SwapSide.SELL,
        dexKey,
        ContractMethod.swapExactAmountIn,
        network,
        provider,
      );
    });
  }
});

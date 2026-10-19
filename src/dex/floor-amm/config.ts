import type { DexConfigMap, AdapterMappings } from '../../types';
import { Network, SwapSide } from '../../constants';
import type { DexParams } from './types';

// The FloorAmm proxy has ONE CREATE2 address on every chain. It is NOT deployed yet: this map ships with the real
// address and block. FloorAmm also runs on Arc, Robinhood Chain and HyperEVM, which are not Velora networks today.
const FLOOR_AMM = '0x0000000000000000000000000000000000000000';

export const FloorAmmConfig: DexConfigMap<DexParams> = {
  FloorAmm: {
    [Network.MAINNET]: {
      floorAmm: FLOOR_AMM,
      fromBlock: 0,
      maxLaunches: 2_000,
    },
    [Network.BASE]: { floorAmm: FLOOR_AMM, fromBlock: 0, maxLaunches: 2_000 },
    [Network.BSC]: { floorAmm: FLOOR_AMM, fromBlock: 0, maxLaunches: 2_000 },
    [Network.ARBITRUM]: {
      floorAmm: FLOOR_AMM,
      fromBlock: 0,
      maxLaunches: 2_000,
    },
  },
};

/** v6 routes through `getDexParam` (no adapter contract). */
export const Adapters: Record<number, AdapterMappings> = {
  [Network.MAINNET]: { [SwapSide.SELL]: [] },
};

import { HookConfig } from '../types';
import { HookParams } from './types';
import { Network } from '../../../../constants';

export const FloorHookConfig: HookConfig<HookParams> = {
  [Network.BASE]: {
    hookAddress: '0xe44886ffe0a894c6c5900d77a51c7d49732c60cc',
    poolManagerAddress: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    registryAddress: '0x623c349ac8cbbd796f1e9540f902b9bfa9cd5804',
    gapSkim: true,
  },
  [Network.BSC]: {
    hookAddress: '0xe44886ffe0a894c6c5900d77a51c7d49732c60cc',
    poolManagerAddress: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    registryAddress: '0x623c349ac8cbbd796f1e9540f902b9bfa9cd5804',
    gapSkim: true,
  },
};

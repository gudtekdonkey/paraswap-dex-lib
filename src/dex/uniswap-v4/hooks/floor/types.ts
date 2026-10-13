import { Address } from '@paraswap/core';

export type HookParams = {
  hookAddress: Address;
  poolManagerAddress: Address;
  // FloorRegistry: lists every launch, and through it every FLOOR pool
  registryAddress: Address;
  // whether the engine scales a buy's skim by the cushion gap (_gapSkim)
  gapSkim: boolean;
};

// A pool's own rates in bps, copied once at registration (poolState)
export type FloorPoolRates = {
  skimBuyFarBps: number;
  skimSellFarBps: number;
  skimBuyAtFloorBps: number;
  skimSellAtFloorBps: number;
  creatorBuyBps: number;
  creatorSellBps: number;
  holderBuyBps: number;
  holderSellBps: number;
  teamFeeBps: number;
};

// What the hook reads, besides the PoolManager, to price a swap
export type FloorPoolHookState = {
  quoteIsCurrency1: boolean;
  // poolState.floorTick, engine frame
  floorTick: number;
  tickSpacing: number;
  rates: FloorPoolRates;
  // stairs().cushionLower, engine frame; cushionLiq 0 means no cushion
  cushionLower: number;
  cushionLiq: bigint;
};

export type FloorHookState = {
  pools: Record<string, FloorPoolHookState>;
};

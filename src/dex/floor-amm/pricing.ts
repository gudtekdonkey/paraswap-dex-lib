// What an exact-in amount trades for on a launch's state — pure, on a COPY (the dex's `getPricesVolume`).
// ⛔ A buy the program would partly refund (the supply sold out, snipe cap) prices 0: a route
// never carries a refund. A math refusal (nothing outside to sell to, …) prices 0.

import { cloneLaunch, launchBuy, launchSell } from './math/launch';
import { FloorMathError } from './math/index';
import { BidMathError } from './math/bid';
import type { PoolState } from './types';

/** `blockNumber`: the block the trade lands in (the snipe cap counts blocks since create). */
export function amountOut(
  state: PoolState,
  isBuy: boolean,
  amount: bigint,
  blockNumber: number,
): bigint {
  if (amount === 0n) return 0n;
  const l = cloneLaunch(state.launch);
  try {
    if (isBuy) {
      const r = launchBuy(l, amount, BigInt(blockNumber), state.liveSupply);
      return r.refund === 0n ? r.out : 0n;
    }
    return launchSell(l, amount, state.liveSupply).payout;
  } catch (e) {
    if (e instanceof FloorMathError || e instanceof BidMathError) return 0n;
    throw e;
  }
}

import { FloorPoolRates } from './types';

// SingletonFloorEngine.LP_FEE: the LP fee the hook overrides on every swap, in pips
export const FLOOR_LP_FEE = 2500n;

// SingletonFloorEngine.SKIM_RAMP_TICKS
export const SKIM_RAMP_TICKS = 16094;

// FloorPolicy.BID_BAND_TICKS
export const BID_BAND_TICKS = 120;

// FloorPolicy.STAIR_GAP_SKIM_TICKS: from this gap on, the full multiplier
export const GAP_SKIM_TICKS = 5109;

// FloorPolicy.STAIR_GAP_SKIM_FROM_TICKS: up to this gap, no multiplier
export const GAP_SKIM_FROM_TICKS = 2232;

// FloorPolicy.STAIR_GAP_SKIM_MULT_BPS: the full multiplier (1.5x)
export const GAP_SKIM_MULT_BPS = 15000;

// FloorPolicy.STAIR_GAP_SKIM_MAX_BPS: the cap on a scaled buy skim
export const GAP_SKIM_MAX_BPS = 1500;

const BPS = 10000;

// The pool's tick in the engine's frame (the quote as currency0):
// a quote at currency1 maps to -tick - 1
export function marketTick(rawTick: number, quoteIsCurrency1: boolean): number {
  return quoteIsCurrency1 ? -rawTick - 1 : rawTick;
}

// FloorMath._ceilToSpacing(BID_BAND_TICKS, tickSpacing)
export function bandTicks(tickSpacing: number): number {
  return Math.ceil(BID_BAND_TICKS / tickSpacing) * tickSpacing;
}

// The bid band's dear edge, engine frame
export function dearEdge(floorTick: number, tickSpacing: number): number {
  return floorTick - bandTicks(tickSpacing);
}

// FloorHookMath.skimBps: the skim in bps at `distance` ticks from the
// band's dear edge (dearEdge - current, engine frame)
export function skimBpsAt(
  isBuy: boolean,
  distance: number,
  rates: FloorPoolRates,
): number {
  let closeness = 0;
  if (distance <= 0) {
    closeness = BPS;
  } else if (distance < SKIM_RAMP_TICKS) {
    closeness = BPS - Math.floor((distance * BPS) / SKIM_RAMP_TICKS);
  }

  if (isBuy) {
    const far = rates.skimBuyFarBps;
    const atFloor = rates.skimBuyAtFloorBps;
    if (far >= atFloor) {
      return far - Math.floor(((far - atFloor) * closeness) / BPS);
    }
    return far + Math.floor(((atFloor - far) * closeness) / BPS);
  }

  const far = rates.skimSellFarBps;
  const atFloor = rates.skimSellAtFloorBps;
  if (far >= atFloor) {
    return far;
  }
  return far + Math.floor(((atFloor - far) * closeness) / BPS);
}

// SingletonFloorEngine._gapSkim: a buy's skim scaled by how far the price
// stands above the cushion's top (gap = cushionLower - current, engine frame)
export function gapSkimBps(
  bps: number,
  cushionLower: number,
  cushionLiq: bigint,
  currentTick: number,
): number {
  if (cushionLiq === 0n) return bps;

  const gap = cushionLower - currentTick;
  let multiplier: number;
  if (gap >= GAP_SKIM_TICKS) {
    multiplier = GAP_SKIM_MULT_BPS;
  } else if (gap > GAP_SKIM_FROM_TICKS) {
    multiplier =
      BPS +
      Math.floor(
        ((GAP_SKIM_MULT_BPS - BPS) * (gap - GAP_SKIM_FROM_TICKS)) /
          (GAP_SKIM_TICKS - GAP_SKIM_FROM_TICKS),
      );
  } else {
    return bps;
  }

  const scaled = Math.floor((bps * multiplier) / BPS);
  return scaled > GAP_SKIM_MAX_BPS ? GAP_SKIM_MAX_BPS : scaled;
}

// SingletonFloorEngine._takeFees: skim, creator, holder and platform fees,
// each rounded down, off one quote leg
export function takeFees(
  isBuy: boolean,
  quoteLeg: bigint,
  skimBps: number,
  rates: FloorPoolRates,
): bigint {
  const of = (bps: number) => (quoteLeg * BigInt(bps)) / BigInt(BPS);

  return (
    of(skimBps) +
    of(isBuy ? rates.creatorBuyBps : rates.creatorSellBps) +
    of(isBuy ? rates.holderBuyBps : rates.holderSellBps) +
    of(rates.teamFeeBps)
  );
}

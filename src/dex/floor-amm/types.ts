import type { Address } from '../../types';
import type { Launch } from './math/launch';

/** One launch's market, as the event pool keeps it. */
export type PoolState = {
  /** the reference trade's state (`math/launch.ts`): what `getPricesVolume` trades on a copy of. */
  launch: Launch;
  /** The token's `liveSupply` as last seen (count burns: only falls). */
  liveSupply: bigint;
  /** The quote's decimals (`launchSpec`). */
  quoteDecimals: number;
  /** The Team Slot's members' payments (quote units, `teamSlot(id)`) and their sum `bought`: what the members' weights
   * are re-derived from when a `TeamSlotMember` log is replayed. */
  slotPaid: bigint[];
  slotBought: bigint;
  /** A replayed trade disagreed with the chain's own `Trade` event: price nothing until the state is regenerated. */
  diverged: boolean;
};

/** The route's data: which launch, which way. */
export type FloorAmmData = {
  /** The FloorAmm proxy (one address on every chain). */
  exchange: Address;
  launchId: string;
  /** true: quote → token (`buy*`); false: token → quote (`sell*`). */
  isBuy: boolean;
};

export type DexParams = {
  /** The FloorAmm proxy (one CREATE2 address on every chain). */
  floorAmm: Address;
  /** The block to discover launches from (the proxy's deploy block). */
  fromBlock: number;
  /** The most launches `initializePricing` loads (newest first). */
  maxLaunches: number;
  /** Price launches whose quote is not on FLOOR's quote registry (default false: they are not routed). */
  routeUnlisted?: boolean;
};

/** A launch as discovered (`LaunchCreated`, or `launchInfo`). */
export type LaunchMeta = {
  id: bigint;
  token: Address;
  /** The quote as FloorAmm stores it: `0x0…0` is native ETH (FloorStorage `NATIVE`). */
  quote: Address;
  createdBlock: number;
  /** The quote was on the registry when the launch was created (`LaunchCreated.listed` / `launchQuoteInfo`). */
  listed: boolean;
};

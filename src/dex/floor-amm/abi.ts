// FloorAmm's ABI as the dex reads it: `IFloorAmm` + `IFloorAmmEvents`. Canonical signatures only; `evm/abi.ts` hashes
// and codes them.

import {
  decodeAbi,
  encodeCall,
  eventTopic,
  hexToBytes,
  bytesToHex,
} from './evm/abi';
import type { AbiValue } from './evm/abi';

export const FN = {
  // ---- trading ----
  buy: 'buy(uint256,uint256,uint256,address,uint256)',
  buyFromBalance: 'buyFromBalance(uint256,uint256,address,address,uint256)',
  sell: 'sell(uint256,uint256,uint256,address,uint256)',
  sellFromBalance: 'sellFromBalance(uint256,uint256,address,uint256)',
  // the program's own quoters (views; `to` is the beneficiary: its referrers and list discount apply)
  quoteBuy: 'quoteBuy(uint256,uint256,address)',
  quoteSell: 'quoteSell(uint256,uint256,address)',
  // ---- views ----
  launchState: 'launchState(uint256)',
  launchSpec: 'launchSpec(uint256)',
  creatorRefs: 'creatorRefs(uint256)',
  teamSlot: 'teamSlot(uint256)',
  launchOf: 'launchOf(address)',
  launchCount: 'launchCount()',
  // whether the launch's quote was listed at create, and the USD price its raise used
  launchQuoteInfo: 'launchQuoteInfo(uint256)',
  // the quote registry's entry (listed, enabled, decimals, createFee, usdCentsX64, launches, updatedAt)
  quoteEntry: 'quoteEntry(address)',
  // the books (s, h, l, curveFloorX64), the cushion curve (√b, L) and the stored schedule
  // (`abi.encode(FloorSchedule.Schedule)`): what an off-chain quote needs bit for bit
  launchMarket: 'launchMarket(uint256)',
  // the creator's held free allocation and its unlock's marks
  creatorAlloc: 'creatorAlloc(uint256)',
  // the Token Option: the Token Option's releases (total, released, releasesDone, releaseCount, nextReleaseIndex, nextReleaseAt,
  // nextReleaseTokens, linesMet, due)
  tokenOptionState: 'tokenOptionState(uint256)',
  // the tail range after the schedule's end (L, √p now, √p at the frozen price, its money, its price; math units): a
  // contract without it reads as no range (`readPoolState`)
  launchTail: 'launchTail(uint256)',
  launchMsLiveMaxBps: 'launchMsLiveMaxBps(uint256)',
  // the token (FloorToken): the program's live supply is totalSupply() − balanceOf(DEAD)
  totalSupply: 'totalSupply()',
  balanceOf: 'balanceOf(address)',
  name: 'name()',
  symbol: 'symbol()',
  decimals: 'decimals()',
} as const;

/** `LaunchView`, field for field (IFloorAmm). */
export const LAUNCH_VIEW = [
  'address', // token
  'address', // quote
  'address', // creator
  'uint8', // presetId
  'uint32', // presetVersion
  'bytes32', // presetHash
  'bool', // graduated
  'bool', // ended
  'uint64', // createdAt
  'uint64', // createdBlock
  'uint64', // creatorUnlockAt
  'uint64', // graduatedBlock
  'uint256', // supply
  'uint256', // sOut
  'uint256', // windowLeft
  'uint256', // inventory
  'uint256', // lotTokens
  'uint256', // lotCost
  'uint256', // tailTokens
  'uint256', // creatorLocked
  'uint256', // floor
  'uint256', // cushion
  'uint256', // p0X64
  'uint256', // priceX64
  'uint256', // floorX64
  'uint256', // raise
  'uint256', // windowTokens
  'uint256', // windowRaised
  'uint16', // slotRateBps
  'uint32', // slotBoughtPpm
] as const;
export const LV = Object.fromEntries(
  [
    'token',
    'quote',
    'creator',
    'presetId',
    'presetVersion',
    'presetHash',
    'graduated',
    'ended',
    'createdAt',
    'createdBlock',
    'creatorUnlockAt',
    'graduatedBlock',
    'supply',
    'sOut',
    'windowLeft',
    'inventory',
    'lotTokens',
    'lotCost',
    'tailTokens',
    'creatorLocked',
    'floor',
    'cushion',
    'p0X64',
    'priceX64',
    'floorX64',
    'raise',
    'windowTokens',
    'windowRaised',
    'slotRateBps',
    'slotBoughtPpm',
  ].map((k, i) => [k, i]),
) as Record<string, number>;

/** `SlotMember`: key, kind, state, paid, requested, earned. */
const SLOT_MEMBER = '(bytes32,uint8,uint8,uint256,uint256,uint256)';
/** `BuyResult`: tokensOut, spent, refund, priceAfterX64, graduatedNow, endedNow. */
const BUY_RESULT = '(uint256,uint256,uint256,uint256,bool,bool)';

export const OUT = {
  buy: [BUY_RESULT],
  sell: ['uint256'],
  quoteBuy: [BUY_RESULT],
  quoteSell: ['uint256'],
  launchState: [`(${LAUNCH_VIEW.join(',')})`],
  launchQuoteInfo: ['bool', 'uint256'],
  quoteEntry: ['(bool,bool,uint8,uint256,uint256,uint64,uint64)'],
  launchSpec: ['bytes'],
  creatorRefs: ['address[3]'],
  // TeamSlotView: rateBps, memberCount, openedAt, price, bought, reservedTotal, members[5]
  teamSlot: [`(uint16,uint8,uint64,uint256,uint256,uint256,${SLOT_MEMBER}[5])`],
  launchOf: ['uint256'],
  launchCount: ['uint256'],
  launchMarket: ['uint256[4]', 'uint256', 'uint256', 'bytes'],
  // tokens, unlockMcap, unlockBacking, unlockable, unlocked
  creatorAlloc: ['uint256', 'uint256', 'uint256', 'bool', 'bool'],
  tokenOptionState: [
    '(uint256,uint256,uint8,uint8,uint8,uint256,uint256,bool,bool)',
  ],
  launchTail: ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
  launchMsLiveMaxBps: ['uint16'],
  totalSupply: ['uint256'],
  balanceOf: ['uint256'],
  name: ['string'],
  symbol: ['string'],
  decimals: ['uint8'],
} as const;

export const EV = {
  LaunchCreated:
    'LaunchCreated(uint256,address,address,address,uint8,uint32,bytes32,uint256,uint256,uint256,uint256,uint256,string,string,string,bool,uint256,uint256)',
  Trade:
    'Trade(uint256,address,address,bool,uint256,uint256,uint256,uint256,uint256[7],uint256,uint256[4],uint256[5],uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  PotsMoved:
    'PotsMoved(uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  ScheduleDone: 'ScheduleDone(uint256,uint256,uint256,uint256)',
  PotsSwept: 'PotsSwept(uint256,uint256,uint8)',
  // the window sold out: the launch graduates to the curve
  Graduated: 'Graduated(uint256,uint256,uint256,uint256,uint256)',
  // the Team Slot: its rate, then every member write (the slot's `bought` / `boughtPpm` ride along)
  TeamSlotOpened: 'TeamSlotOpened(uint256,uint16,uint256)',
  TeamSlotMember:
    'TeamSlotMember(uint256,uint8,bytes32,uint8,uint8,uint256,uint256,uint256,uint32)',
  // the creator's locks: the buy (outside `held`) and the free allocation (inside it until released)
  CreatorBuyUnlocked: 'CreatorBuyUnlocked(uint256,address,uint256)',
  // the Token Option: one release of the free allocation (releaseIndex, released, nextReleaseAt, members[5] appended)
  CreatorAllocUnlocked:
    'CreatorAllocUnlocked(uint256,address,uint256,uint256,uint8,uint256,uint256,uint256[5])',
  // who a trade credited (informational; its `Trade` carries the state)
  TradeCredits: 'TradeCredits(uint256,address,address,uint256,uint256[])',
  // the token's
  Transfer: 'Transfer(address,address,uint256)',
} as const;

/** The non-indexed data of each event (the indexed fields are topics). */
export const EV_DATA = {
  // creator, presetId, presetVersion, presetHash, p0X64, raise, windowTokens, creatorBuyTokens, createFee, name, symbol, uri,
  // listed, quoteUsdCentsX64, nativeCreateFee
  LaunchCreated: [
    'address',
    'uint8',
    'uint32',
    'bytes32',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'string',
    'string',
    'string',
    'bool',
    'uint256',
    'uint256',
  ],
  // isBuy, quoteGross, quoteNet, refund, tokens, fees, traderRef, split, credits, priceBeforeX64, priceAfterX64,
  // floorAfterX64, floor, cushion, reserveTokens, sOut
  Trade: [
    'bool',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'uint256[7]',
    'uint256',
    'uint256[4]',
    'uint256[5]',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
    'uint256',
  ],
  PotsMoved: ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
  ScheduleDone: ['uint256', 'uint256', 'uint256'],
  PotsSwept: ['uint256', 'uint8'],
  Graduated: ['uint256', 'uint256', 'uint256', 'uint256'],
  TeamSlotOpened: ['uint16', 'uint256'],
  // index, key, kind, state, paid, requested, bought, boughtPpm
  TeamSlotMember: [
    'uint8',
    'bytes32',
    'uint8',
    'uint8',
    'uint256',
    'uint256',
    'uint256',
    'uint32',
  ],
  CreatorBuyUnlocked: ['uint256'],
  CreatorAllocUnlocked: [
    'uint256',
    'uint256',
    'uint8',
    'uint256',
    'uint256',
    'uint256[5]',
  ],
  TradeCredits: ['uint256', 'uint256[]'],
  Transfer: ['uint256'],
} as const;

/** `LaunchCreated`'s data: where `listed` sits (after name, symbol, uri). */
export const LAUNCH_CREATED_LISTED = 12;

/** No expiry: the aggregator's own router enforces its deadline. */
export const NO_DEADLINE = (1n << 256n) - 1n;

export const TOPIC: Record<keyof typeof EV, string> = Object.fromEntries(
  Object.entries(EV).map(([k, v]) => [k, eventTopic(v)]),
) as Record<keyof typeof EV, string>;

/** The FloorToken burn sink the program counts (`FloorToken.DEAD`); a burn is also a Transfer to the zero address. */
export const DEAD = '0x000000000000000000000000000000000000dead';

export const calldata = (sig: string, values: readonly AbiValue[]): string =>
  bytesToHex(encodeCall(sig, values));
export const decode = (types: readonly string[], hex: string): AbiValue[] =>
  decodeAbi(types, hexToBytes(hex));
/** A 32-byte topic → its uint256 / address. */
export const topicUint = (t: string): bigint => BigInt(t);
export const topicAddress = (t: string): string =>
  `0x${t.slice(-40)}`.toLowerCase();

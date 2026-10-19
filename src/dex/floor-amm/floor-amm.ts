// FloorAmm on Velora: the FLOOR Program's EVM contract, ONE per chain, every launch trading against it from its first block
// (there is no pool contract: a "pool" here is one launch id). Prices come from the reference trade on the event
// pool's state (`floor-amm-pool.ts`); the route calls the program's router entry points, `buyFromBalance` /
// `sellFromBalance` (the executor sends the token in first), or `buy` with `msg.value` for an ETH-quoted launch.
//
// buys and sells are never paused — there is no "paused" pool state to read. ⛔ Fill-and-refund: a buy the
// program cannot fully fill (the supply sold out, the snipe cap) refunds the rest; the dex prices such an amount as 0
// so a route never carries a refund. Exact-in only (SwapSide.SELL): FloorAmm has no exact-out entry point.

import type {
  AdapterExchangeParam,
  Address,
  DexExchangeParam,
  ExchangePrices,
  Logger,
  NumberAsString,
  PoolLiquidity,
  PoolPrices,
  Token,
} from '../../types';
import { ETHER_ADDRESS, NULL_ADDRESS, SwapSide } from '../../constants';
import type { Network } from '../../constants';
import type { IDexHelper } from '../../dex-helper/idex-helper';
import type { IDex } from '../idex';
import { SimpleExchange } from '../simple-exchange';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getBigIntPow, getDexKeysWithNetwork } from '../../utils';
import { FloorAmmConfig } from './config';
import { FloorAmmEventPool } from './floor-amm-pool';
import {
  EV_DATA,
  FN,
  LAUNCH_CREATED_LISTED,
  LV,
  NO_DEADLINE,
  OUT,
  TOPIC,
  calldata,
  decode,
  topicAddress,
  topicUint,
} from './abi';
import type { AbiValue } from './evm/abi';
import type { DexParams, FloorAmmData, LaunchMeta, PoolState } from './types';
import { amountOut } from './pricing';

/** Gas per hop: the measured buy and sell on the v1.2 contract (seven-chain fork rehearsal), worst case with headroom. */
export const FLOOR_AMM_GAS_COST = { buy: 475_000, sell: 335_000 } as const;

const lc = (a: string): string => a.toLowerCase();

export class FloorAmm extends SimpleExchange implements IDex<FloorAmmData> {
  readonly hasConstantPriceLargeAmounts = false;
  // an ETH-quoted launch takes native ETH (`buy` payable); its quote is 0x0…0 on chain, ETHER_ADDRESS here
  readonly needWrapNative = false;
  readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(FloorAmmConfig) as {
      key: string;
      networks: Network[];
    }[];

  readonly logger: Logger;
  readonly params: DexParams;
  /** token (lower case) → its launch's event pool. */
  readonly pools = new Map<string, FloorAmmEventPool>();

  constructor(
    network: Network,
    dexKey: string,
    dexHelper: IDexHelper,
    params: DexParams = FloorAmmConfig[dexKey][network],
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    this.params = params;
  }

  /** On chain the native quote is 0x0…0 (FloorStorage `NATIVE`); dex-lib names ETH `ETHER_ADDRESS`. */
  private static quoteOf(t: Address): Address {
    return lc(t) === ETHER_ADDRESS ? NULL_ADDRESS : lc(t);
  }

  private async view(
    sig: string,
    args: (bigint | string)[],
    out: readonly string[],
    blockNumber: number | 'latest',
  ) {
    return decode(
      out,
      await this.dexHelper.provider.call(
        { to: this.params.floorAmm, data: calldata(sig, args) },
        blockNumber,
      ),
    );
  }

  /** Load the newest `maxLaunches` launches (ids 1…launchCount) and their state at `blockNumber`. */
  async initializePricing(blockNumber: number): Promise<void> {
    const [count] = (await this.view(
      FN.launchCount,
      [],
      OUT.launchCount,
      blockNumber,
    )) as bigint[];
    const lo =
      count > BigInt(this.params.maxLaunches)
        ? count - BigInt(this.params.maxLaunches) + 1n
        : 1n;
    const metas: LaunchMeta[] = [];
    for (let id = count; id >= lo && id > 0n; id--) {
      const [v] = (await this.view(
        FN.launchState,
        [id],
        OUT.launchState,
        blockNumber,
      )) as AbiValue[][];
      const [listed] = (await this.view(
        FN.launchQuoteInfo,
        [id],
        OUT.launchQuoteInfo,
        blockNumber,
      )) as boolean[];
      const meta: LaunchMeta = {
        id,
        token: lc(v[LV.token] as string),
        quote: lc(v[LV.quote] as string),
        createdBlock: Number(v[LV.createdBlock]),
        listed,
      };
      if (await this.routable(meta, blockNumber)) metas.push(meta);
    }
    await Promise.all(metas.map(m => this.addLaunch(m, blockNumber)));
  }

  /**
   * Whether a launch is priced: its quote was on FLOOR's quote registry at create, or is on it now. A launch on an
   * unlisted quote (any ERC-20, with a price its creator declared) is shown by FLOOR with a warning; it is not routed
   * unless `routeUnlisted` is set, since nothing has vetted the quote token's transfer behaviour.
   */
  async routable(meta: LaunchMeta, blockNumber: number): Promise<boolean> {
    if (meta.listed || this.params.routeUnlisted) return true;
    const [entry] = (await this.view(
      FN.quoteEntry,
      [meta.quote],
      OUT.quoteEntry,
      blockNumber,
    )) as AbiValue[][];
    return entry[0] === true;
  }

  /** A launch the dex prices from now on (from `initializePricing`, or a `LaunchCreated` log via `onLaunchCreated`). */
  async addLaunch(
    meta: LaunchMeta,
    blockNumber: number,
  ): Promise<FloorAmmEventPool> {
    const pool = new FloorAmmEventPool(
      this.dexKey,
      this.dexHelper,
      this.params.floorAmm,
      meta,
      this.logger,
    );
    await pool.initialize(blockNumber);
    this.pools.set(lc(meta.token), pool);
    return pool;
  }

  /** dex-lib's factory hook: a `LaunchCreated` log of the FloorAmm proxy. */
  async onLaunchCreated(log: {
    address: string;
    topics: string[];
    data: string;
    blockNumber: number;
  }): Promise<FloorAmmEventPool | null> {
    if (
      lc(log.address) !== lc(this.params.floorAmm) ||
      log.topics[0] !== TOPIC.LaunchCreated
    )
      return null;
    const data = decode(EV_DATA.LaunchCreated, log.data);
    const meta: LaunchMeta = {
      id: topicUint(log.topics[1]),
      token: topicAddress(log.topics[2]),
      quote: topicAddress(log.topics[3]),
      createdBlock: log.blockNumber,
      listed: data[LAUNCH_CREATED_LISTED] === true,
    };
    if (!(await this.routable(meta, log.blockNumber))) return null;
    return this.addLaunch(meta, log.blockNumber);
  }

  /** The pool of a (quote, token) pair in either order, and the direction. */
  private match(
    src: Token,
    dest: Token,
  ): { pool: FloorAmmEventPool; isBuy: boolean } | null {
    const [s, d] = [
      FloorAmm.quoteOf(src.address),
      FloorAmm.quoteOf(dest.address),
    ];
    const asToken = this.pools.get(d);
    if (asToken && lc(asToken.meta.quote) === s)
      return { pool: asToken, isBuy: true };
    const asSrc = this.pools.get(s);
    if (asSrc && lc(asSrc.meta.quote) === d)
      return { pool: asSrc, isBuy: false };
    return null;
  }

  private poolId(pool: FloorAmmEventPool): string {
    return `${this.dexKey}_${lc(this.params.floorAmm)}_${
      pool.meta.id
    }`.toLowerCase();
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    _blockNumber: number,
  ): Promise<string[]> {
    if (side !== SwapSide.SELL) return [];
    const m = this.match(srcToken, destToken);
    return m ? [this.poolId(m.pool)] : [];
  }

  /** What `amount` of the source trades for, landing in `blockNumber` (`pricing.ts`). */
  static amountOut(
    state: PoolState,
    isBuy: boolean,
    amount: bigint,
    blockNumber: number,
  ): bigint {
    return amountOut(state, isBuy, amount, blockNumber);
  }

  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<FloorAmmData>> {
    if (side !== SwapSide.SELL) return null;
    const m = this.match(srcToken, destToken);
    if (!m) return null;
    const id = this.poolId(m.pool);
    if (limitPools && !limitPools.includes(id)) return null;
    const state = m.pool.getState(blockNumber) as PoolState | null;
    if (!state || state.diverged) return null;
    // the first block a buy prices at: the next one (the snipe cap counts blocks since create)
    const at = blockNumber + 1;
    const unit = FloorAmm.amountOut(
      state,
      m.isBuy,
      getBigIntPow(srcToken.decimals),
      at,
    );
    const prices = amounts.map(a => FloorAmm.amountOut(state, m.isBuy, a, at));
    if (prices.every(p => p === 0n)) return null;
    return [
      {
        prices,
        unit,
        data: {
          exchange: this.params.floorAmm,
          launchId: m.pool.meta.id.toString(),
          isBuy: m.isBuy,
        },
        poolIdentifiers: [id],
        exchange: this.dexKey,
        gasCost: m.isBuy ? FLOOR_AMM_GAS_COST.buy : FLOOR_AMM_GAS_COST.sell,
        poolAddresses: [this.params.floorAmm],
      },
    ];
  }

  getCalldataGasCost(_poolPrices: PoolPrices<FloorAmmData>): number | number[] {
    // selector + id + minOut + to (+ quoteIn on `buy`)
    // the widest call: id, two amounts, two addresses, the deadline word
    return (
      CALLDATA_GAS_COST.DEX_OVERHEAD +
      CALLDATA_GAS_COST.FUNCTION_SELECTOR +
      CALLDATA_GAS_COST.INDEX +
      CALLDATA_GAS_COST.AMOUNT * 2 +
      CALLDATA_GAS_COST.ADDRESS * 2 +
      CALLDATA_GAS_COST.FULL_WORD
    );
  }

  /**
   * The hop's call. ERC-20 in: the executor transfers the source to FloorAmm first (`transferSrcTokenBeforeSwap`) and calls
   * `buyFromBalance(id, minOut, recipient, refundTo = recipient, deadline)` / `sellFromBalance(id, minOut, recipient,
   * deadline)` — no approval, and a buy's refund (none, as priced) would go to the recipient. ETH in: `buy(id, srcAmount,
   * minOut, recipient, deadline)` with `msg.value = srcAmount`. The deadline is the router's: none here. `minOut` is `destAmount`
   * (the route's limit for this hop); the program reverts `SlippageExceeded` under it.
   */
  getDexParam(
    srcToken: Address,
    _destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    recipient: Address,
    data: FloorAmmData,
    side: SwapSide,
  ): DexExchangeParam {
    if (side !== SwapSide.SELL)
      throw new Error(`${this.dexKey}: exact-in only`);
    const id = BigInt(data.launchId);
    const minOut = BigInt(destAmount);
    const ethIn = lc(srcToken) === ETHER_ADDRESS;
    const exchangeData = !data.isBuy
      ? calldata(FN.sellFromBalance, [id, minOut, recipient, NO_DEADLINE])
      : ethIn
      ? calldata(FN.buy, [
          id,
          BigInt(srcAmount),
          minOut,
          recipient,
          NO_DEADLINE,
        ])
      : calldata(FN.buyFromBalance, [
          id,
          minOut,
          recipient,
          recipient,
          NO_DEADLINE,
        ]);
    return {
      needWrapNative: this.needWrapNative,
      dexFuncHasRecipient: true,
      exchangeData,
      targetExchange: data.exchange,
      // buy* → BuyResult (tokensOut first); sell* → quoteOut: the amount out is the first word either way
      returnAmountPos: 0,
      ...(ethIn ? {} : { transferSrcTokenBeforeSwap: data.exchange }),
    };
  }

  /** Augustus v5's adapters: none (FloorAmm routes through v6's `getDexParam`). */
  getAdapters(_side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }

  /** Augustus v5's adapter param: a placeholder (v6 does not use it). */
  getAdapterParam(
    _srcToken: Address,
    _destToken: Address,
    _srcAmount: NumberAsString,
    _destAmount: NumberAsString,
    data: FloorAmmData,
    _side: SwapSide,
  ): AdapterExchangeParam {
    return { targetExchange: data.exchange, payload: '0x', networkFee: '0' };
  }

  /** a launch's liquidity is F + C (the money that buys back), in USD; its connector is the other side. */
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    const t = FloorAmm.quoteOf(tokenAddress);
    const out: PoolLiquidity[] = [];
    for (const pool of this.pools.values()) {
      const isToken = lc(pool.meta.token) === t;
      if (!isToken && lc(pool.meta.quote) !== t) continue;
      const st = pool.getStaleState() as PoolState | null;
      if (!st || st.diverged) continue;
      const quote = {
        address:
          pool.meta.quote === NULL_ADDRESS ? ETHER_ADDRESS : pool.meta.quote,
        decimals: st.quoteDecimals,
      };
      const liquidityUSD = await this.dexHelper.getTokenUSDPrice(
        quote,
        st.launch.pots.floor + st.launch.pots.cushion,
      );
      out.push({
        exchange: this.dexKey,
        address: this.params.floorAmm,
        connectorTokens: [
          isToken ? quote : { address: pool.meta.token, decimals: 18 },
        ],
        liquidityUSD,
      });
    }
    return out.sort((a, b) => b.liquidityUSD - a.liquidityUSD).slice(0, limit);
  }

  releaseResources(): void {
    this.pools.clear();
  }
}

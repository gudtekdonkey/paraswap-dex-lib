// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math `supply.rs` bit for bit: COUNT BURNS. `S_out` = the live supply less every token the
// program holds; the supply only falls; nothing outside → `F + C` to the platform bucket. Held to `golden/trade.json`'s `supply`.

import { NO_POTS } from './bid';
import type { Pots } from './bid';
import { fail } from './index';

/** The supply to use now: the stored value lowered to the live read, never raised. */
export function syncSupply(stored: bigint, live: bigint): bigint {
  return stored < live ? stored : live;
}

/** `S_out = supply − held`; `Overflow` when the program claims more than the supply. */
export function sOut(supply: bigint, held: bigint): bigint {
  return supply >= held ? supply - held : fail('Overflow');
}

/** ⛔ Nothing outside: the pots' rest leaves for the platform bucket — `[pots after, to the platform bucket]`. */
export function sweepIfEmpty(p: Pots, sOutNow: bigint): [Pots, bigint] {
  if (sOutNow > 0n) return [p, 0n];
  const rest = p.floor + p.cushion;
  if (rest > (1n << 128n) - 1n) fail('Overflow');
  return [{ ...NO_POTS }, rest];
}

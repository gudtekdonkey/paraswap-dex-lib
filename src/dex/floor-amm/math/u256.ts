// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// The 256-bit helper, ported from the reference crate's `u256.rs`.
//
// A U256 is a plain `bigint` in [0, 2^256). `bigint` arithmetic is exact, so each Rust method is the
// exact operation plus the SAME range check: where Rust returns `None` (a 256-bit overflow, a value
// that does not fit u128) this returns `null`. Rust's bit-serial `div_rem_u128` and limb multiply are
// held to the exact results by the golden vectors' `u256` section.

/** 2^128 − 1. */
export const U128_MAX: bigint = (1n << 128n) - 1n;
/** 2^256 − 1. */
export const U256_MAX: bigint = (1n << 256n) - 1n;
/** 2^64 − 1. */
export const U64_MAX: bigint = (1n << 64n) - 1n;

/** Throws a RangeError unless `v` is a bigint in u128's range: a programmer error, not a MathError. */
export function assertU128(v: bigint, name: string): void {
  if (typeof v !== 'bigint' || v < 0n || v > U128_MAX) {
    throw new RangeError(
      `${name} must be a bigint in [0, 2^128): got ${String(v)}`,
    );
  }
}

/** `U256::mul_u128`: `a × b`, exact (always fits 256 bits). */
export function mulU128(a: bigint, b: bigint): bigint {
  return a * b;
}

/** `U256::checked_mul_u64`: `x × m`, or null past 256 bits. */
export function checkedMulU64(x: bigint, m: bigint): bigint | null {
  const p = x * m;
  return p > U256_MAX ? null : p;
}

/** `U256::checked_add`. */
export function checkedAdd(a: bigint, b: bigint): bigint | null {
  const p = a + b;
  return p > U256_MAX ? null : p;
}

/** `U256::checked_sub`. */
export function checkedSub(a: bigint, b: bigint): bigint | null {
  return a < b ? null : a - b;
}

/** `U256::checked_shl64`: `x << 64`, or null on overflow past 256 bits. */
export function checkedShl64(x: bigint): bigint | null {
  return x >> 192n !== 0n ? null : x << 64n;
}

/** `U256::div_rem_u128`: `[x / d, x % d]`. Throws on `d == 0`, as Rust panics; callers check first. */
export function divRemU128(x: bigint, d: bigint): [bigint, bigint] {
  if (d === 0n) throw new RangeError('division by zero');
  return [x / d, x % d];
}

/** `U256::div_ceil_u128`: `ceil(x / d)`. */
export function divCeilU128(x: bigint, d: bigint): bigint {
  const [q, r] = divRemU128(x, d);
  return r === 0n ? q : q + 1n;
}

/** `U256::to_u128`: null when the high half is not zero. */
export function toU128(x: bigint): bigint | null {
  return x > U128_MAX ? null : x;
}

/** The high and low 128-bit halves, as Rust's `U256 { hi, lo }`. */
export function hiLo(x: bigint): [bigint, bigint] {
  return [x >> 128n, x & U128_MAX];
}

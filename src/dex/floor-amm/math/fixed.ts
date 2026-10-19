// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// Fixed-point `log2` and `exp2`, ported step by step from the reference crate's `fixed.rs`: the
// binary-digit `log2` by 64 repeated squarings and the bit-product `exp2` over the 64 constants
// `2^(2^-i)` in Q1.127. Both truncate, exactly as Rust; the golden vectors hold them bit for bit.
//
// ⛔ `K` is copied verbatim from Rust (itself generated at 80 digits). Never edit an entry by hand.

import { U128_MAX, assertU128 } from './u256';

/** `K[i - 1] = floor(2^(2^-i) · 2^127)` for `i = 1..=64`, each in [1, 2) as Q1.127. */
const K: readonly bigint[] = [
  0xb504f333f9de6484597d89b3754abe9fn,
  0x9837f0518db8a96f46ad23182e42f6f6n,
  0x8b95c1e3ea8bd6e6fbe4628758a53c90n,
  0x85aac367cc487b14c5c95b8c2154c1b2n,
  0x82cd8698ac2ba1d73e2a475b46520bffn,
  0x8164d1f3bc0307737be56527bd14def4n,
  0x80b1ed4fd999ab6c25335719b6e6fd20n,
  0x8058d7d2d5e5f6b094d589f608ee4aa2n,
  0x802c6436d0e04f50ff8ce94a6797b3cen,
  0x8016302f174676283690dfe44d11d008n,
  0x800b179c82028fd0945e54e2ae18f2f0n,
  0x80058baf7fee3b5d1c718b38e549cb93n,
  0x8002c5d00fdcfcb6b6566a58c048be1fn,
  0x800162e61bed4a48e84c2e1a463473d9n,
  0x8000b17292f702a3aa22beacca949013n,
  0x800058b92abbae02030c5fa5256f41fen,
  0x80002c5c8dade4d71776c0f4dbea67d6n,
  0x8000162e44eaf636526be456600bdbe4n,
  0x80000b1721fa7c188307016c1cd4e8b6n,
  0x8000058b90de7e4cecfc487503488bb1n,
  0x800002c5c8678f36cbfce50a6de60b14n,
  0x80000162e431db9f80b2347b5d62e516n,
  0x800000b1721872d0c7b08cf1e0114152n,
  0x80000058b90c1aa8a5c3736cb77e8dffn,
  0x8000002c5c8605a4635f2efc2362d978n,
  0x800000162e4300e635cf4a109e3939bdn,
  0x8000000b17217ff81bef9c551590cf83n,
  0x800000058b90bfdd4e39cd52c0cfa27cn,
  0x80000002c5c85fe6f72d669e0e76e411n,
  0x8000000162e42ff18f9ad35186d0df28n,
  0x80000000b17217f84cce71aa0dcfffe7n,
  0x8000000058b90bfc07a77ad56ed22aaan,
  0x800000002c5c85fdfc23cdead40da8d6n,
  0x80000000162e42fefc25eb1571853a66n,
  0x800000000b17217f7d97f692baacded5n,
  0x80000000058b90bfbead3b8b5dd254d7n,
  0x8000000002c5c85fdf4eedd62f084e67n,
  0x800000000162e42fefa58aef378bf586n,
  0x8000000000b17217f7d24a78a3c7ef02n,
  0x800000000058b90bfbe9067c93e474a6n,
  0x80000000002c5c85fdf47b8e5a72599fn,
  0x8000000000162e42fefa3bdb315934a2n,
  0x80000000000b17217f7d1d7299b49c46n,
  0x8000000000058b90bfbe8e9a8d1c4ea0n,
  0x800000000002c5c85fdf4745969ea76fn,
  0x80000000000162e42fefa3a0df5373bfn,
  0x800000000000b17217f7d1cff4aac1e1n,
  0x80000000000058b90bfbe8e7db95a2f1n,
  0x8000000000002c5c85fdf473e61ae1f8n,
  0x800000000000162e42fefa39f121751cn,
  0x8000000000000b17217f7d1cf815bb96n,
  0x800000000000058b90bfbe8e7bec1e0dn,
  0x80000000000002c5c85fdf473dee5f17n,
  0x8000000000000162e42fefa39ef5438fn,
  0x80000000000000b17217f7d1cf7a26c8n,
  0x8000000000000058b90bfbe8e7bcf4a4n,
  0x800000000000002c5c85fdf473de72a2n,
  0x80000000000000162e42fefa39ef3765n,
  0x800000000000000b17217f7d1cf79b37n,
  0x80000000000000058b90bfbe8e7bcd7dn,
  0x8000000000000002c5c85fdf473de6b6n,
  0x800000000000000162e42fefa39ef359n,
  0x8000000000000000b17217f7d1cf79acn,
  0x800000000000000058b90bfbe8e7bcd6n,
];

const ONE_127 = 1n << 127n;

/** `(a · b) >> 127` for two Q1.127 values in [1, 2), truncated to u128 as Rust's `(hi << 1) | (lo >> 127)`. */
function mulQ127(a: bigint, b: bigint): bigint {
  return ((a * b) >> 127n) & U128_MAX;
}

/** The index of the most significant set bit of `n > 0` (Rust's `127 - n.leading_zeros`). */
function msb(n: bigint): number {
  return n.toString(2).length - 1;
}

/** `log2(n)` for an integer `n ≥ 1`, as Q64.64, rounded down. `null` for `n == 0`. */
export function log2X64(n: bigint): bigint | null {
  assertU128(n, 'n');
  if (n === 0n) return null;
  const m0 = msb(n);
  // the mantissa n ÷ 2^msb, in [1, 2) as Q1.127
  let m = (n << BigInt(127 - m0)) & U128_MAX;
  let frac = 0n;
  for (let i = 1; i <= 64; i++) {
    // m² in [1, 4): p = m² · 2^254
    const p = m * m;
    const hi = p >> 128n;
    const lo = p & U128_MAX;
    if (hi >> 127n === 1n) {
      // m² ≥ 2: this binary digit is 1, and m = m² ÷ 2
      frac |= 1n << BigInt(64 - i);
      m = hi;
    } else {
      m = ((hi << 1n) & U128_MAX) | (lo >> 127n);
    }
  }
  return (BigInt(m0) << 64n) | frac;
}

/** `2^y` for `y` in Q64.64, as Q64.64, rounded down. `null` when the result does not fit (`y ≥ 64`). */
export function exp2X64(y: bigint): bigint | null {
  assertU128(y, 'y');
  const int = y >> 64n;
  if (int >= 64n) return null;
  let r = ONE_127;
  for (let i = 1; i <= 64; i++) {
    if (((y >> BigInt(64 - i)) & 1n) === 1n) {
      r = mulQ127(r, K[i - 1]);
    }
  }
  // r is 2^frac in Q1.127; 2^int · r in Q64.64 is r >> (63 − int)
  return r >> (63n - int);
}

// Port of the protocol's reference math (Rust). Never edit the math here
// without the same change in the reference; the golden vectors decide.
// the reference math's `lib.rs`: the modules, `BPS` and `MathError`. Rust is the definition; the tests hold every port to the
// crate's goldens.
//
// Errors: where Rust returns `Err(MathError::X)` this THROWS a `FloorMathError` whose `.code` is "X". Inputs Rust's types
// cannot hold throw a `RangeError` — a programmer error, not a math outcome.

export { log2X64, exp2X64 } from './fixed';

/** 10,000 bps = 100 %. */
export const BPS = 10_000n;

/** `MathError`, APPEND-ONLY. */
export type MathErrorCode =
  | 'RatioOutOfRange'
  | 'VaultShareOutOfRange'
  | 'Zero'
  | 'Overflow'
  | 'RampOutOfRange'
  | 'UnknownPreset'
  | 'PresetInvalid'
  | 'NotOutside'
  | 'Locked'
  /** (APPENDED) the Token Option: the Token Option's next release is not due yet (its clock). */
  | 'NotDue';

/** Rust's `MathError`, thrown. `.code` is the variant's name. */
export class FloorMathError extends Error {
  readonly code: MathErrorCode;
  constructor(code: MathErrorCode) {
    super(`floor-math: ${code}`);
    this.name = 'FloorMathError';
    this.code = code;
  }
}

export function fail(code: MathErrorCode): never {
  throw new FloorMathError(code);
}

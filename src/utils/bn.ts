import BigNumber from 'bignumber.js';

/**
 * Deterministic arithmetic.
 *
 * Floating point is banned across the engine: every numeric value that participates in
 * consensus (supplies, prices, royalties) is carried as an integer/decimal **string**
 * and manipulated with bignumber.js using fixed rounding modes.
 *
 * The configuration below is identical to the one frozen inside the sandbox
 * (see `vm/sandbox.ts`): host-side validation must agree with contract-side maths bit
 * for bit, and neither may depend on library defaults that could change upstream.
 */

/** STEEM asset precision: 3 decimal places. */
export const AMOUNT_DECIMAL_PLACES = 3;
/** Basis points denominator (100% = 10_000 bps). */
export const BPS_DENOMINATOR = 10_000;

BigNumber.config({
  DECIMAL_PLACES: 20,
  ROUNDING_MODE: BigNumber.ROUND_DOWN,
  EXPONENTIAL_AT: [-100, 100],
});

const UINT_RE = /^[0-9]{1,20}$/;
const AMOUNT_RE = /^[0-9]{1,15}(\.[0-9]{1,3})?$/;

export function isUintString(value: unknown): value is string {
  return typeof value === 'string' && UINT_RE.test(value);
}

/** Validates an unsigned integer string; throws otherwise. */
export function assertUintString(value: unknown, label = 'value'): string {
  if (!isUintString(value)) throw new Error(`${label} must be an unsigned integer string`);
  return value;
}

/** Validates a fixed-point amount string (max 3 decimal places). */
export function isAmountString(value: unknown): value is string {
  return typeof value === 'string' && AMOUNT_RE.test(value);
}

export function assertAmountString(value: unknown, label = 'amount'): string {
  if (!isAmountString(value)) {
    throw new Error(`${label} must be a decimal string with at most ${AMOUNT_DECIMAL_PLACES} fractional digits`);
  }
  return value;
}

export function bn(value: string): BigNumber {
  return new BigNumber(value);
}

/** Integer string addition (a + b). */
export function addUint(a: string, b: string): string {
  return new BigNumber(assertUintString(a, 'lhs')).plus(assertUintString(b, 'rhs')).toFixed(0);
}

/** Integer string subtraction (a - b). Throws when the result would go negative. */
export function subUint(a: string, b: string): string {
  const res = new BigNumber(assertUintString(a, 'lhs')).minus(assertUintString(b, 'rhs'));
  if (res.isNegative()) throw new Error(`underflow: ${a} - ${b}`);
  return res.toFixed(0);
}

export function cmpUint(a: string, b: string): number {
  return new BigNumber(a).comparedTo(b) ?? Number.NaN;
}

/**
 * Splits a price into seller proceeds and creator royalty.
 *
 * The royalty is rounded **down** and the remainder goes to the seller, so the split
 * always sums exactly to the price (no minted/lost units).
 */
export function splitRoyalty(
  price: string,
  royaltyBps: string,
): { price: string; royalty: string; sellerProceeds: string } {
  const p = new BigNumber(assertAmountString(price, 'price'));
  const bps = new BigNumber(assertUintString(royaltyBps, 'royaltyBps'));
  if (bps.gt(BPS_DENOMINATOR)) throw new Error('royaltyBps exceeds 10000');
  const royalty = p.times(bps).div(BPS_DENOMINATOR).decimalPlaces(AMOUNT_DECIMAL_PLACES, BigNumber.ROUND_DOWN);
  const proceeds = p.minus(royalty).decimalPlaces(AMOUNT_DECIMAL_PLACES, BigNumber.ROUND_DOWN);
  if (royalty.plus(proceeds).comparedTo(p) !== 0) throw new Error('royalty split does not reconcile');
  return {
    price: p.toFixed(),
    royalty: royalty.toFixed(AMOUNT_DECIMAL_PLACES),
    sellerProceeds: proceeds.toFixed(AMOUNT_DECIMAL_PLACES),
  };
}

/** Left-pad a number with zeroes, e.g. seq 42 -> "00000042". */
export function pad(seq: number, width: number): string {
  let out = String(seq);
  while (out.length < width) out = '0' + out;
  return out;
}

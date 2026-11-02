import { createHash } from 'node:crypto';

/**
 * Canonical JSON helpers.
 *
 * Deterministic serialisation is what makes state hashes and test assertions stable:
 * object keys are always emitted in sorted order and numbers must be integral (floats
 * are rejected because their textual form is not portable across engines).
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number is not canonicalisable');
    if (!Number.isInteger(value)) throw new Error(`floating point value ${value} is not allowed in canonical JSON`);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue;
      out[key] = normalize(v);
    }
    return out;
  }
  throw new Error(`cannot canonicalise value of type ${typeof value}`);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable content fingerprint of any JSON-ish structure. */
export function fingerprint(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), 'utf8');
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

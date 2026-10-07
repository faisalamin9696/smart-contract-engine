import { MAX_PAYLOAD_BYTES, parseEnvelope, PayloadError, type ActionName } from '../types/actions';
import type { JsonMap } from '../types/domain';
import type { RawBlock } from './rpc';

/** Chain-verified authorities attached to a `custom_json` operation. */
export interface OpAuth {
  active: string[];
  posting: string[];
  /** Primary actor used for logging/audit (first active, else first posting authority). */
  actor: string;
  level: 'active' | 'posting' | 'none';
}

export interface OpBase {
  txId: string;
  opIndex: number;
  auth: OpAuth;
}

export interface ParsedOp extends OpBase {
  ok: true;
  action: ActionName;
  params: Record<string, unknown>;
}

export interface RejectedOp extends OpBase {
  ok: false;
  action: string;
  code: string;
  message: string;
  params: JsonMap;
}

export type OpResult = ParsedOp | RejectedOp;

export interface BlockParseResult {
  ops: OpResult[];
  /** Number of unrelated operations/transactions skipped. */
  skipped: number;
}

function toAuth(raw: Record<string, unknown>): OpAuth {
  const active = Array.isArray(raw.required_auths) ? (raw.required_auths as unknown[]).map(String) : [];
  const posting = Array.isArray(raw.required_posting_auths)
    ? (raw.required_posting_auths as unknown[]).map(String)
    : [];
  if (active.length > 0) return { active, posting, actor: active[0], level: 'active' };
  if (posting.length > 0) return { active, posting, actor: posting[0], level: 'posting' };
  return { active, posting, actor: '', level: 'none' };
}

/**
 * Extracts and validates `custom_json` operations matching the engine's op id.
 *
 * Blocks are processed exactly as produced by consensus: ordering within the block
 * (transaction index, then operation index) is preserved so replay is byte-identical.
 */
export function parseBlock(block: RawBlock, opId: string): BlockParseResult {
  const ops: OpResult[] = [];
  let skipped = 0;
  const txIds = block.transaction_ids ?? [];

  block.transactions.forEach((tx, txIndex) => {
    const txId = txIds[txIndex] ?? `tx-${txIndex}`;
    (tx.operations ?? []).forEach((operation, opIndex) => {
      const [kind, payload] = operation;
      if (kind !== 'custom_json') {
        skipped += 1;
        return;
      }
      if (payload?.id !== opId) {
        skipped += 1;
        return;
      }
      const auth = toAuth(payload);
      const base: OpBase = { txId, opIndex, auth };
      const rawJson = typeof payload.json === 'string' ? payload.json : null;

      if (rawJson === null) {
        ops.push({
          ...base,
          ok: false,
          action: 'unknown',
          code: 'INVALID_JSON',
          message: 'custom_json.json must be a string',
          params: {},
        });
        return;
      }
      if (Buffer.byteLength(rawJson, 'utf8') > MAX_PAYLOAD_BYTES) {
        ops.push({
          ...base,
          ok: false,
          action: 'unknown',
          code: 'PAYLOAD_TOO_LARGE',
          message: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
          params: {},
        });
        return;
      }
      if (auth.level === 'none') {
        ops.push({
          ...base,
          ok: false,
          action: 'unknown',
          code: 'NO_AUTHORITY',
          message: 'operation carries no required authority',
          params: {},
        });
        return;
      }
      try {
        const envelope = parseEnvelope(rawJson);
        ops.push({ ...base, ok: true, action: envelope.action, params: envelope.params });
      } catch (err) {
        const pe = err instanceof PayloadError ? err : new PayloadError('INVALID_PAYLOAD', String(err));
        let action = 'unknown';
        try {
          const parsed = JSON.parse(rawJson) as { action?: unknown; contractAction?: unknown };
          action = String(parsed.action ?? parsed.contractAction ?? 'unknown');
        } catch {
          /* keep 'unknown' */
        }
        ops.push({ ...base, ok: false, action, code: pe.code, message: pe.message, params: {} });
      }
    });
  });

  return { ops, skipped };
}

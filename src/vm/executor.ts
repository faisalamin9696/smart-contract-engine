import type { OpResult, ParsedOp } from '../chain/opParser';
import type {
  Balance,
  EngineEvent,
  JsonMap,
  JsonValue,
  Mutation,
  StateSnapshot,
  TransactionLogRecord,
  TxStatus,
} from '../types/domain';
import { buildSnapshot } from '../state/snapshot';
import type { StateTxn } from '../state/stateTxn';
import { GuardError } from '../state/stateTxn';
import type { EngineStore } from '../state/store';
import { MutationGuardError, validateMutations } from './guard';
import type { ExecContext, Sandbox } from './sandbox';

export interface BlockHeader {
  height: number;
  blockId: string;
  timestamp: string;
}

export interface ExecuteOpArgs {
  store: EngineStore;
  sandbox: Sandbox;
  txn: StateTxn;
  block: BlockHeader;
  op: OpResult;
}

export interface OpOutcome {
  log: TransactionLogRecord;
  events: EngineEvent[];
  /** True when state mutations were committed for this op. */
  applied: boolean;
}

function logId(block: BlockHeader, op: { txId: string; opIndex: number }): string {
  return `${block.height}:${op.txId}:${op.opIndex}`;
}

function bestEffort(params: Record<string, unknown>, field: string): string | null {
  const value = params[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Best-effort global instance reference for the log row: either a literal `instanceId`
 * or the wiki-style `symbol` + `id` pair (e.g. `placeOrder`), joined as `<SYMBOL>:<id>`.
 */
function instanceRef(params: Record<string, unknown>): string | null {
  const direct = bestEffort(params, 'instanceId');
  if (direct !== null) return direct;
  const { symbol, id } = params;
  if (typeof symbol === 'string' && typeof id === 'string' && id !== '') {
    return `${symbol}:${id}`;
  }
  return null;
}

function baseLog(
  block: BlockHeader,
  op: OpResult,
  status: TxStatus,
  action: string,
  params: Record<string, unknown>,
  error: { code: string; message: string } | null,
): TransactionLogRecord {
  return {
    id: logId(block, op),
    height: block.height,
    blockId: block.blockId,
    txId: op.txId,
    opIndex: op.opIndex,
    action,
    actor: op.auth.actor || 'unknown',
    authLevel: op.auth.level,
    symbol: bestEffort(params, 'symbol'),
    instanceId: instanceRef(params),
    status,
    params: params as unknown as JsonMap,
    error,
    mutations: null,
    events: null,
    timestamp: block.timestamp,
  };
}

/**
 * One `BALANCE_CHANGED` event per holder whose balance row actually moved.
 *
 * Synthesized host-side from the committed write-set (never in the guest), so every
 * credit and debit is covered — token issue/transfer/burn legs, fee debits and
 * marketplace settlement legs — without touching consensus-critical contract code.
 * One event per key: the last write wins, matching the row that was committed, and
 * rows whose quantity did not change are skipped.
 */
function balanceChangedEvents(
  mutations: readonly Mutation[],
  snapshot: StateSnapshot,
  block: BlockHeader,
  op: { txId: string; action: string },
): EngineEvent[] {
  const balances = new Map<string, Mutation>();
  for (const mutation of mutations) {
    if (mutation.entity === 'balance') balances.set(mutation.key, mutation);
  }
  const events: EngineEvent[] = [];
  for (const [key, mutation] of balances) {
    const after = mutation.value as unknown as Balance | null;
    if (after === null || typeof after.quantity !== 'string') continue;
    const previous = snapshot.balance[key]?.quantity ?? '0';
    if (previous === after.quantity) continue;
    events.push({
      type: 'BALANCE_CHANGED',
      block: block.height,
      txId: op.txId,
      timestamp: block.timestamp,
      account: after.account,
      symbol: after.symbol,
      data: { previous, balance: after.quantity, action: op.action },
    });
  }
  return events;
}

/**
 * Executes one parsed chain operation:
 * prefetch -> sandbox -> guard -> journaled write.
 *
 * A failure at any stage marks the operation FAILED in the transaction log and leaves
 * state untouched; block processing continues (failed user ops must never halt the chain).
 */
export async function executeOp(args: ExecuteOpArgs): Promise<OpOutcome> {
  const { store, sandbox, txn, block, op } = args;

  if (!op.ok) {
    const log = baseLog(block, op, 'FAILED', op.action, op.params, { code: op.code, message: op.message });
    await store.putLog(log);
    return {
      log,
      events: [
        {
          type: 'TX_FAILED',
          block: block.height,
          txId: op.txId,
          timestamp: block.timestamp,
          data: { action: op.action, code: op.code, message: op.message },
        },
      ],
      applied: false,
    };
  }

  const parsedOp = op as ParsedOp;
  // Ops built outside `parseBlock` (tests) may omit the field; absence = legacy `nft`.
  const contract = parsedOp.contract ?? 'nft';
  const snapshot: StateSnapshot = await buildSnapshot(
    store,
    contract,
    parsedOp.action,
    parsedOp.params,
    parsedOp.auth,
  );

  const context: ExecContext = {
    action: parsedOp.action,
    contract,
    actor: parsedOp.auth.actor,
    auths: { active: parsedOp.auth.active, posting: parsedOp.auth.posting },
    blockHeight: block.height,
    blockId: block.blockId,
    timestamp: block.timestamp,
    txId: parsedOp.txId,
    opIndex: parsedOp.opIndex,
  };

  let response;
  try {
    response = await sandbox.execute({ context, params: parsedOp.params, state: snapshot });
  } catch (err) {
    const log = baseLog(block, parsedOp, 'FAILED', parsedOp.action, parsedOp.params, {
      code: 'VM_CRASH',
      message: (err as Error).message,
    });
    await store.putLog(log);
    return {
      log,
      events: [
        {
          type: 'TX_FAILED',
          block: block.height,
          txId: parsedOp.txId,
          timestamp: block.timestamp,
          data: { action: parsedOp.action, code: 'VM_CRASH', message: (err as Error).message },
        },
      ],
      applied: false,
    };
  }

  if (!response.ok) {
    const log = baseLog(block, parsedOp, 'FAILED', parsedOp.action, parsedOp.params, response.error);
    await store.putLog(log);
    return {
      log,
      events: [
        {
          type: 'TX_FAILED',
          block: block.height,
          txId: parsedOp.txId,
          timestamp: block.timestamp,
          data: { action: parsedOp.action, code: response.error.code, message: response.error.message },
        },
      ],
      applied: false,
    };
  }

  let mutations: Mutation[];
  try {
    mutations = validateMutations(contract, parsedOp.action, response.mutations, snapshot);
  } catch (err) {
    const guardError =
      err instanceof MutationGuardError
        ? { code: err.code, message: err.message }
        : { code: 'GUARD_REJECTED', message: (err as Error).message };
    const log = baseLog(block, parsedOp, 'FAILED', parsedOp.action, parsedOp.params, guardError);
    await store.putLog(log);
    return {
      log,
      events: [
        {
          type: 'TX_FAILED',
          block: block.height,
          txId: parsedOp.txId,
          timestamp: block.timestamp,
          data: { action: parsedOp.action, code: guardError.code, message: guardError.message },
        },
      ],
      applied: false,
    };
  }

  try {
    await txn.apply(mutations, snapshot);
  } catch (err) {
    const guardError =
      err instanceof GuardError
        ? { code: err.code, message: err.message }
        : { code: 'STORAGE_ERROR', message: (err as Error).message };
    const log = baseLog(block, parsedOp, 'FAILED', parsedOp.action, parsedOp.params, guardError);
    await store.putLog(log);
    return {
      log,
      events: [
        {
          type: 'TX_FAILED',
          block: block.height,
          txId: parsedOp.txId,
          timestamp: block.timestamp,
          data: { action: parsedOp.action, code: guardError.code, message: guardError.message },
        },
      ],
      applied: false,
    };
  }

  const vmEvents = [
    ...response.events.map((event) => ({ ...event, txId: parsedOp.txId })),
    ...balanceChangedEvents(mutations, snapshot, block, parsedOp),
  ];
  const instanceFromEvents = vmEvents.find((e) => typeof e.instanceId === 'string')?.instanceId ?? null;
  const log = baseLog(block, parsedOp, 'APPLIED', parsedOp.action, parsedOp.params, null);
  log.symbol = bestEffort(parsedOp.params, 'symbol') ?? vmEvents.find((e) => e.symbol)?.symbol ?? null;
  log.instanceId = instanceRef(parsedOp.params) ?? instanceFromEvents;
  log.mutations = mutations as unknown as JsonValue;
  log.events = vmEvents as unknown as JsonValue;
  await store.putLog(log);

  return { log, events: vmEvents, applied: true };
}

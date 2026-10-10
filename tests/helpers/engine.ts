import type { OpAuth, ParsedOp } from '../../src/chain/opParser';
import { MemoryStore } from '../../src/state/memoryStore';
import { StateTxn } from '../../src/state/stateTxn';
import type { EngineStore } from '../../src/state/store';
import { EngineEventBus } from '../../src/indexer/events';
import type { BlockHeader, OpOutcome } from '../../src/vm/executor';
import { executeOp } from '../../src/vm/executor';
import { createSandbox, type Sandbox, type SandboxOptions } from '../../src/vm/sandbox';
import { BalanceSchema, BookOrderSchema, CollectionSchema, InstanceSchema, MarketOrderSchema, ParamSchema, TokenSchema } from '../../src/types/domain';
import type { Balance, BookOrder, Collection, Instance, MarketOrder, Mutation, Param, Token } from '../../src/types/domain';
import { PARAM_KEY } from '../../src/types/domain';
import type { ContractName } from '../../src/types/actions';

export const DEFAULT_HEADER: BlockHeader = {
  height: 1,
  blockId: 'a'.repeat(40),
  timestamp: '2026-01-01T00:00:00',
};

/** Per-test driver: executes actions against an in-memory store through the real VM. */
export class TestEngine {
  readonly store: MemoryStore;
  readonly bus = new EngineEventBus();
  readonly outcomes: OpOutcome[] = [];

  private txCounter = 0;

  private constructor(
    readonly sandbox: Sandbox,
    store?: MemoryStore,
  ) {
    this.store = store ?? new MemoryStore();
  }

  static async create(
    options: Partial<SandboxOptions> = {},
    store?: MemoryStore,
  ): Promise<TestEngine> {
    const sandbox = await createSandbox({
      provider: options.provider ?? 'auto',
      timeoutMs: options.timeoutMs ?? 1000,
      memoryLimitMb: options.memoryLimitMb ?? 128,
      contractSource: options.contractSource,
      bootstrapTimeoutMs: options.bootstrapTimeoutMs,
    });
    return new TestEngine(sandbox, store);
  }

  async exec(
    action: string,
    params: Record<string, unknown>,
    auth: OpAuth,
    header: Partial<BlockHeader> = {},
    contract: ContractName = 'nft',
  ): Promise<OpOutcome> {
    const hdr: BlockHeader = { ...DEFAULT_HEADER, ...header };
    const op = {
      ok: true,
      contract,
      action,
      params,
      txId: `tx-${String(++this.txCounter).padStart(8, '0')}`,
      opIndex: 0,
      auth,
    } as unknown as ParsedOp;
    const outcome = await executeOp({
      store: this.store,
      sandbox: this.sandbox,
      txn: new StateTxn(this.store),
      block: hdr,
      op,
    });
    this.outcomes.push(outcome);
    return outcome;
  }

  /** Executes and fails the test when the op did not apply (keeps happy-path tests terse). */
  async execOk(
    action: string,
    params: Record<string, unknown>,
    auth: OpAuth,
    header: Partial<BlockHeader> = {},
    contract: ContractName = 'nft',
  ): Promise<OpOutcome> {
    const outcome = await this.exec(action, params, auth, header, contract);
    if (!outcome.applied) {
      throw new Error(`expected ${contract}.${action} to apply but it failed: ${JSON.stringify(outcome.log.error)}`);
    }
    return outcome;
  }

  async execFail(
    action: string,
    params: Record<string, unknown>,
    auth: OpAuth,
    header: Partial<BlockHeader> = {},
    contract: ContractName = 'nft',
  ): Promise<OpOutcome> {
    const outcome = await this.exec(action, params, auth, header, contract);
    if (outcome.applied) {
      throw new Error(`expected ${contract}.${action} to fail but it applied`);
    }
    return outcome;
  }

  async collection(symbol: string): Promise<Collection | null> {
    const raw = await this.store.get('collection', symbol);
    return raw === null ? null : CollectionSchema.parse(raw);
  }

  /** Fungible token row (`tokens` contract), by symbol. */
  async token(symbol: string): Promise<Token | null> {
    const raw = await this.store.get('token', symbol);
    return raw === null ? null : TokenSchema.parse(raw);
  }

  /** Holder row of the fungible `balance` table, keyed `<account>:<SYMBOL>`. */
  async balance(account: string, symbol: string): Promise<Balance | null> {
    const raw = await this.store.get('balance', `${account}:${symbol}`);
    return raw === null ? null : BalanceSchema.parse(raw);
  }

  /** Fee-schedule row (entity `param`, single key `param`). */
  async param(): Promise<Param | null> {
    const raw = await this.store.get('param', PARAM_KEY);
    return raw === null ? null : ParamSchema.parse(raw);
  }

  /**
   * Resolves an instance by its global reference `<SYMBOL>:<id>`, or by a bare wiki
   * token id when the owning symbol is supplied.
   */
  async instance(idOrKey: string, symbol?: string): Promise<Instance | null> {
    const key = idOrKey.includes(':')
      ? idOrKey
      : symbol !== undefined && symbol !== ''
        ? `${symbol}:${idOrKey}`
        : idOrKey;
    const raw = await this.store.get('instance', key);
    return raw === null ? null : InstanceSchema.parse(raw);
  }

  async order(id: string): Promise<MarketOrder | null> {
    const raw = await this.store.get('order', id);
    return raw === null ? null : MarketOrderSchema.parse(raw);
  }

  /** Fungible market book order (`marketOrder` entity), by id. */
  async bookOrder(id: string): Promise<BookOrder | null> {
    const raw = await this.store.get('marketOrder', id);
    return raw === null ? null : BookOrderSchema.parse(raw);
  }

  async journalEntries(height = 1): Promise<Mutation[]> {
    const entries = await this.store.getJournal(height);
    return (entries ?? []) as unknown as Mutation[];
  }

  async dispose(): Promise<void> {
    await this.sandbox.dispose();
    await this.store.close();
  }
}

export async function openStore(): Promise<MemoryStore> {
  return new MemoryStore();
}

export type { EngineStore };

import * as fs from 'node:fs';
import * as vm from 'node:vm';
import type { Logger } from '../logger';
import type { ContractName } from '../types/actions';
import type { EngineEvent, StateSnapshot } from '../types/domain';
import { CONTRACT_SOURCE } from './contractSource';

/**
 * Sandboxed execution providers.
 *
 * Both providers run the *identical* contract bytes:
 *  - `isolated-vm` (preferred): a separate V8 isolate with hard heap and time limits —
 *    no shared heap, no Node bindings, no escape into the host;
 *  - `node-vm` (fallback): a fresh V8 context created with `codeGeneration` disabled and
 *    no host globals. Used automatically when the native isolated-vm addon is not
 *    available (e.g. missing build toolchain), keeping behaviour byte-identical.
 *
 * `vm2` is deliberately not used: it is discontinued and has published sandbox escapes.
 */

export interface ExecContext {
  action: string;
  /** Contract selected by the envelope; defaults to `nft` when absent (back-compat). */
  contract?: ContractName;
  actor: string;
  auths: { active: string[]; posting: string[] };
  blockHeight: number;
  blockId: string;
  /** Block header time (ISO) — the only clock the VM may observe. */
  timestamp: string;
  txId: string;
  opIndex: number;
}

export interface SandboxRequest {
  context: ExecContext;
  params: Record<string, unknown>;
  state: StateSnapshot;
}

export interface SandboxSuccess {
  ok: true;
  mutations: unknown[];
  events: EngineEvent[];
}

export interface SandboxFailure {
  ok: false;
  error: { code: string; message: string };
}

export type SandboxResponse = SandboxSuccess | SandboxFailure;

export interface Sandbox {
  readonly provider: string;
  execute(request: SandboxRequest): Promise<SandboxResponse>;
  dispose(): Promise<void>;
}

export interface SandboxOptions {
  provider: 'auto' | 'isolated-vm' | 'node-vm';
  timeoutMs: number;
  memoryLimitMb: number;
  bootstrapTimeoutMs?: number;
  /**
   * Advanced/testing: replace the contract source that is compiled into the sandbox.
   * Production always uses {@link CONTRACT_SOURCE}.
   */
  contractSource?: string;
  /**
   * Optional structured logger — used to announce an `auto` fallback from isolated-vm
   * to node-vm loudly instead of degrading silently (operators should know which
   * isolation level their node is actually running).
   */
  logger?: Pick<Logger, 'warn'>;
}

const BLOCKED_GLOBALS = [
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'queueMicrotask',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'require',
  'process',
  'Buffer',
  // Node injects its own host-realm `console` into vm contexts; isolated-vm contexts
  // carry one too. The contract never logs, and a host-bound console would be both
  // an escape surface (host function objects in the guest) and a log-spam vector.
  'console',
  'WebAssembly',
  'SharedArrayBuffer',
  'Atomics',
  'eval',
];

/**
 * Loads bignumber.js (UMD) into a bare global and freezes out every ambient API that
 * could introduce non-determinism or host access.
 */
function buildSandboxSource(contractSource: string): string {
  const bignumberPath = require.resolve('bignumber.js');
  const bignumberSource = fs.readFileSync(bignumberPath, 'utf8');
  const hardening = `
(function () {
  'use strict';
  var blocked = ${JSON.stringify(BLOCKED_GLOBALS)};
  for (var i = 0; i < blocked.length; i++) {
    try { delete globalThis[blocked[i]]; } catch (e) { /* non-configurable */ }
  }
  globalThis.Math.random = function () {
    throw new Error('Math.random is unavailable inside the deterministic VM');
  };
  globalThis.Date = function Date() {
    throw new Error('Date is unavailable inside the deterministic VM: use context.timestamp');
  };
  // Freeze the arithmetic configuration: rounding must not depend on library defaults,
  // which could change with a future bignumber.js release.
  globalThis.BigNumber.config({
    DECIMAL_PLACES: 20,
    ROUNDING_MODE: globalThis.BigNumber.ROUND_DOWN,
    EXPONENTIAL_AT: [-100, 100],
  });
})();
`;
  return [
    '(function () {',
    '  var module = { exports: {} };',
    '  var exports = module.exports;',
    bignumberSource,
    '  globalThis.BigNumber = module.exports;',
    '})();',
    hardening,
    contractSource,
  ].join('\n');
}

/** Minimal structural types so the optional native dependency is not needed to typecheck. */
interface IvmReference {
  apply(receiver: unknown, args: unknown[], options?: { timeout?: number }): Promise<unknown>;
  release?(): void;
}
interface IvmContext {
  global: { get(name: string, options?: { reference?: boolean }): Promise<unknown> };
  release?(): void;
}
interface IvmScript {
  run(context: IvmContext, options?: { timeout?: number }): Promise<unknown>;
}
interface IvmIsolate {
  createContext(options?: unknown): Promise<IvmContext>;
  compileScript(code: string): Promise<IvmScript>;
  dispose(): void;
}
interface IvmModule {
  Isolate: new (options: { memoryLimit: number }) => IvmIsolate;
}

function payloadFor(request: SandboxRequest): string {
  return JSON.stringify({
    action: request.context.action,
    contract: request.context.contract === undefined ? 'nft' : request.context.contract,
    context: request.context,
    params: request.params,
    state: request.state,
  });
}

class IsolatedVmSandbox implements Sandbox {
  readonly provider = 'isolated-vm';

  private constructor(
    private readonly isolate: IvmIsolate,
    private readonly context: IvmContext,
    private readonly execRef: IvmReference,
    private readonly timeoutMs: number,
  ) {}

  static async create(source: string, options: SandboxOptions): Promise<IsolatedVmSandbox> {
    // Lazy require: isolated-vm is an optional native dependency.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ivm = require('isolated-vm') as IvmModule;
    const isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb });
    try {
      const context = await isolate.createContext();
      const script = await isolate.compileScript(source);
      await script.run(context, { timeout: options.bootstrapTimeoutMs ?? options.timeoutMs * 5 });
      const execRef = (await context.global.get('__nftExecute', {
        reference: true,
      })) as unknown as IvmReference;
      return new IsolatedVmSandbox(isolate, context, execRef, options.timeoutMs);
    } catch (err) {
      isolate.dispose();
      throw err;
    }
  }

  async execute(request: SandboxRequest): Promise<SandboxResponse> {
    const payload = payloadFor(request);
    const raw = await this.execRef.apply(undefined, [payload], { timeout: this.timeoutMs });
    if (typeof raw !== 'string') throw new Error('sandbox returned a non-string response');
    return parseResponse(raw);
  }

  async dispose(): Promise<void> {
    try {
      this.execRef.release?.();
      this.context.release?.();
    } finally {
      this.isolate.dispose();
    }
  }
}

class NodeVmSandbox implements Sandbox {
  readonly provider = 'node-vm';
  private readonly context: vm.Context;
  private readonly timeoutMs: number;

  constructor(source: string, options: SandboxOptions) {
    this.timeoutMs = options.timeoutMs;
    this.context = vm.createContext(Object.create(null) as object, {
      name: 'sce-contract',
      codeGeneration: { strings: false, wasm: false },
    });
    vm.runInContext(source, this.context, {
      timeout: options.bootstrapTimeoutMs ?? options.timeoutMs * 5,
      displayErrors: true,
      breakOnSigint: true,
    });
  }

  async execute(request: SandboxRequest): Promise<SandboxResponse> {
    const payload = payloadFor(request);
    // `payload` is produced by JSON.stringify, so embedding it is a valid JS string literal.
    const raw = vm.runInContext(`globalThis.__nftExecute(${JSON.stringify(payload)})`, this.context, {
      timeout: this.timeoutMs,
      displayErrors: true,
      breakOnSigint: true,
    });
    if (typeof raw !== 'string') throw new Error('sandbox returned a non-string response');
    return parseResponse(raw);
  }

  async dispose(): Promise<void> {
    /* contexts are released by the GC once the sandbox is dropped */
  }
}

function parseResponse(raw: string): SandboxResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('sandbox returned malformed JSON');
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('sandbox returned a non-object response');
  const value = parsed as { ok?: unknown; mutations?: unknown; events?: unknown; error?: unknown };
  if (value.ok === true) {
    return {
      ok: true,
      mutations: Array.isArray(value.mutations) ? value.mutations : [],
      events: Array.isArray(value.events) ? (value.events as EngineEvent[]) : [],
    };
  }
  const error = (value.error ?? {}) as { code?: unknown; message?: unknown };
  return {
    ok: false,
    error: {
      code: typeof error.code === 'string' ? error.code : 'VM_ERROR',
      message: typeof error.message === 'string' ? error.message : 'unknown sandbox failure',
    },
  };
}

export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
  const source = buildSandboxSource(options.contractSource ?? CONTRACT_SOURCE);
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? options.timeoutMs * 5;

  if (options.provider === 'isolated-vm' || options.provider === 'auto') {
    try {
      return await IsolatedVmSandbox.create(source, { ...options, bootstrapTimeoutMs });
    } catch (err) {
      if (options.provider === 'isolated-vm') throw err;
      // auto: fall back to the node-vm provider with identical contract semantics —
      // but say so loudly; a production operator deserves to know their node is not
      // running the hardened isolate (health/`sandbox` reports the live provider too).
      options.logger?.warn('isolated-vm unavailable — degrading to node-vm sandbox', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return new NodeVmSandbox(source, { ...options, bootstrapTimeoutMs });
}

/**
 * Production isolation gate (docs/SECURITY.md → "Sandbox provider contract").
 *
 * The native isolate is a hard dependency, and `provider: 'auto'` must never quietly
 * boot the unhardened `node-vm` fallback: an install path that skipped or broke the
 * addon (`--omit=optional` on older layouts, a failed prebuild, a stripped image)
 * would otherwise serve with reduced containment. In production that downgrade must
 * stop the engine instead of serving: the same "no silent fallback" rule the boot
 * already applies to STORAGE/DATABASE_URL (src/index.ts).
 *
 * The one deliberate escape hatch stays available: an explicit
 * `SANDBOX_PROVIDER=node-vm` documents a conscious choice to run unhardened.
 */
export function assertProductionSandbox(
  configured: SandboxOptions['provider'],
  actual: string,
): void {
  if (configured === 'node-vm') return; // explicit opt-out — logged at boot
  if (actual === 'isolated-vm') return;
  throw new Error(
    `production requires the isolated-vm sandbox but the live provider is "${actual}" — ` +
      'the native addon is missing or failed to load (check the image/install produced ' +
      'node_modules with it, and the Node version, or set SANDBOX_PROVIDER=node-vm to ' +
      'accept the unhardened fallback explicitly)',
  );
}

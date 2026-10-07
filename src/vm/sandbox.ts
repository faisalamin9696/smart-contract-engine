import * as fs from 'node:fs';
import * as vm from 'node:vm';
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
      name: 'steemcraft-nft-contract',
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
      // auto: silently degrade to the node-vm provider with identical contract semantics.
    }
  }
  return new NodeVmSandbox(source, { ...options, bootstrapTimeoutMs });
}

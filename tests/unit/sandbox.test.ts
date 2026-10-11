import { assertProductionSandbox } from '../../src/vm/sandbox';
import { createSandbox, emptyRequest, type Sandbox } from '../helpers/sandboxHelpers';

/**
 * Production isolation gate: `auto` must never quietly boot the unhardened node-vm
 * fallback under NODE_ENV=production (docs/SECURITY.md → "Sandbox provider
 * contract").
 */
describe('production isolation gate (assertProductionSandbox)', () => {
  it('refuses to boot production after an auto downgrade to node-vm', () => {
    expect(() => assertProductionSandbox('auto', 'node-vm')).toThrow(
      /production requires the isolated-vm sandbox/,
    );
  });

  it('refuses an explicit isolated-vm request that did not land', () => {
    expect(() => assertProductionSandbox('isolated-vm', 'node-vm')).toThrow(
      /production requires the isolated-vm sandbox/,
    );
  });

  it('points the operator at the remedy', () => {
    expect(() => assertProductionSandbox('auto', 'node-vm')).toThrow(
      /native addon[\s\S]*SANDBOX_PROVIDER=node-vm/,
    );
  });

  it('allows a conscious SANDBOX_PROVIDER=node-vm opt-out', () => {
    expect(() => assertProductionSandbox('node-vm', 'node-vm')).not.toThrow();
  });

  it('accepts the hardened isolate under every configuration', () => {
    expect(() => assertProductionSandbox('auto', 'isolated-vm')).not.toThrow();
    expect(() => assertProductionSandbox('isolated-vm', 'isolated-vm')).not.toThrow();
  });
});

/**
 * Sandbox hardening: no ambient APIs, hard time limits, and identical output across
 * providers (isolated-vm when available, node-vm otherwise).
 *
 * The availability probe must run at module scope: `describe.each` collects its
 * cases during the collection phase, before any `beforeAll` would execute — probing
 * there silently registered the node-vm variant only, so the isolated-vm matrix never
 * ran (in CI either).
 */
const providers: Array<'isolated-vm' | 'node-vm'> = ['node-vm'];
try {
  require.resolve('isolated-vm');
  providers.unshift('isolated-vm');
} catch {
  /* optional native dependency not installed */
}

describe('sandbox isolation', () => {

  describe.each(providers)('provider: %s', (provider) => {
    let sandbox: Sandbox;

    beforeAll(async () => {
      sandbox = await createSandbox(provider);
    });

    afterAll(async () => {
      await sandbox.dispose();
    });

    it('blocks Math.random', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            try { return JSON.stringify({ ok: true, mutations: [Math.random()], events: [] }); }
            catch (e) { return JSON.stringify({ ok: false, error: { code: 'THREW', message: String(e.message) } }); }
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('Math.random is unavailable');
      await isolated.dispose();
    });

    it('blocks Date (time comes from the block header)', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            try { return JSON.stringify({ ok: true, mutations: [String(new Date())], events: [] }); }
            catch (e) { return JSON.stringify({ ok: false, error: { code: 'THREW', message: String(e.message) } }); }
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('deterministic VM');
      await isolated.dispose();
    });

    it('has no access to host modules or globals', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            var probes = { require: typeof require, process: typeof process, Buffer: typeof Buffer, fetch: typeof fetch, setTimeout: typeof setTimeout };
            return JSON.stringify({ ok: true, mutations: [probes], events: [] });
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mutations[0]).toEqual({
          require: 'undefined',
          process: 'undefined',
          Buffer: 'undefined',
          fetch: 'undefined',
          setTimeout: 'undefined',
        });
      }
      await isolated.dispose();
    });

    it('cannot evaluate dynamic code (no eval / new Function)', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            try { eval('1'); return JSON.stringify({ ok: true, mutations: ['eval-works'], events: [] }); }
            catch (e) { return JSON.stringify({ ok: false, error: { code: 'THREW', message: String(e.message) } }); }
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('THREW');
      await isolated.dispose();
    });

    it('enforces a hard execution timeout', async () => {
      const isolated = await createSandbox(provider, {
        timeoutMs: 100,
        contractSource: `
          globalThis.__nftExecute = function () { while (true) {} };`,
      });
      await expect(isolated.execute(emptyRequest())).rejects.toThrow(/timeout|timed out/i);
      await isolated.dispose();
    });

    it('exposes bignumber for precise arithmetic', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            var v = new BigNumber('0.1').plus('0.2');
            return JSON.stringify({ ok: true, mutations: [v.toFixed()], events: [] });
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.mutations[0]).toBe('0.3');
      await isolated.dispose();
    });

    // ---------------------------------------------------------------------
    // White-hat probes: every property below is *asserted*, not assumed, on
    // each provider. They pin the trust boundary documented in
    // docs/SECURITY.md (the guest only ever returns JSON *text*; the host
    // re-validates everything).
    // ---------------------------------------------------------------------

    it('audits globalThis: no host realm or nondeterminism API is reachable', async () => {
      const sensitive = [
        // module/host access
        'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer',
        // dynamic code & exotic memory
        'eval', 'WebAssembly', 'SharedArrayBuffer', 'Atomics',
        // network / nondeterminism / clock / info leaks
        'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval',
        'setImmediate', 'clearTimeout', 'queueMicrotask', 'crypto', 'performance',
        'console',
      ];
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            var names = Object.getOwnPropertyNames(globalThis);
            var list = ${JSON.stringify(sensitive)};
            var present = [];
            for (var i = 0; i < list.length; i++) {
              if (typeof globalThis[list[i]] !== 'undefined' || names.indexOf(list[i]) >= 0) {
                present.push(list[i]);
              }
            }
            return JSON.stringify({ ok: true, mutations: [present], events: [] });
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(true);
      // Nothing from the sensitive list may exist, even as a deleted-but-visible key.
      if (result.ok) expect(result.mutations[0]).toEqual([]);
      await isolated.dispose();
    });

    it('cannot reach the host realm through constructor chains', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            try {
              var escaped = ({}).constructor.constructor(
                'return typeof process + "," + typeof require'
              )();
              return JSON.stringify({ ok: true, mutations: ['compiled:' + escaped], events: [] });
            } catch (e) {
              return JSON.stringify({ ok: false, error: { code: 'THREW', message: 'constructor chain blocked' } });
            }
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      if (result.ok) {
        // isolated-vm keeps Function available inside the isolate (it is realm-
        // contained); the host realm must still be invisible from there.
        expect(result.mutations[0]).toBe('compiled:undefined,undefined');
      } else {
        // node-vm: code generation from strings is disabled outright.
        expect(result.error.message).toContain('constructor chain blocked');
      }
      await isolated.dispose();
    });

    it('accepts only string returns — no object graph crosses the bridge', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () { return { ok: true, mutations: [], events: [] }; };`,
      });
      await expect(isolated.execute(emptyRequest())).rejects.toThrow(/non-string response/);
      await isolated.dispose();
    });

    it('rejects malformed and non-object JSON responses', async () => {
      for (const bad of ['not-json{{{', '42', 'null']) {
        const isolated = await createSandbox(provider, {
          contractSource: `globalThis.__nftExecute = function () { return ${JSON.stringify(bad)}; };`,
        });
        await expect(isolated.execute(emptyRequest())).rejects.toThrow(
          /malformed JSON|non-object response/,
        );
        await isolated.dispose();
      }
    });

    it('surfaces guest exceptions as rejections without crossing realms', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () { throw new Error('guest-boom'); };`,
      });
      await expect(isolated.execute(emptyRequest())).rejects.toThrow(/guest-boom/);
      await isolated.dispose();
    });

    it('contains prototype pollution inside the guest realm', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function () {
            var o = { own: 1 };
            o.__proto__.scePolluted = 'yes'; // deliberately pollutes the GUEST realm
            return JSON.stringify({ ok: true, mutations: [o, typeof ({}).scePolluted], events: [] });
          };`,
      });
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(true);
      if (result.ok) {
        // JSON.stringify serialises own properties only: the polluted prototype
        // cannot ride along into the host.
        expect(result.mutations[0]).toEqual({ own: 1 });
        expect(result.mutations[1]).toBe('string'); // polluted only inside its own realm
      }
      expect(({} as Record<string, unknown>).scePolluted).toBeUndefined(); // host untouched
      await isolated.dispose();
    });

    it('treats __proto__ / constructor keys in params as inert data', async () => {
      const isolated = await createSandbox(provider, {
        contractSource: `
          globalThis.__nftExecute = function (payload) {
            var req = JSON.parse(payload);
            return JSON.stringify({
              ok: true,
              mutations: [typeof ({}).sceParamPwned, Object.keys(req.params).sort().join('|')],
              events: [],
            });
          };`,
      });
      const request = emptyRequest();
      request.params = JSON.parse(
        '{"__proto__":{"sceParamPwned":"x"},"constructor":{"sceParamPwned":"y"},"safe":1}',
      );
      const result = await isolated.execute(request);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mutations[0]).toBe('undefined'); // no pollution, in either realm
        expect(result.mutations[1]).toBe('__proto__|constructor|safe'); // plain data keys
      }
      expect(({} as Record<string, unknown>).sceParamPwned).toBeUndefined();
      await isolated.dispose();
    });

    it('survives a hard timeout and keeps serving (DoS resilience)', async () => {
      const isolated = await createSandbox(provider, {
        timeoutMs: 100,
        contractSource: `
          var calls = 0;
          globalThis.__nftExecute = function () {
            calls = calls + 1;
            if (calls === 1) { while (true) {} }
            return JSON.stringify({ ok: true, mutations: ['alive-after-timeout'], events: [] });
          };`,
      });
      await expect(isolated.execute(emptyRequest())).rejects.toThrow(/timeout|timed out/i);
      const result = await isolated.execute(emptyRequest());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.mutations[0]).toBe('alive-after-timeout');
      await isolated.dispose();
    });

    // isolated-vm only: node-vm deliberately shares the host heap (dev fallback;
    // production requires the isolate via the boot gate), so an allocation bomb is
    // only safe to assert against the isolate.
    (provider === 'isolated-vm' ? it : it.skip)(
      'enforces the isolate memory limit under an allocation bomb',
      async () => {
        const isolated = await createSandbox(provider, {
          memoryLimitMb: 16,
          timeoutMs: 5000,
          contractSource: `
            globalThis.__nftExecute = function () {
              var bomb = [];
              for (;;) { bomb.push(new Array(100000).fill('x')); }
            };`,
        });
        await expect(isolated.execute(emptyRequest())).rejects.toThrow();
        await isolated.dispose().catch(() => {
          /* an OOM-terminated isolate may refuse further release calls */
        });
      },
    );
  });
});

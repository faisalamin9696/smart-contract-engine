import { createSandbox, emptyRequest, type Sandbox } from '../helpers/sandboxHelpers';

/**
 * Sandbox hardening: no ambient APIs, hard time limits, and identical output across
 * providers (isolated-vm when available, node-vm otherwise).
 */
describe('sandbox isolation', () => {
  const providers: Array<'isolated-vm' | 'node-vm'> = ['node-vm'];

  beforeAll(() => {
    try {
      require.resolve('isolated-vm');
      providers.unshift('isolated-vm');
    } catch {
      /* optional native dependency not installed */
    }
  });

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
  });
});

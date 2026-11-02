import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createJsonRpcCaller, RpcError } from '../../src/chain/rpc';

/**
 * The fetch-based JSON-RPC transport that replaced @steempro/dsteem.
 *
 * The wire format is a compatibility contract with every Steem node in
 * rotation: appbase `call` envelope in, `result`/`error` envelope out. These
 * tests pin both directions (plus failure modes) against a real HTTP server so
 * a refactor can never silently change the bytes on the wire.
 */

interface Recorded {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

function serve(
  respond: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; server: http.Server; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as-is */
      }
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      respond(req, res, raw);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server, requests });
    });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createJsonRpcCaller wire format', () => {
  it('sends the appbase call envelope dsteem used, and resolves `result`', async () => {
    const { url, server, requests } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '0', jsonrpc: '2.0', result: { head_block_number: 42 } }));
    });
    try {
      const caller = createJsonRpcCaller(url, 1_000);
      const result = await caller.call('condenser_api', 'get_dynamic_global_properties', []);

      expect(result).toEqual({ head_block_number: 42 });
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toEqual({
        id: '0',
        jsonrpc: '2.0',
        method: 'call',
        params: ['condenser_api', 'get_dynamic_global_properties', []],
      });
      expect(requests[0].headers['content-type']).toBe('application/json');
      expect(requests[0].headers['user-agent']).toBe('sce-engine/1.0');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('defaults params to [] and passes arrays through untouched', async () => {
    const { url, server, requests } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '0', jsonrpc: '2.0', result: null }));
    });
    try {
      const caller = createJsonRpcCaller(url, 1_000);
      await caller.call('condenser_api', 'get_block', [110282608]);
      expect(requests[0].body).toMatchObject({
        method: 'call',
        params: ['condenser_api', 'get_block', [110282608]],
      });
      await caller.call('condenser_api', 'get_dynamic_global_properties');
      expect(requests[1].body).toMatchObject({
        params: ['condenser_api', 'get_dynamic_global_properties', []],
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('throws RpcError with the node message on a JSON-RPC error envelope', async () => {
    const { url, server } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: '0',
          jsonrpc: '2.0',
          error: { code: 1, message: '3 N/A missing active authority' },
        }),
      );
    });
    try {
      const caller = createJsonRpcCaller(url, 1_000);
      await expect(caller.call('condenser_api', 'get_block', [1])).rejects.toThrow('missing active authority');
      await expect(caller.call('condenser_api', 'get_block', [1])).rejects.toBeInstanceOf(RpcError);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('reports HTTP failures (non-JSON bodies) as HTTP_ERROR', async () => {
    const { url, server } = await serve((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('maintenance');
    });
    try {
      const caller = createJsonRpcCaller(url, 1_000);
      const error = await caller.call('condenser_api', 'get_block', [1]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe('HTTP_ERROR');
      expect((error as RpcError).message).toContain('503');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('reports a 200 body without a jsonrpc envelope as BAD_RESPONSE', async () => {
    const { url, server } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>hi</html>');
    });
    try {
      const caller = createJsonRpcCaller(url, 1_000);
      const error = await caller.call('condenser_api', 'get_block', [1]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe('BAD_RESPONSE');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('aborts a hung socket at timeoutMs instead of waiting forever', async () => {
    const { url, server } = await serve(() => {
      /* never respond — simulates a wedged endpoint */
    });
    try {
      const caller = createJsonRpcCaller(url, 50);
      const started = Date.now();
      await expect(caller.call('condenser_api', 'get_block', [1])).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

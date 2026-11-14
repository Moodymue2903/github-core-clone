// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4, MCP.
// main.ts (starter lifecycle) stays as it is; this file is the server.
// Stdlib only, no wall clock, no randomness in responses.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let reqCounter = 0;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqId = `req-${(reqCounter += 1)}`;
    const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      if (status === 204 || body === null) {
        res.writeHead(status, { 'x-github-request-id': reqId, ...headers });
        res.end();
        return;
      }
      const text = `${JSON.stringify(body)}\n`;
      res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': reqId, ...headers });
      res.end(text);
    };
    const sendRaw = (status: number, body: Buffer, contentType: string): void => {
      res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': reqId });
      res.end(body);
    };
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const query = queryOf(req);
        // Health probe takes no auth.
        if (method === 'GET' && path === '/healthz') { sendJson(200, { ok: true }); return; }
        // Auth: every other call needs the bearer token, when one is configured.
        const auth = req.headers.authorization ?? '';
        if (token !== '' && auth !== `Bearer ${token}`) {
          sendJson(401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        if (process.env.FORGE_DEBUG) {
          process.stderr.write(`[forge] ${method} ${path} body=${body.length} ${JSON.stringify(body.subarray(0, 200).toString('utf8'))}\n`);
        }
        // Git smart HTTP (binary body).
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
          const out = handleGit(store, method, path, query, headers, body);
          if (out) { sendRaw(out.status, out.body, out.contentType); return; }
          sendJson(404, { message: 'Not Found' });
          return;
        }
        // GraphQL
        if (path === '/api/graphql' && method === 'POST') {
          let parsed: any;
          try { parsed = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { sendJson(400, { message: 'Malformed JSON' }); return; }
          sendJson(200, handleGraphQL(store, parsed));
          return;
        }
        // MCP
        if (path === '/mcp' && method === 'POST') {
          let parsed: any;
          try { parsed = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch {
            sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const out = handleMcp(store, parsed, {});
          sendJson(out.status, out.json);
          return;
        }
        if (path === '/mcp' && method === 'DELETE') { sendJson(200, {}); return; }
        // REST v3
        if (path.startsWith('/api/v3')) {
          let parsed: any = undefined;
          if (body.length) {
            try { parsed = JSON.parse(body.toString('utf8')); } catch { sendJson(400, { message: 'Malformed JSON' }); return; }
          }
          const ctx = { store, reqId, host: req.headers.host ?? '127.0.0.1', method, path, query, bodyText: body.toString('utf8'), body: parsed };
          const out = handleRest(ctx);
          if (out) { sendJson(out.status, out.json, out.headers ?? {}); return; }
          sendJson(404, { message: 'Not Found' });
          return;
        }
        sendJson(404, { message: 'Not Found' });
      } catch (e: any) {
        process.stderr.write(`[forge] ERROR: ${e?.stack ?? e}\n`);
        try { sendJson(500, { message: String(e?.message ?? e) }); } catch { /* socket gone */ }
      }
    })();
  });
}

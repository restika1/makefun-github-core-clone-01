// The forge's HTTP surface: the lifecycle probe, REST v3 under /api/v3, and a JSON 404 for
// everything else. app.ts is the file the surfaces grow in; main.ts stays the entry lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleRest } from './src/rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export const STORE = new Store();
export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!.trim();
}

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

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
      handleRest(req, res, path, queryOf(req), bearerToken(req), TOKEN, STORE).catch(() => {
        sendJson(res, 500, { message: 'Internal Server Error' });
      });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}

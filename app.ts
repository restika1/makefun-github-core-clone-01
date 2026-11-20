// The forge's HTTP surface: the lifecycle probe, REST v3 under /api/v3, and a JSON 404 for
// everything else. app.ts is the file the surfaces grow in; main.ts stays the entry lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, hashObject } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQLRequest } from './src/graphql.ts';
import { handleMcpBody } from './src/mcp.ts';
import { infoRefsReceivePack, infoRefsUploadPack, receivePack, uploadPack } from './src/git-smart.ts';

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

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function wantsV2(req: IncomingMessage): boolean {
  return /version=2/.test(req.headers['git-protocol'] ?? '');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const match = GIT_ROUTE.exec(path);
  if (match === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const [, owner, repoName, endpoint] = match as unknown as [string, string, string, string];
  const store = STORE;
  if (bearerToken(req) !== TOKEN) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }
  const repo = store.findRepo(owner, repoName);
  const service = endpoint === 'info/refs' ? queryOf(req).get('service') ?? '' : endpoint;
  if (repo === null) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  if (req.method === 'GET' && endpoint === 'info/refs') {
    if (service === 'git-upload-pack') {
      const answer = infoRefsUploadPack(repo, wantsV2(req));
      res.writeHead(answer.status, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': answer.body.length });
      res.end(answer.body);
      return;
    }
    if (service === 'git-receive-pack') {
      const answer = infoRefsReceivePack(repo);
      res.writeHead(answer.status, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': answer.body.length });
      res.end(answer.body);
      return;
    }
    sendJson(res, 400, { message: 'unsupported service' });
    return;
  }
  if (req.method === 'POST' && (endpoint === 'git-upload-pack' || endpoint === 'git-receive-pack')) {
    const body = await readRawBody(req);
    try {
      if (endpoint === 'git-upload-pack') {
        const answer = uploadPack(repo, body, wantsV2(req));
        res.writeHead(answer.status, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': answer.body.length });
        res.end(answer.body);
      } else {
        const answer = receivePack(repo, body, (type, data) => hashObject(repo, type as 'blob', data));
        res.writeHead(answer.status, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': answer.body.length });
        res.end(answer.body);
      }
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad Request');
    }
    return;
  }
  sendJson(res, 400, { message: 'bad git request' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
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

    if (path === '/api/graphql') {
      if (bearerToken(req) !== TOKEN) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const body = await readRawBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      sendJson(res, 200, handleGraphQLRequest(STORE, parsed).payload);
      return;
    }

    if (path === '/mcp') {
      if (bearerToken(req) !== TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Requires authentication' }));
        return;
      }
      const body = await readRawBody(req);
      const answer = handleMcpBody(STORE, body.toString('utf8'));
      res.writeHead(answer.status, {
        'content-type': answer.body === '' ? 'text/plain' : 'application/json',
        'content-length': Buffer.byteLength(answer.body),
      });
      res.end(answer.body);
      return;
    }

    if (path.endsWith('.git') || path.includes('.git/')) {
      handleGit(req, res, path).catch(() => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal Server Error');
      });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
}

// app.ts: the forge's HTTP server — routing and the bearer-token gate in front of the four
// surfaces (git smart HTTP, REST v3, GraphQL v4, MCP). One in-memory Forge serves them all, so
// state agrees across surfaces by construction. main.ts owns the process lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGitHttp } from './githttp.ts';
import { handleRest, sendJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The token every surface expects; an unset token (local runs) disables the gate. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
        const method = req.method ?? 'GET';

        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isMcp = segments.length === 1 && segments[0] === 'mcp';
        const isGraphql = segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql';
        const isRest = segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3';
        const isGit = segments.length >= 2 && (segments[1] as string).endsWith('.git');

        if (!isMcp && !isGraphql && !isRest && !isGit) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authorized(req)) {
          unauthorized(res);
          return;
        }
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        if (isMcp) {
          handleMcp(forge, req, res, body);
          return;
        }
        if (isGraphql) {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          handleGraphQL(forge, req, res, body);
          return;
        }
        if (isRest) {
          handleRest(forge, req, res, segments.slice(2), url, body);
          return;
        }
        const handled = handleGitHttp(forge, req, res, segments, url.searchParams, body);
        if (!handled) sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${error instanceof Error ? error.message : 'unknown'}` });
        else res.end();
      }
    })();
  });
}

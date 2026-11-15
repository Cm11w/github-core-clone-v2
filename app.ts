/**
 * app.ts — the HTTP server: routing, authentication, body limits and the
 * JSON error envelope. All route handling is delegated to the surface
 * adapters (rest.ts, graphql.ts, mcp.ts, githttp.ts); this module only
 * decides which adapter owns a request and guarantees that every response
 * is well-formed JSON (or a git wire body) with a request id — never HTML,
 * never a crash.
 */

import http from 'node:http';
import { Forge, ForgeError } from './core.ts';
import { GitResponseCache, handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestResult } from './rest.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export interface AppOptions {
  expectedToken: string | undefined;
  viewerLogin: string;
}

export interface App {
  server: http.Server;
  forge: Forge;
}

class BodyTooLargeError extends Error {}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isAuthorized(req: http.IncomingMessage, expected: string | undefined): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (expected === undefined || expected === '') return true;
  return presented === expected;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new BodyTooLargeError('Request body exceeds the size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
  });
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  const text = body.toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ForgeError(400, 'Request body is not valid JSON');
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, requestId: string, extra?: Record<string, string>): void {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(payload),
    'X-GitHub-Request-Id': requestId,
    ...extra,
  });
  res.end(payload);
}

function sendBuffer(res: http.ServerResponse, status: number, body: Buffer, contentType: string, requestId: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId,
    ...extra,
  });
  res.end(body);
}

function sendEmpty(res: http.ServerResponse, status: number, requestId: string): void {
  res.writeHead(status, { 'X-GitHub-Request-Id': requestId });
  res.end();
}

export function createApp(options: AppOptions): App {
  const forge = new Forge(options.viewerLogin);
  const gitCache = new GitResponseCache();
  let requestCounter = 0;

  const server = http.createServer((req, res) => {
    const requestId = `req_${(requestCounter += 1).toString(16).padStart(8, '0')}`;
    void handleRequest(req, res, requestId).catch((error: unknown) => {
      // Last-resort guard: the server must never drop a connection without
      // answering, and must never die on a bad request.
      try {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
        } else {
          res.end();
        }
      } catch {
        // The socket is already gone; nothing left to do.
      }
      console.error('unhandled request error:', error instanceof Error ? error.message : String(error));
    });
  });

  server.on('clientError', (error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 26\r\n\r\n{"message":"Bad Request"}');
    } catch {
      socket.destroy();
    }
    void error;
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, requestId: string): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const queryIndex = rawUrl.indexOf('?');
    const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
    const rawQuery = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '';
    // Split BEFORE decoding: a decoded segment may itself contain '/' (%2F).
    const rawSegments = rawPath.split('/').filter((segment) => segment !== '');
    const segments = rawSegments.map(decodeSegment);
    const query = new URLSearchParams(rawQuery);

    try {
      // Health: no authentication, always available.
      if (segments.length === 1 && segments[0] === 'healthz') {
        if (method !== 'GET') {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
        sendJson(res, 200, { ok: true }, requestId);
        return;
      }

      if (!isAuthorized(req, options.expectedToken)) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/<action>
      if (segments.length >= 3 && rawSegments[1]!.endsWith('.git')) {
        const owner = segments[0]!;
        const repoName = segments[1]!.slice(0, -'.git'.length);
        const repo = forge.getRepo(owner, repoName);
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
        const action = segments.slice(2);
        if (action.length === 2 && action[0] === 'info' && action[1] === 'refs' && method === 'GET') {
          const service = query.get('service') ?? '';
          const result = handleInfoRefs(forge, repo, service, req.headers['git-protocol'], gitCache);
          sendBuffer(res, result.status, result.body, result.contentType, requestId);
          return;
        }
        if (action.length === 1 && action[0] === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = handleUploadPack(forge, repo, body, req.headers['git-protocol'], gitCache);
          sendBuffer(res, result.status, result.body, result.contentType, requestId);
          return;
        }
        if (action.length === 1 && action[0] === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const result = handleReceivePack(forge, repo, body);
          sendBuffer(res, result.status, result.body, result.contentType, requestId);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }

      // GraphQL.
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        const result = handleGraphQL(forge, parsed);
        sendJson(res, 200, result, requestId);
        return;
      }

      // MCP.
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method === 'DELETE') {
          sendEmpty(res, 202, requestId);
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
        const body = await readBody(req);
        const result = handleMcp(forge, body.toString('utf8'));
        if (result.empty) {
          sendEmpty(res, result.status, requestId);
          return;
        }
        sendJson(res, result.status, result.json, requestId);
        return;
      }

      // REST v3.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        let parsed: unknown;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const body = await readBody(req);
          parsed = parseJsonBody(body);
        }
        const host = req.headers.host ?? '127.0.0.1';
        const result: RestResult = handleRest({
          forge,
          method,
          segments: restSegments,
          query,
          body: parsed,
          origin: `http://${host}`,
        });
        if (result.status === 204) {
          sendEmpty(res, 204, requestId);
          return;
        }
        if (result.buffer !== undefined) {
          sendBuffer(res, result.status, result.buffer, JSON_CONTENT_TYPE, requestId, result.headers);
          return;
        }
        sendJson(res, result.status, result.json ?? {}, requestId, result.headers);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, requestId);
    } catch (error) {
      if (error instanceof ForgeError) {
        sendJson(res, error.status, { message: error.message }, requestId);
        return;
      }
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { message: error.message }, requestId);
        return;
      }
      console.error('request error:', error instanceof Error ? error.stack ?? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
      } else {
        res.end();
      }
    }
  }

  return { server, forge };
}

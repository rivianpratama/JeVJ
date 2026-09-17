/**
 * The HTTP layer, small enough to read in one sitting.
 *
 * JeVJ runs in two places — inside Vite's connect middleware in development,
 * and on a bare `http.createServer` after `npm run build` — and the routes
 * must not be able to tell the difference. Both runtimes hand out Node's own
 * `IncomingMessage`/`ServerResponse`, so those are the interface here, and a
 * `Router` is a thing that takes the pair plus a `next` for "not mine". That
 * is all a framework would have given us, and it would have given it to us as
 * a dependency that has to agree with Vite's.
 *
 * Everything that is a decision rather than plumbing — does this path match,
 * what does this `Range` header mean against a file of this size — is a pure
 * function, tested without a socket in sight.
 */

import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';

import { sizeOf } from './ytdlp/cache';

export interface RouteContext {
  /** The `:name` segments the path pattern captured, already URL-decoded. */
  params: Record<string, string>;
  /** The request URL, parsed. Its origin is a placeholder, not the real host. */
  url: URL;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void | Promise<void>;

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

/** A URL needs an origin to parse; nothing here reads it. */
const BASE = 'http://localhost';

/**
 * The biggest JSON body any route reads. Every payload we accept is one small
 * object; the limit is here so that a body which is not one stops arriving
 * rather than being parsed.
 */
export const MAX_BODY_BYTES = 64 * 1024;

export class Router {
  private readonly routes: Route[] = [];

  /** `GET` also answers `HEAD`, which is how a player asks about a file. */
  route(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  /**
   * Answers the request, or calls `next` if no route claims the path.
   *
   * A path that matches but with the wrong method is a 405 with `Allow`, not a
   * fall-through: it is our path, and saying so is more useful than letting a
   * static file server report it missing.
   */
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const url = new URL(req.url ?? '/', BASE);
    const method = (req.method ?? 'GET').toUpperCase();
    const allowed = new Set<string>();

    for (const route of this.routes) {
      const params = matchPath(route.pattern, url.pathname);
      if (params === null) continue;
      if (route.method === method || (route.method === 'GET' && method === 'HEAD')) {
        void runHandler(route.handler, req, res, { params, url });
        return;
      }
      allowed.add(route.method);
      if (route.method === 'GET') allowed.add('HEAD');
    }

    if (allowed.size === 0) {
      next();
      return;
    }
    res.setHeader('Allow', [...allowed].join(', '));
    sendJson(res, 405, { error: 'method not allowed' });
  }
}

async function runHandler(
  handler: Handler,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  try {
    await handler(req, res, ctx);
  } catch {
    // A handler that threw has told the client nothing, and whatever it threw
    // may quote a path or a key. One line, no detail.
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
    else res.end();
  }
}

/**
 * Matches a path against a pattern like `/media/:file`.
 *
 * A parameter is exactly one segment — it cannot swallow a slash — and it is
 * decoded here so the handler validates the name the caller actually meant,
 * `%2e%2e%2f` included. A segment that is not valid percent-encoding does not
 * match at all.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const expected = want[i] ?? '';
    const actual = got[i] ?? '';
    if (expected.startsWith(':')) {
      if (actual === '') return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(actual);
      } catch {
        return null;
      }
      params[expected.slice(1)] = decoded;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/**
 * How long a body may take to arrive before the request is abandoned.
 *
 * A client that opens a connection, announces a body and then sends nothing
 * holds a socket and a pending handler for as long as it likes. Ten seconds is
 * far longer than a local POST of a few hundred kilobytes needs and short
 * enough that a stalled one cannot accumulate.
 */
export const BODY_TIMEOUT_MS = 10_000;

/**
 * Reads a JSON body, refusing anything over `limit` *bytes* and anything that
 * takes longer than `BODY_TIMEOUT_MS` to arrive.
 *
 * The chunks are kept as buffers and decoded once at the end, which is not a
 * micro-optimisation: a UTF-8 character can be split across two chunks, and
 * decoding each chunk on arrival turns the halves into two replacement
 * characters — a track title with an accent in it, silently corrupted. It is
 * also what makes the limit a byte limit rather than a character one, which is
 * what a limit is for.
 */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, status: 408, error: 'body took too long' });
      req.destroy();
    }, BODY_TIMEOUT_MS);
    // A pending read must not be what keeps the process alive.
    if (typeof timer.unref === 'function') timer.unref();

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buf.length;
      if (size > limit) {
        finish({ ok: false, status: 413, error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('error', () => finish({ ok: false, status: 400, error: 'body could not be read' }));
    req.on('end', () => {
      if (settled) return;
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        finish({ ok: true, value: JSON.parse(body.trim() === '' ? 'null' : body) });
      } catch {
        finish({ ok: false, status: 400, error: 'body is not JSON' });
      }
    });
  });
}

/**
 * Whether a request came from somewhere other than this server.
 *
 * JeVJ runs on localhost, and a page on any other origin can still POST to a
 * localhost port — which is how a visited web page gets to spend somebody's
 * API budget or spawn yt-dlp on their machine. The browser tells us where a
 * cross-origin request came from, and the only origin allowed to drive these
 * routes is our own.
 *
 * No `Origin` header at all is *not* cross-origin: that is curl, a test, or a
 * same-origin navigation, none of which a browser would let a third-party page
 * make.
 */
export function isCrossOrigin(req: IncomingMessage): boolean {
  const origin = headerValue(req, 'origin');
  if (origin === undefined || origin === '' || origin === 'null') return false;

  const host = headerValue(req, 'host');
  if (host === undefined || host === '') return true;

  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Whether the request announced a JSON body, as every POST route requires. */
export function isJsonRequest(req: IncomingMessage): boolean {
  const type = headerValue(req, 'content-type');
  if (type === undefined) return false;
  return type.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function sendJson(res: ServerResponse, status: number, json: unknown): void {
  const body = JSON.stringify(json);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

export type RangeResult =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'ignore' }
  | { kind: 'unsatisfiable' };

/**
 * What a `Range` header asks for, against a file of `size` bytes.
 *
 * Three answers, because HTTP has three: the bytes asked for, "this header is
 * not something I understand, have the whole file" (a legal response to any
 * range request, and the right one for the multipart ranges we do not serve),
 * and "that range cannot be satisfied", which is a 416 and not a 206 of
 * nothing. Ends past the file are clamped rather than refused — a media
 * element routinely asks for more than is there.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined || header.trim() === '') return { kind: 'ignore' };

  const match = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  const spec = match?.[1]?.trim();
  if (spec === undefined || spec.includes(',')) return { kind: 'ignore' };

  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (parts === null) return { kind: 'ignore' };
  const from = parts[1] ?? '';
  const to = parts[2] ?? '';
  if (from === '' && to === '') return { kind: 'ignore' };

  if (from === '') {
    // A suffix range: the last N bytes. Zero of them is unsatisfiable.
    const wanted = Number(to);
    if (wanted === 0) return { kind: 'unsatisfiable' };
    if (size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'ok', start: Math.max(0, size - wanted), end: size - 1 };
  }

  const start = Number(from);
  if (start >= size) return { kind: 'unsatisfiable' };
  if (to === '') return { kind: 'ok', start, end: size - 1 };

  const end = Number(to);
  if (end < start) return { kind: 'ignore' };
  return { kind: 'ok', start, end: Math.min(end, size - 1) };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface SendFileOptions {
  contentType?: string;
  /** Sent as `Cache-Control`; the cache serves immutable files. */
  cacheControl?: string;
}

/**
 * Sends a file, honouring `Range` and answering `HEAD` with headers alone.
 *
 * Ranges are the whole reason this is hand-written: a `<video>` element seeks
 * by asking for byte ranges, and a server that answers every request with the
 * whole file makes seeking in a long track feel like a download.
 *
 * Returns false if the file is not there, so the caller can 404 in its own
 * words rather than this module guessing what "missing" means to it.
 */
export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  options: SendFileOptions = {},
): boolean {
  const size = sizeOf(path);
  if (size === null) return false;

  const type = options.contentType ?? contentTypeFor(path);
  const range = parseRange(headerOf(req, 'range'), size);

  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  if (options.cacheControl !== undefined) res.setHeader('Cache-Control', options.cacheControl);

  if (range.kind === 'unsatisfiable') {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return true;
  }

  const start = range.kind === 'ok' ? range.start : 0;
  const end = range.kind === 'ok' ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  res.statusCode = range.kind === 'ok' ? 206 : 200;
  if (range.kind === 'ok') res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', length);

  if ((req.method ?? 'GET').toUpperCase() === 'HEAD' || length === 0) {
    res.end();
    return true;
  }

  const stream = createReadStream(path, { start, end });
  // A player that seeks away mid-read aborts the response; that is normal, and
  // the only thing to do about it is stop reading.
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return true;
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

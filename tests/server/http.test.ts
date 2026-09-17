import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  BODY_TIMEOUT_MS,
  contentTypeFor,
  isCrossOrigin,
  isJsonRequest,
  matchPath,
  parseRange,
  readJsonBody,
} from '../../server/http';

describe('parseRange', () => {
  it('is ignored when there is no header', () => {
    expect(parseRange(undefined, 1000)).toEqual({ kind: 'ignore' });
    expect(parseRange('', 1000)).toEqual({ kind: 'ignore' });
  });

  it('reads a closed range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'ok', start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 1000)).toEqual({ kind: 'ok', start: 10, end: 19 });
  });

  it('runs an open range to the end of the file', () => {
    expect(parseRange('bytes=100-', 1000)).toEqual({ kind: 'ok', start: 100, end: 999 });
  });

  it('counts a suffix range back from the end', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'ok', start: 900, end: 999 });
  });

  it('clamps a suffix or an end past the file to the file', () => {
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'ok', start: 0, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ kind: 'ok', start: 0, end: 999 });
  });

  it('calls a range that starts past the end unsatisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=1200-1300', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a header it does not understand rather than failing the request', () => {
    expect(parseRange('items=0-99', 1000)).toEqual({ kind: 'ignore' });
    expect(parseRange('bytes=abc', 1000)).toEqual({ kind: 'ignore' });
    expect(parseRange('bytes=', 1000)).toEqual({ kind: 'ignore' });
    expect(parseRange('bytes=5-2', 1000)).toEqual({ kind: 'ignore' });
    // Multipart ranges are legal and we do not serve them; the whole file is a
    // valid answer to any range request.
    expect(parseRange('bytes=0-99, 200-299', 1000)).toEqual({ kind: 'ignore' });
  });

  it('tolerates spaces around the range', () => {
    expect(parseRange('bytes= 0 - 99 ', 1000)).toEqual({ kind: 'ok', start: 0, end: 99 });
  });
});

describe('matchPath', () => {
  it('matches a literal path', () => {
    expect(matchPath('/api/resolve', '/api/resolve')).toEqual({});
    expect(matchPath('/api/resolve', '/api/resolved')).toBeNull();
    expect(matchPath('/api/resolve', '/api/resolve/')).toBeNull();
  });

  it('captures one named segment', () => {
    expect(matchPath('/api/job/:id', '/api/job/jNQXAC9IVRw')).toEqual({ id: 'jNQXAC9IVRw' });
    expect(matchPath('/media/:file', '/media/jNQXAC9IVRw.mp4')).toEqual({ file: 'jNQXAC9IVRw.mp4' });
  });

  it('does not let a parameter swallow a slash', () => {
    expect(matchPath('/media/:file', '/media/sub/secret.mp4')).toBeNull();
    expect(matchPath('/media/:file', '/media/')).toBeNull();
    expect(matchPath('/media/:file', '/media')).toBeNull();
  });

  it('decodes a percent-escaped segment so the handler validates the real name', () => {
    expect(matchPath('/media/:file', '/media/%2e%2e%2fsecret.mp4')).toEqual({ file: '../secret.mp4' });
    expect(matchPath('/media/:file', '/media/%zz')).toBeNull();
  });
});

/** Just enough of a request to feed the body reader. */
function request(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

/** The same, but arriving in the chunks the caller chose. */
function chunked(chunks: Buffer[]): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage;
}

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    await expect(readJsonBody(request('{"url":"x"}'), 1024)).resolves.toEqual({ ok: true, value: { url: 'x' } });
  });

  it('treats an empty body as null rather than an error', async () => {
    await expect(readJsonBody(request(''), 1024)).resolves.toEqual({ ok: true, value: null });
  });

  it('rejects a body that is not JSON', async () => {
    await expect(readJsonBody(request('{nope'), 1024)).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'body is not JSON',
    });
  });

  it('rejects a body over the limit without parsing it', async () => {
    await expect(readJsonBody(request('x'.repeat(2000)), 1024)).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'payload too large',
    });
  });

  it('counts the limit in bytes, not in characters', async () => {
    // Six hundred three-byte characters is 1800 bytes and 600 characters: a
    // reader counting characters would let it through.
    const body = JSON.stringify({ title: '館'.repeat(600) });
    await expect(readJsonBody(chunked([Buffer.from(body)]), 1024)).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it('decodes a character split across two chunks', async () => {
    // A stream does not respect character boundaries, and a reader that
    // decodes each chunk on arrival turns this into two replacement
    // characters — a title with an accent in it, quietly corrupted.
    const body = Buffer.from(JSON.stringify({ title: 'café 館' }), 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < body.length; i += 3) chunks.push(body.subarray(i, i + 3));

    await expect(readJsonBody(chunked(chunks), 1024)).resolves.toEqual({
      ok: true,
      value: { title: 'café 館' },
    });
  });

  it('gives up on a body that never arrives', async () => {
    vi.useFakeTimers();
    try {
      const stream = new Readable({ read() {} });
      stream.push(Buffer.from('{"url":'));
      let destroyed = false;
      stream.destroy = ((): Readable => {
        destroyed = true;
        return stream;
      }) as Readable['destroy'];

      const pending = readJsonBody(stream as unknown as IncomingMessage, 1024);
      await vi.advanceTimersByTimeAsync(BODY_TIMEOUT_MS + 1);

      await expect(pending).resolves.toEqual({
        ok: false,
        status: 408,
        error: 'body took too long',
      });
      expect(destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isCrossOrigin', () => {
  const req = (headers: Record<string, string>): IncomingMessage =>
    ({ headers }) as unknown as IncomingMessage;

  it('is false when there is no Origin at all', () => {
    expect(isCrossOrigin(req({ host: '127.0.0.1:5173' }))).toBe(false);
    expect(isCrossOrigin(req({ host: '127.0.0.1:5173', origin: '' }))).toBe(false);
    expect(isCrossOrigin(req({ host: '127.0.0.1:5173', origin: 'null' }))).toBe(false);
  });

  it('is false when the Origin is this server', () => {
    expect(isCrossOrigin(req({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }))).toBe(false);
    expect(isCrossOrigin(req({ host: 'localhost:5173', origin: 'https://localhost:5173' }))).toBe(false);
  });

  it('is true for anywhere else, port included', () => {
    expect(isCrossOrigin(req({ host: '127.0.0.1:5173', origin: 'https://evil.example' }))).toBe(true);
    expect(isCrossOrigin(req({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:9999' }))).toBe(true);
    expect(isCrossOrigin(req({ host: '127.0.0.1:5173', origin: 'not a url' }))).toBe(true);
    expect(isCrossOrigin(req({ origin: 'http://127.0.0.1:5173' }))).toBe(true);
  });
});

describe('isJsonRequest', () => {
  const req = (type?: string): IncomingMessage =>
    ({ headers: type === undefined ? {} : { 'content-type': type } }) as unknown as IncomingMessage;

  it('takes application/json, with or without parameters', () => {
    expect(isJsonRequest(req('application/json'))).toBe(true);
    expect(isJsonRequest(req('application/json; charset=utf-8'))).toBe(true);
    expect(isJsonRequest(req('APPLICATION/JSON'))).toBe(true);
  });

  it('takes nothing else, including the types a form can send', () => {
    expect(isJsonRequest(req())).toBe(false);
    expect(isJsonRequest(req('text/plain'))).toBe(false);
    expect(isJsonRequest(req('application/x-www-form-urlencoded'))).toBe(false);
    expect(isJsonRequest(req('multipart/form-data; boundary=x'))).toBe(false);
  });
});

describe('contentTypeFor', () => {
  it('knows the types a built app is made of', () => {
    expect(contentTypeFor('/app/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/assets/main.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/assets/main.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('/cache/x.mp4')).toBe('video/mp4');
  });

  it('falls back to bytes for anything else', () => {
    expect(contentTypeFor('/weird.xyz')).toBe('application/octet-stream');
  });
});

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JevLike } from '../../server/moodHandler';
import { createRoutes } from '../../server/routes';
import { JobRunner } from '../../server/ytdlp/job';
import { EXAMPLE_INPUT, exampleAnswers } from '../helpers/moodFixture';

const ID = 'jNQXAC9IVRw';
/** One kilobyte of recognisable bytes, so a range can be checked by value. */
const BODY = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

const jev: JevLike = {
  async systemOne() {
    return { answers: exampleAnswers(), usage: { input_tokens: 1, output_tokens: 2 } };
  },
};

let dir = '';
let server: Server;
let base = '';
/** Set by tests that want the fake yt-dlp to fail. */
let exitCode = 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jevj-routes-'));
  exitCode = 0;
  const jobs = new JobRunner(dir, async (_cmd, _args, hooks) => {
    hooks.stdout(JSON.stringify({ id: ID, title: 'Me at the zoo', duration: 19 }));
    if (exitCode === 0) writeFileSync(join(dir, `${ID}.mp4`), BODY);
    else hooks.stderr('ERROR: [youtube] Video unavailable');
    return exitCode;
  });
  const router = createRoutes({ jev, jobs, cacheDir: dir });
  server = createServer((req, res) => {
    router.handle(req, res, () => {
      res.statusCode = 404;
      res.end('fell through');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
});

function resolve(url: unknown): Promise<Response> {
  return fetch(`${base}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

/** Resolve, then poll until the job stops moving, as the client does. */
async function download(url: string): Promise<Record<string, unknown>> {
  const { jobId } = (await (await resolve(url)).json()) as { jobId: string };
  for (let i = 0; i < 100; i++) {
    const job = (await (await fetch(`${base}/api/job/${jobId}`)).json()) as Record<string, unknown>;
    if (job['status'] === 'done' || job['status'] === 'error') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never settled');
}

describe('POST /api/resolve', () => {
  it('accepts a YouTube link and hands back a job', async () => {
    const res = await resolve(`https://www.youtube.com/watch?v=${ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: ID });
  });

  it('gives the same job for the same video however it was written', async () => {
    const a = (await (await resolve(`https://www.youtube.com/watch?v=${ID}`)).json()) as { jobId: string };
    const b = (await (await resolve(`https://youtu.be/${ID}?t=30`)).json()) as { jobId: string };
    expect(b.jobId).toBe(a.jobId);
  });

  it('refuses anything that is not a YouTube link', async () => {
    for (const url of ['https://example.com/video', 'not a url', '', 42, null]) {
      const res = await resolve(url);
      expect(res.status, JSON.stringify(url)).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
  });

  it('answers only POST', async () => {
    const res = await fetch(`${base}/api/resolve`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('GET /api/job/:id', () => {
  it('follows a download to done', async () => {
    const job = await download(`https://www.youtube.com/watch?v=${ID}`);
    expect(job['status']).toBe('done');
    expect(job['percent']).toBe(100);
    expect(job['title']).toBe('Me at the zoo');
    expect(job['durationSec']).toBe(19);
    expect(job['mediaUrl']).toBe(`/media/${ID}.mp4`);
  });

  it('reports a failure with a message and no paths', async () => {
    exitCode = 1;
    const job = await download(`https://www.youtube.com/watch?v=${ID}`);
    expect(job['status']).toBe('error');
    expect(job['error']).toBe('[youtube] Video unavailable');
  });

  it('is 404 for a job nobody started', async () => {
    const res = await fetch(`${base}/api/job/AAAAAAAAAAA`);
    expect(res.status).toBe(404);
  });
});

describe('GET /media/:file', () => {
  beforeEach(() => {
    writeFileSync(join(dir, `${ID}.mp4`), BODY);
  });

  it('serves the whole file as video/mp4', async () => {
    const res = await fetch(`${base}/media/${ID}.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(await res.text()).toBe(BODY);
  });

  it('answers a range with 206 and just those bytes', async () => {
    const res = await fetch(`${base}/media/${ID}.mp4`, { headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(await res.text()).toBe(BODY.slice(0, 100));
  });

  it('answers a suffix range from the end', async () => {
    const res = await fetch(`${base}/media/${ID}.mp4`, { headers: { Range: 'bytes=-10' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(await res.text()).toBe(BODY.slice(990));
  });

  it('answers an open range to the end', async () => {
    const res = await fetch(`${base}/media/${ID}.mp4`, { headers: { Range: 'bytes=990-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
  });

  it('refuses a range past the end with 416', async () => {
    const res = await fetch(`${base}/media/${ID}.mp4`, { headers: { Range: 'bytes=2000-3000' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await fetch(`${base}/media/${ID}.mp4`, { method: 'HEAD', headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(await res.text()).toBe('');
  });

  it('serves nothing but an mp4 that is in the cache', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'secret');
    for (const name of ['notes.txt', `${ID}.info.json`, 'missing.mp4', `${ID}.MP4.txt`]) {
      expect((await fetch(`${base}/media/${name}`)).status, name).toBe(404);
    }
  });

  it('cannot be walked out of the cache directory', async () => {
    writeFileSync(join(dir, '..', 'jevj-escape.mp4'), 'secret');
    try {
      for (const name of [
        '..%2Fjevj-escape.mp4',
        '%2e%2e%2fjevj-escape.mp4',
        '..%5Cjevj-escape.mp4',
        '%2Fetc%2Fpasswd',
      ]) {
        const res = await fetch(`${base}/media/${name}`);
        expect(res.status, name).toBe(404);
        expect(await res.text()).not.toContain('secret');
      }
    } finally {
      rmSync(join(dir, '..', 'jevj-escape.mp4'), { force: true });
    }
  });
});

describe('the rest of the router', () => {
  it('still answers /api/mood', async () => {
    const res = await fetch(`${base}/api/mood`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(EXAMPLE_INPUT),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('mood');
  });

  it('says so when the mood service has no key', async () => {
    const router = createRoutes({ jev: null, jobs: new JobRunner(dir, async () => 0), cacheDir: dir });
    const bare = createServer((req, res) => router.handle(req, res, () => res.end()));
    await new Promise<void>((done) => bare.listen(0, '127.0.0.1', done));
    const port = (bare.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/mood`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(EXAMPLE_INPUT),
    });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('TYPESAFE');
    await new Promise<void>((done) => bare.close(() => done()));
  });

  it('leaves a path it does not own to whatever comes next', async () => {
    const res = await fetch(`${base}/index.html`);
    expect(await res.text()).toBe('fell through');
  });
});

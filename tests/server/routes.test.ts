import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JevLike } from '../../server/moodHandler';
import { createRoutes } from '../../server/routes';
import { JobRunner } from '../../server/ytdlp/job';
import { EXAMPLE_INPUT, exampleAnalysis, exampleAnswers, exampleTransition } from '../helpers/moodFixture';

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

/** A POST as a browser would make it, with whatever headers a test wants. */
function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/transition', () => {
  it('answers a batch with one verdict per candidate', async () => {
    const res = await post('/api/transition', {
      transitions: [exampleTransition('0:30'), exampleTransition('1:00')],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdicts: unknown[] };
    expect(body.verdicts).toHaveLength(2);
  });

  it('refuses a body that is not a batch', async () => {
    expect((await post('/api/transition', { transitions: [] })).status).toBe(400);
  });

  it('answers only POST', async () => {
    const res = await fetch(`${base}/api/transition`);
    expect(res.status).toBe(405);
  });
});

describe('the analysis cache', () => {
  const analysis = exampleAnalysis(ID);

  it('round-trips a record through the cache', async () => {
    expect((await fetch(`${base}/api/analysis/${ID}`)).status).toBe(404);

    const stored = await post(`/api/analysis/${ID}`, analysis);
    expect(stored.status).toBe(200);

    const res = await fetch(`${base}/api/analysis/${ID}`);
    expect(res.status).toBe(200);
    const back = (await res.json()) as typeof analysis;
    expect(back.segments).toEqual(analysis.segments);
    expect(back.transitions).toEqual(analysis.transitions);
    expect(back.cues).toEqual(analysis.cues);
    expect(back.log).toEqual(analysis.log);
    expect(back.videoId).toBe(ID);
  });

  it('refuses a record that is not one', async () => {
    expect((await post(`/api/analysis/${ID}`, { title: 'x' })).status).toBe(400);
    expect((await post(`/api/analysis/${ID}`, { ...analysis, cues: [{ t: 1 }] })).status).toBe(400);
  });

  it('refuses an id that is not a video id', async () => {
    expect((await post('/api/analysis/not-an-id', analysis)).status).toBe(400);
    expect((await fetch(`${base}/api/analysis/not-an-id`)).status).toBe(404);
  });

  it('reads a corrupt cache file as a miss rather than serving it', async () => {
    writeFileSync(join(dir, `${ID}.analysis.json`), '{"title": "half a fi');
    expect((await fetch(`${base}/api/analysis/${ID}`)).status).toBe(404);
  });
});

describe('the guards on the routes that spend something', () => {
  const guarded: Array<[string, unknown]> = [
    ['/api/mood', EXAMPLE_INPUT],
    ['/api/transition', { transitions: [exampleTransition('0:30')] }],
    ['/api/resolve', { url: `https://www.youtube.com/watch?v=${ID}` }],
    [`/api/analysis/${ID}`, exampleAnalysis(ID)],
  ];

  it('refuses a cross-origin POST', async () => {
    for (const [path, body] of guarded) {
      const res = await post(path, body, { origin: 'https://evil.example' });
      expect(res.status, path).toBe(403);
    }
  });

  it('allows a same-origin POST', async () => {
    for (const [path, body] of guarded) {
      const res = await post(path, body, { origin: base });
      expect(res.status, path).toBeLessThan(400);
    }
  });

  it('allows a POST with no Origin at all, which is how curl asks', async () => {
    for (const [path, body] of guarded) {
      expect((await post(path, body)).status, path).toBeLessThan(400);
    }
  });

  it('insists on a JSON content type', async () => {
    for (const [path, body] of guarded) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(415);
    }
  });

  it('takes a content type with parameters on it', async () => {
    const res = await post('/api/mood', EXAMPLE_INPUT, { 'content-type': 'application/json; charset=utf-8' });
    expect(res.status).toBe(200);
  });

  it('leaves GET alone', async () => {
    const res = await fetch(`${base}/api/analysis/${ID}`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(404);
  });
});

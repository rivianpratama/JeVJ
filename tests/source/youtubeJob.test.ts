import { describe, expect, it } from 'vitest';

import { resolveYouTube, type JobState } from '../../src/source/youtubeJob';

const ID = 'jNQXAC9IVRw';
const URL_IN = `https://www.youtube.com/watch?v=${ID}`;

function state(over: Partial<JobState> = {}): JobState {
  return { id: ID, videoId: ID, status: 'downloading', percent: 0, ...over };
}

const DONE = state({ status: 'done', percent: 100, title: 'Me at the zoo', durationSec: 19, mediaUrl: `/media/${ID}.mp4` });

/**
 * A fetch that answers `/api/resolve` once and then walks the given job states,
 * repeating the last one. Records every call so the test can see the polling.
 */
function fakeFetch(states: JobState[], resolveReply: { status: number; body: unknown } = { status: 200, body: { jobId: ID } }) {
  const calls: string[] = [];
  let polls = 0;
  const fn = async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${input}${init?.body === undefined ? '' : ` ${init.body}`}`);
    if (input.endsWith('/api/resolve')) {
      return new Response(JSON.stringify(resolveReply.body), {
        status: resolveReply.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    const next = states[Math.min(polls++, states.length - 1)];
    if (next === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as unknown as typeof fetch, calls, get polls() { return polls; } };
}

/** A sleep that returns at once but remembers what it was asked to wait. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe('resolveYouTube', () => {
  it('resolves the url, polls the job and returns the media', async () => {
    const fetcher = fakeFetch([state({ percent: 10 }), state({ percent: 60 }), DONE]);
    const seen: JobState[] = [];

    const out = await resolveYouTube(URL_IN, (p) => seen.push(p), fetcher.fn, fakeSleep().sleep);

    expect(out).toEqual({ mediaUrl: `/media/${ID}.mp4`, title: 'Me at the zoo', durationSec: 19 });
    expect(fetcher.calls[0]).toBe(`POST /api/resolve {"url":"${URL_IN}"}`);
    expect(fetcher.calls[1]).toBe(`GET /api/job/${ID}`);
    expect(seen.map((s) => s.percent)).toEqual([10, 60, 100]);
  });

  it('waits half a second between polls, and not before the first', async () => {
    const clock = fakeSleep();
    await resolveYouTube(URL_IN, () => {}, fakeFetch([state(), state(), DONE]).fn, clock.sleep);
    expect(clock.waits).toEqual([500, 500]);
  });

  it('answers at once when the video was already cached', async () => {
    const fetcher = fakeFetch([DONE]);
    const clock = fakeSleep();
    await resolveYouTube(URL_IN, () => {}, fetcher.fn, clock.sleep);
    expect(fetcher.polls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it('rejects with the message the job failed on', async () => {
    const fetcher = fakeFetch([state({ percent: 5 }), state({ status: 'error', error: 'Video unavailable' })]);
    await expect(resolveYouTube(URL_IN, () => {}, fetcher.fn, fakeSleep().sleep)).rejects.toThrow('Video unavailable');
  });

  it('rejects when the url was not accepted', async () => {
    const fetcher = fakeFetch([], { status: 400, body: { error: 'not a YouTube link' } });
    await expect(resolveYouTube('nope', () => {}, fetcher.fn, fakeSleep().sleep)).rejects.toThrow('not a YouTube link');
  });

  it('rejects when the job disappears', async () => {
    const fetcher = fakeFetch([]);
    await expect(resolveYouTube(URL_IN, () => {}, fetcher.fn, fakeSleep().sleep)).rejects.toThrow();
  });

  it('rejects rather than hanging when a finished job has no media', async () => {
    const fetcher = fakeFetch([state({ status: 'done', percent: 100 })]);
    await expect(resolveYouTube(URL_IN, () => {}, fetcher.fn, fakeSleep().sleep)).rejects.toThrow();
  });

  it('fills in a missing title and duration rather than failing', async () => {
    const fetcher = fakeFetch([state({ status: 'done', percent: 100, mediaUrl: `/media/${ID}.mp4` })]);
    const out = await resolveYouTube(URL_IN, () => {}, fetcher.fn, fakeSleep().sleep);
    expect(out).toEqual({ mediaUrl: `/media/${ID}.mp4`, title: '', durationSec: 0 });
  });
});

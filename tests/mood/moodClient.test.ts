import { describe, expect, it } from 'vitest';
import { MoodClient } from '../../src/mood/moodClient';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import type { MoodInput, MoodResponse } from '../../src/shared/types';
import { EXAMPLE_INPUT } from '../helpers/moodFixture';

const OK_BODY: MoodResponse = {
  mood: { ...NEUTRAL_MOOD, valence: 0.8, confidence: 0.7 },
  usage: { input_tokens: 1800, output_tokens: 120 },
  latencyMs: 220,
};

interface Reply {
  status: number;
  body?: unknown;
}

function fakeFetch(replies: Reply[] = []) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = async (input: unknown, init?: { body?: string }): Promise<unknown> => {
    calls.push({ url: String(input), body: init?.body === undefined ? null : JSON.parse(init.body) });
    const reply = replies.shift() ?? { status: 200, body: OK_BODY };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? OK_BODY,
    };
  };
  return { calls, fn: fn as unknown as typeof fetch };
}

/**
 * A client whose loop has already been running since audio time 0, which is
 * what the 1.5 s opening delay is measured from.
 */
function primed(replies: Reply[] = []) {
  const fetchFn = fakeFetch(replies);
  const client = new MoodClient({ fetchFn: fetchFn.fn });
  client.maybeRequest(0, EXAMPLE_INPUT, 0, false, true, true, null);
  return { client, calls: fetchFn.calls };
}

/** Drive one frame and settle whatever it started. */
async function frame(
  client: MoodClient,
  now: number,
  o: {
    novelty?: number;
    sectionChanged?: boolean;
    playing?: boolean;
    visible?: boolean;
    phrase?: number | null;
  } = {},
): Promise<MoodResponse | null | 'idle'> {
  const p = client.maybeRequest(
    now,
    EXAMPLE_INPUT,
    o.novelty ?? 0,
    o.sectionChanged ?? false,
    o.playing ?? true,
    o.visible ?? true,
    o.phrase ?? null,
  );
  if (p === null) return 'idle';
  return await p;
}

describe('MoodClient cadence', () => {
  it('says nothing for the first 1.5 s, then asks', async () => {
    const fetchFn = fakeFetch();
    const calls = fetchFn.calls;
    const client = new MoodClient({ fetchFn: fetchFn.fn });

    expect(await frame(client, 0, { novelty: 1 })).toBe('idle');
    expect(await frame(client, 1.4, { novelty: 1 })).toBe('idle');
    expect(calls.length).toBe(0);

    const res = await frame(client, 1.5, { novelty: 1 });
    expect(res).not.toBe('idle');
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('/api/mood');
    // The payload, plus the questions this call is worth asking.
    expect(calls[0]?.body).toMatchObject(EXAMPLE_INPUT);
    expect((calls[0]?.body as { ask: string[] }).ask).toContain('valence');
  });

  it('waits the full 8 s when nothing is changing', async () => {
    const { client, calls } = primed();
    await frame(client, 1.5, { novelty: 0 });

    expect(await frame(client, 4, { novelty: 0 })).toBe('idle');
    expect(await frame(client, 9.49, { novelty: 0 })).toBe('idle');
    expect(calls.length).toBe(1);

    expect(await frame(client, 9.5, { novelty: 0 })).not.toBe('idle');
    expect(calls.length).toBe(2);
  });

  it('asks again after 2.5 s when everything is changing', async () => {
    const { client, calls } = primed();
    await frame(client, 1.5, { novelty: 1 });

    expect(await frame(client, 3.9, { novelty: 1 })).toBe('idle');
    expect(await frame(client, 4, { novelty: 1 })).not.toBe('idle');
    expect(calls.length).toBe(2);
  });

  it('lets a section change fire at the floor even with no novelty', async () => {
    const { client, calls } = primed();
    await frame(client, 1.5, { novelty: 1 });

    expect(await frame(client, 3.9, { novelty: 0, sectionChanged: true })).toBe('idle');
    expect(await frame(client, 4, { novelty: 0, sectionChanged: true })).not.toBe('idle');
  });

  it('pre-fetches about a second before a phrase boundary', async () => {
    const { client, calls } = primed();
    await frame(client, 1.5, { novelty: 1 });

    // Too soon after the last call, however close the boundary is.
    expect(await frame(client, 3, { novelty: 0, phrase: 1 })).toBe('idle');
    // Past the floor but outside the window.
    expect(await frame(client, 4.2, { novelty: 0, phrase: 2.5 })).toBe('idle');
    expect(await frame(client, 4.3, { novelty: 0, phrase: 0.7 })).toBe('idle');
    // Inside it.
    expect(await frame(client, 4.4, { novelty: 0, phrase: 1 })).not.toBe('idle');
  });

  it('stays quiet while paused or hidden', async () => {
    const { client, calls } = primed();
    for (const t of [1.5, 5, 20, 60]) {
      expect(await frame(client, t, { novelty: 1, playing: false })).toBe('idle');
      expect(await frame(client, t, { novelty: 1, visible: false })).toBe('idle');
    }
    expect(calls.length).toBe(0);
  });

  it('keeps one request in flight at a time', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: number[] = [];
    const fn = (async () => {
      calls.push(1);
      await gate;
      return { ok: true, status: 200, json: async () => OK_BODY };
    }) as unknown as typeof fetch;

    const client = new MoodClient({ fetchFn: fn });
    client.maybeRequest(0, EXAMPLE_INPUT, 0, false, true, true, null);
    const first = client.maybeRequest(1.5, EXAMPLE_INPUT, 1, false, true, true, null);
    expect(first).not.toBeNull();
    expect(client.maybeRequest(10, EXAMPLE_INPUT, 1, false, true, true, null)).toBeNull();
    expect(calls.length).toBe(1);

    release();
    await first;
    expect(await frame(client, 10, { novelty: 1 })).not.toBe('idle');
    expect(calls.length).toBe(2);
  });

  it('backs off 4 s then 8 s when the server pushes back', async () => {
    const { client, calls } = primed([{ status: 429 }, { status: 429 }]);

    expect(await frame(client, 1.5, { novelty: 1 })).toBeNull();
    expect(await frame(client, 5.4, { novelty: 1 })).toBe('idle');
    expect(await frame(client, 5.5, { novelty: 1 })).toBeNull();
    expect(calls.length).toBe(2);

    expect(await frame(client, 13.4, { novelty: 1 })).toBe('idle');
    expect(await frame(client, 13.5, { novelty: 1 })).not.toBe('idle');
    expect(calls.length).toBe(3);
    expect(client.stats().errors).toBe(2);
  });

  it('stops asking for a minute after a request the server refuses', async () => {
    const { client } = primed([{ status: 400, body: { error: 'bad input' } }]);

    expect(await frame(client, 1.5, { novelty: 1 })).toBeNull();
    expect(await frame(client, 60, { novelty: 1 })).toBe('idle');
    expect(await frame(client, 61.5, { novelty: 1 })).not.toBe('idle');
  });

  it('counts calls, tokens and latency', async () => {
    const { client, calls } = primed();
    await frame(client, 1.5, { novelty: 1 });
    await frame(client, 4, { novelty: 1 });

    const s = client.stats();
    expect(s.calls).toBe(2);
    expect(s.tokens).toBe(2 * (1800 + 120));
    expect(s.lastLatencyMs).toBe(220);
    expect(s.errors).toBe(0);
    expect(client.nextAllowedAt()).toBeCloseTo(6.5, 10);
  });

  it('survives a fetch that throws', async () => {
    const fn = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const client = new MoodClient({ fetchFn: fn });
    client.maybeRequest(0, EXAMPLE_INPUT, 0, false, true, true, null);
    expect(await frame(client, 1.5, { novelty: 1 })).toBeNull();
    expect(client.stats().errors).toBe(1);
    expect(client.stats().backoffUntil).toBeCloseTo(5.5, 10);
  });

  it('ignores a body that is not a mood', async () => {
    const { client } = primed([{ status: 200, body: { mood: { valence: 2 } } }]);
    expect(await frame(client, 1.5, { novelty: 1 })).toBeNull();
    expect(client.stats().errors).toBe(1);
  });
});

/** A payload with nothing building under it: the predictions are not worth asking. */
const CALM_INPUT: MoodInput = {
  ...EXAMPLE_INPUT,
  slope4: 0,
  slope8: 0,
  onsetRatio: 1,
  centroidSlope: 0,
  barInPhrase: 2,
};

/** One call, with the payload under the test's control. */
async function ask(client: MoodClient, now: number, input: MoodInput): Promise<void> {
  const p = client.maybeRequest(now, input, 1, true, true, true, null);
  if (p !== null) await p;
}

describe('MoodClient question sets', () => {
  it('asks the core ten every call and the nouls on alternate ones', async () => {
    const fetchFn = fakeFetch();
    const client = new MoodClient({ fetchFn: fetchFn.fn });
    client.maybeRequest(0, CALM_INPUT, 0, false, true, true, null);

    for (const at of [1.5, 4, 6.5, 9]) await ask(client, at, CALM_INPUT);

    const asked = fetchFn.calls.map((c) => (c.body as { ask: string[] }).ask);
    expect(asked.length).toBe(4);
    for (const ids of asked) {
      expect(ids).toContain('valence');
      expect(ids).toContain('genre');
      expect(ids).not.toContain('drop_imminent');
    }
    expect(asked.map((ids) => ids.includes('hypnotic'))).toEqual([true, false, true, false]);
  });

  it('asks the predictions once the payload is building', async () => {
    const fetchFn = fakeFetch();
    const client = new MoodClient({ fetchFn: fetchFn.fn });
    client.maybeRequest(0, CALM_INPUT, 0, false, true, true, null);

    await ask(client, 1.5, CALM_INPUT);
    await ask(client, 4, EXAMPLE_INPUT);

    const asked = fetchFn.calls.map((c) => (c.body as { ask: string[] }).ask);
    expect(asked[0]).not.toContain('drop_imminent');
    expect(asked[1]).toContain('drop_imminent');
    expect(asked[1]).toContain('beats_to_change');
  });

  it('carries its last answer, so the server can fill in what it did not ask', async () => {
    const fetchFn = fakeFetch();
    const client = new MoodClient({ fetchFn: fetchFn.fn });
    client.maybeRequest(0, CALM_INPUT, 0, false, true, true, null);

    await ask(client, 1.5, CALM_INPUT);
    await ask(client, 4, CALM_INPUT);

    const bodies = fetchFn.calls.map((c) => c.body as { prev?: { valence: number } });
    // Nothing to carry on the first call.
    expect(bodies[0]?.prev).toBeUndefined();
    expect(bodies[1]?.prev?.valence).toBe(0.8);
  });

  it('keeps the whole body inside the 2 KB the server will read', async () => {
    const fetchFn = fakeFetch();
    const client = new MoodClient({ fetchFn: fetchFn.fn });
    client.maybeRequest(0, EXAMPLE_INPUT, 0, false, true, true, null);

    for (const at of [1.5, 4, 6.5]) await ask(client, at, EXAMPLE_INPUT);

    // The worst case: every question asked, and a whole vector carried with
    // them — which is an even call, once there has been an answer to carry.
    const body = fetchFn.calls[2]?.body;
    expect((body as { ask: string[] }).ask.length).toBe(18);
    expect((body as { prev?: unknown }).prev).toBeDefined();
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(2048);
  });
});

describe('MoodClient backoff', () => {
  it('counts the backoff from when the request failed, not from when it went out', async () => {
    const fetchFn = fakeFetch([{ status: 500 }]);
    const client = new MoodClient({ fetchFn: fetchFn.fn });
    client.maybeRequest(0, EXAMPLE_INPUT, 0, false, true, true, null);

    const pending = client.maybeRequest(10, EXAMPLE_INPUT, 1, false, true, true, null);
    expect(pending).not.toBeNull();
    // A 1.1 s round trip, as measured against the live model: the tick keeps
    // running underneath it and keeps showing the client the audio clock.
    for (const at of [10.5, 11.1]) {
      expect(client.maybeRequest(at, EXAMPLE_INPUT, 1, false, true, true, null)).toBeNull();
    }
    await pending;

    // 4 s from the failure at 11.1, not from the dispatch at 10.
    expect(client.stats().backoffUntil).toBeCloseTo(15.1, 10);
    expect(await frame(client, 15, { novelty: 1 })).toBe('idle');
  });
});

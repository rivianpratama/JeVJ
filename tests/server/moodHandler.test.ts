import { describe, expect, it } from 'vitest';
import { handleMood, type JevLike } from '../../server/moodHandler';
import { MOOD_QUESTIONS } from '../../src/mood/questions';
import { NEUTRAL_MOOD, validateMoodVector } from '../../src/shared/moodSchema';
import type { MoodResponse, MoodVector } from '../../src/shared/types';
import { EXAMPLE_INPUT, exampleAnswers } from '../helpers/moodFixture';

function fakeClient(over: Partial<JevLike> = {}): JevLike & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    async systemOne(req) {
      seen.push(req);
      return { answers: exampleAnswers(), usage: { input_tokens: 1800, output_tokens: 120 } };
    },
    ...over,
  };
}

function mood(json: MoodResponse | { error: string }): MoodResponse {
  if ('error' in json) throw new Error(`expected a mood, got ${json.error}`);
  return json;
}

describe('handleMood', () => {
  it('rejects a payload the schema does not accept', async () => {
    const res = await handleMood({ bpm: 128 }, { client: fakeClient() });
    expect(res.status).toBe(400);
    expect(res.json).toHaveProperty('error');
  });

  it('rejects a body that is not an object at all', async () => {
    expect((await handleMood('hello', { client: fakeClient() })).status).toBe(400);
    expect((await handleMood(null, { client: fakeClient() })).status).toBe(400);
  });

  it('answers a valid payload with a decoded mood, usage and latency', async () => {
    let t = 1000;
    const client = fakeClient();
    const res = await handleMood(EXAMPLE_INPUT, { client, now: () => (t += 40) });

    expect(res.status).toBe(200);
    const body = mood(res.json);
    expect(validateMoodVector(body.mood).ok).toBe(true);
    expect(body.mood.genre).toBe('electronic_dance');
    expect(body.usage).toEqual({ input_tokens: 1800, output_tokens: 120 });
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.latencyMs).toBe(40);
  });

  it('asks the model the mood questions about the validated payload', async () => {
    const client = fakeClient();
    await handleMood({ ...EXAMPLE_INPUT, nonsense: 1 }, { client });
    const req = client.seen[0] as { state: { music: unknown }; questions: unknown; model?: string };
    expect(req.questions).toBe(MOOD_QUESTIONS);
    expect(req.model).toBe('jev-latest');
    expect(req.state.music).toEqual(EXAMPLE_INPUT);
    expect(req.state.music).not.toHaveProperty('nonsense');
  });

  it('turns a client failure into a 502 that leaks nothing', async () => {
    const client = fakeClient({
      systemOne: () => Promise.reject(new Error('401 Unauthorized: key sk-live-abc123 rejected')),
    });
    const res = await handleMood(EXAMPLE_INPUT, { client });
    expect(res.status).toBe(502);
    const text = JSON.stringify(res.json);
    expect(res.json).toHaveProperty('error');
    expect(text).not.toContain('sk-live-abc123');
    expect(text).not.toContain('at ');
  });

  it('reports the upstream status when the client error carries one', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const res = await handleMood(EXAMPLE_INPUT, { client: fakeClient({ systemOne: () => Promise.reject(err) }) });
    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toContain('429');
  });

  it('asks every question, whatever the request says it wants', async () => {
    // v1 let the caller name the questions worth spending tokens on and carry
    // its last vector so the rest could be filled in. v2 asks once per segment
    // before a track plays, so there is nothing to economize on and no half
    // vector to reason about. A request that still carries the old fields gets
    // the whole set and is otherwise ignored.
    const client = fakeClient();
    const res = await handleMood(
      { ...EXAMPLE_INPUT, ask: ['valence', 'genre'], prev: { ...NEUTRAL_MOOD, aggression: 0.77 } },
      { client },
    );
    const req = client.seen[0] as { questions: unknown };
    expect(req.questions).toBe(MOOD_QUESTIONS);
    expect(res.status).toBe(200);
    // Nothing carried over: the answer is only what the model said this time.
    expect(mood(res.json).mood.aggression).not.toBe(0.77);
    expect(validateMoodVector(mood(res.json).mood).ok).toBe(true);
  });
});

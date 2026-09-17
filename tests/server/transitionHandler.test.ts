import { describe, expect, it } from 'vitest';

import type { JevLike } from '../../server/moodHandler';
import { handleTransition, TRANSITION_MODEL } from '../../server/transitionHandler';
import { questionId } from '../../src/mood/transitionQuestions';
import { validateTransitionVerdict } from '../../src/shared/moodSchema';
import type { TransitionResponse } from '../../src/shared/types';
import { exampleTransition } from '../helpers/moodFixture';

/** Answers for every candidate the request carried, each a different kind. */
const KINDS = ['drop', 'breakdown', 'vocal_entry', 'scream_peak'] as const;

function fakeClient(over: Partial<JevLike> = {}): JevLike & { seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    async systemOne(req) {
      seen.push(req as unknown as Record<string, unknown>);
      const answers: Record<string, unknown> = {};
      const count = Object.keys(req.questions).length / 4;
      for (let i = 0; i < count; i++) {
        answers[questionId('kind', i)] = {
          choice: KINDS[i % KINDS.length],
          probabilities: { [KINDS[i % KINDS.length]!]: 0.8, none: 0.2 },
          confidence: 0.7,
        };
        answers[questionId('intensity', i)] = { score: 4 - i, confidence: 0.6 };
        answers[questionId('dramatic', i)] = { noul: 0.9 - i * 0.2 };
        answers[questionId('release', i)] = { score: 1, confidence: 0.5 };
      }
      return { answers, usage: { input_tokens: 2200, output_tokens: 240 } };
    },
    ...over,
  };
}

function verdicts(json: TransitionResponse | { error: string }): TransitionResponse {
  if ('error' in json) throw new Error(`expected verdicts, got ${json.error}`);
  return json;
}

const batch = (n: number) => ({
  transitions: Array.from({ length: n }, (_, i) => exampleTransition(`0:${String(10 + i).padStart(2, '0')}`)),
});

describe('handleTransition', () => {
  it('answers a batch of four with four verdicts, in order', async () => {
    const res = await handleTransition(batch(4), { client: fakeClient() });
    expect(res.status).toBe(200);
    const body = verdicts(res.json);
    expect(body.verdicts).toHaveLength(4);
    expect(body.verdicts.map((v) => v.kind)).toEqual([...KINDS]);
    expect(body.verdicts.map((v) => v.intensity)).toEqual([1, 0.75, 0.5, 0.25]);
    for (const v of body.verdicts) expect(validateTransitionVerdict(v).ok).toBe(true);
  });

  it('answers a short batch with exactly as many verdicts', async () => {
    const res = await handleTransition(batch(2), { client: fakeClient() });
    expect(verdicts(res.json).verdicts).toHaveLength(2);
  });

  it('asks four questions per candidate about the validated candidates', async () => {
    const client = fakeClient();
    const one = exampleTransition('1:00');
    await handleTransition({ transitions: [{ ...one, nonsense: 1 }] }, { client });

    const req = client.seen[0] as unknown as {
      state: Record<string, unknown>;
      questions: Record<string, unknown>;
      model?: string;
    };
    expect(Object.keys(req.questions)).toEqual(['kind_0', 'intensity_0', 'dramatic_0', 'release_0']);
    expect(req.model).toBe(TRANSITION_MODEL);
    expect(req.state['t0']).toEqual(one);
    expect(req.state['t0']).not.toHaveProperty('nonsense');
    expect(req.state['legend']).toBeDefined();
  });

  it('reports usage and latency', async () => {
    let t = 500;
    const res = await handleTransition(batch(1), { client: fakeClient(), now: () => (t += 120) });
    const body = verdicts(res.json);
    expect(body.usage).toEqual({ input_tokens: 2200, output_tokens: 240 });
    expect(body.latencyMs).toBe(120);
  });

  it('refuses a body that is not a batch', async () => {
    for (const body of [null, 'hello', {}, { transitions: [] }, { transitions: {} }]) {
      const res = await handleTransition(body, { client: fakeClient() });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toHaveProperty('error');
    }
  });

  it('refuses more than four candidates at once', async () => {
    const res = await handleTransition(batch(5), { client: fakeClient() });
    expect(res.status).toBe(400);
  });

  it('names the candidate that was wrong', async () => {
    const bad = { transitions: [exampleTransition('1:00'), { ...exampleTransition('1:10'), jumpDb: 'loud' }] };
    const res = await handleTransition(bad, { client: fakeClient() });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toContain('transitions[1].jumpDb');
  });

  it('refuses a candidate whose music page is not one', async () => {
    const bad = { transitions: [{ ...exampleTransition('1:00'), after: { bpm: 128 } }] };
    expect((await handleTransition(bad, { client: fakeClient() })).status).toBe(400);
  });

  it('turns a client failure into a 502 that leaks nothing', async () => {
    const client = fakeClient({
      async systemOne() {
        throw Object.assign(new Error('POST https://api/... apiKey=sk-secret'), { status: 429 });
      },
    });
    const res = await handleTransition(batch(1), { client });
    expect(res.status).toBe(502);
    const error = (res.json as { error: string }).error;
    expect(error).toBe('transition service returned 429');
    expect(error).not.toContain('sk-');
  });

  it('says nothing at all about a failure with no status on it', async () => {
    const client = fakeClient({
      async systemOne() {
        throw new Error('connect ECONNREFUSED /Users/someone/.env');
      },
    });
    const res = await handleTransition(batch(1), { client });
    expect(res.json).toEqual({ error: 'transition service unavailable' });
  });

  it('falls back to a neutral verdict for a candidate the model skipped', async () => {
    const client = fakeClient({
      async systemOne() {
        return { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const body = verdicts((await handleTransition(batch(3), { client })).json);
    expect(body.verdicts).toHaveLength(3);
    expect(body.verdicts.every((v) => v.kind === 'none' && v.confidence === 0)).toBe(true);
  });
});

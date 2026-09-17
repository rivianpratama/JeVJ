import { describe, expect, it } from 'vitest';

import { decodeTransition, decodeTransitions, NEUTRAL_VERDICT } from '../../src/mood/transitionDecode';
import {
  buildTransitionState,
  candidateKey,
  questionId,
  TRANSITION_BATCH,
  TRANSITION_PREAMBLE,
  transitionQuestions,
} from '../../src/mood/transitionQuestions';
import { validateTransitionVerdict } from '../../src/shared/moodSchema';
import { estimateTokens } from '../../src/shared/tokens';
import { TRANSITION_KINDS } from '../../src/shared/types';
import { exampleTransition } from '../helpers/moodFixture';

describe('transitionQuestions', () => {
  it('asks four questions per candidate, suffixed by index', () => {
    const q = transitionQuestions(3);
    expect(Object.keys(q)).toEqual([
      'kind_0', 'intensity_0', 'dramatic_0', 'release_0',
      'kind_1', 'intensity_1', 'dramatic_1', 'release_1',
      'kind_2', 'intensity_2', 'dramatic_2', 'release_2',
    ]);
  });

  it('names the candidate each question is about in its instructions', () => {
    const q = transitionQuestions(TRANSITION_BATCH);
    for (let i = 0; i < TRANSITION_BATCH; i++) {
      for (const id of ['kind', 'intensity', 'dramatic', 'release'] as const) {
        const question = q[questionId(id, i)];
        expect(String(question?.instructions)).toContain(`\`${candidateKey(i)}\``);
      }
    }
  });

  it('offers every transition kind, with the plan\'s wording', () => {
    const kind = transitionQuestions(1)['kind_0'];
    expect(kind?.type).toBe('choice');
    if (kind?.type !== 'choice') throw new Error('kind must be a choice');
    expect(Object.keys(kind.criteria)).toEqual([...TRANSITION_KINDS]);
    expect(kind.criteria['drop']).toEqual({
      what: 'the payoff: full energy slams in after a build or gap, and a beat comes with it',
      not_for: [
        'a harsh, screamed or distorted climax; that is scream_peak',
        'applause, laughter, crowd noise or a noise burst without a beat (burst is true); that is break_silence or none',
        'a gradual orchestral or ambient swell without a beat (beatless is true); that is none',
        'a speaker starting again after a breath (speech >= 0.5 and pause high either side); that is none',
      ],
      requires: 'a beat under what follows: beatless must be false',
    });
    expect(kind.criteria['scream_peak']).toEqual({
      what: 'harsh, screamed or distorted climax',
      signals: ['harsh at or above 0.6', 'harshDelta positive', 'noise high', 'very bright', 'loud'],
      not_for: 'a bright synthetic lead or supersaw, which is loud and flat without being screamed',
      note: 'a track that screams continuously still has peaks: name the moments the harshness steps up, not only the one loudest instant',
      prefer_over:
        'tempo_change and key_change, when harsh is at or above 0.6 and harshDelta is positive — a screamed entry moves the harshness, not the pulse',
    });
    expect(kind.criteria['none']).toEqual({ what: 'no meaningful change here' });
  });

  it('scores intensity over five levels and release over three', () => {
    const q = transitionQuestions(1);
    const intensity = q['intensity_0'];
    const release = q['release_0'];
    if (intensity?.type !== 'score' || release?.type !== 'score') throw new Error('both are scores');
    expect(intensity.criteria).toEqual([
      'imperceptible', 'gentle shift', 'clear change', 'strong hit', 'overwhelming slam',
    ]);
    expect(release.criteria).toEqual([
      'tension is being built', 'neutral', 'tension is being released',
    ]);
  });

  it('asks the jolt question as a noul, verbatim', () => {
    const dramatic = transitionQuestions(1)['dramatic_0'];
    expect(dramatic?.type).toBe('noul');
    expect(String(dramatic?.instructions)).toContain(
      'Would a listener feel a jolt (goosebumps, a held breath, a gasp) at this moment?',
    );
  });

  it('clamps a batch size outside 1..4 rather than refusing it', () => {
    expect(Object.keys(transitionQuestions(0))).toHaveLength(4);
    expect(Object.keys(transitionQuestions(9))).toHaveLength(4 * TRANSITION_BATCH);
  });
});

describe('buildTransitionState', () => {
  it('carries the candidates as t0.. and the legend with them', () => {
    const a = exampleTransition('1:00');
    const b = exampleTransition('2:04');
    const state = buildTransitionState([a, b]);
    expect(state['t0']).toBe(a);
    expect(state['t1']).toBe(b);
    expect(state['t2']).toBeUndefined();
    expect(state.legend).toBe(TRANSITION_PREAMBLE);
  });

  it('explains the music fields as well as the moment fields', () => {
    expect(TRANSITION_PREAMBLE['crest']).toBe('0 smooth..1 spiky');
    expect(TRANSITION_PREAMBLE['vocalDelta']).toContain('sung voice');
  });

  it('drops candidates past the batch size', () => {
    const state = buildTransitionState(Array.from({ length: 6 }, () => exampleTransition('0:30')));
    expect(state['t3']).toBeDefined();
    expect(state['t4']).toBeUndefined();
  });

  it('keeps a full batch inside the 8 KB body limit', () => {
    const inputs = Array.from({ length: TRANSITION_BATCH }, () => exampleTransition('2:04'));
    expect(JSON.stringify({ transitions: inputs }).length).toBeLessThanOrEqual(8 * 1024);
    // The state the server builds carries the legend too, and still has to be
    // a sane prompt rather than a novel: eight music pages at ~150 estimated
    // tokens each, the legend at ~270, and the moment fields on top.
    expect(estimateTokens(JSON.stringify(buildTransitionState(inputs)))).toBeLessThanOrEqual(2000);
  });
});

/** One candidate's worth of answers, as the API returns them. */
function answersFor(index: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [questionId('kind', index)]: {
      choice: 'drop',
      probabilities: { drop: 0.7, breakdown: 0.2, nonsense_label: 5 },
      confidence: 0.8,
    },
    [questionId('intensity', index)]: { score: 4, confidence: 0.6 },
    [questionId('dramatic', index)]: { noul: 0.75 },
    [questionId('release', index)]: { score: 2, confidence: 0.7 },
    ...over,
  };
}

describe('decodeTransition', () => {
  it('reads one candidate out of a batch of answers', () => {
    const v = decodeTransition(answersFor(2), 2);
    expect(v.kind).toBe('drop');
    expect(v.intensity).toBe(1);
    expect(v.dramatic).toBe(0.75);
    expect(v.release).toBe(1);
    expect(v.confidence).toBeCloseTo((0.8 + 0.6 + 0.7) / 3, 6);
    expect(validateTransitionVerdict(v).ok).toBe(true);
  });

  it('scales each score by its own number of levels', () => {
    const mid = decodeTransition(
      answersFor(0, { intensity_0: { score: 2 }, release_0: { score: 1 } }),
      0,
    );
    expect(mid.intensity).toBe(0.5);
    expect(mid.release).toBe(0.5);
  });

  it('drops labels it does not know and renormalizes the rest', () => {
    const v = decodeTransition(answersFor(0), 0);
    const total = TRANSITION_KINDS.reduce((a, k) => a + v.kindP[k], 0);
    expect(total).toBeCloseTo(1, 6);
    expect(v.kindP['drop']).toBeCloseTo(0.7 / 0.9, 6);
    expect(Object.keys(v.kindP)).toEqual([...TRANSITION_KINDS]);
  });

  it('falls back to a neutral verdict when nobody answered', () => {
    expect(decodeTransition({}, 1)).toEqual(NEUTRAL_VERDICT);
  });

  it('reads the index it is given and not its neighbour', () => {
    const answers = { ...answersFor(0), ...answersFor(1, { kind_1: { choice: 'breakdown' } }) };
    expect(decodeTransition(answers, 0).kind).toBe('drop');
    expect(decodeTransition(answers, 1).kind).toBe('breakdown');
  });

  it('splits a whole batch back into one verdict per candidate', () => {
    const answers = { ...answersFor(0), ...answersFor(1, { kind_1: { choice: 'quiet_fall' } }) };
    const out = decodeTransitions(answers, 3);
    expect(out).toHaveLength(3);
    expect(out.map((v) => v.kind)).toEqual(['drop', 'quiet_fall', 'none']);
    expect(out[2]?.confidence).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CORE_IDS,
  MOOD_PREAMBLE,
  MOOD_QUESTIONS,
  NOUL_IDS,
  PREDICTIVE_IDS,
  buildState,
  questionsFor,
  selectQuestionIds,
} from '../../src/mood/questions';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { estimateTokens } from '../../src/shared/tokens';
import {
  BEATS_TO_CHANGE,
  GENRES,
  MOTIONS,
  PRE_DROP_STYLES,
  SECTIONS,
} from '../../src/shared/types';
import type { MoodInput } from '../../src/shared/types';
import { EXAMPLE_INPUT } from '../helpers/moodFixture';

const EXPECTED_KEYS = [
  'valence',
  'arousal',
  'tension',
  'warmth',
  'synthetic',
  'space',
  'aggression',
  'melancholy',
  'hypnotic',
  'euphoric_peak',
  'spoken',
  'genre',
  'section',
  'motion',
  'drop_imminent',
  'beats_to_change',
  'impact',
  'pre_drop_style',
];

describe('MOOD_QUESTIONS', () => {
  it('asks exactly the eighteen questions the mood vector is decoded from', () => {
    expect(Object.keys(MOOD_QUESTIONS).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('gives every score question five ordered levels', () => {
    for (const [name, q] of Object.entries(MOOD_QUESTIONS)) {
      if (q.type !== 'score') continue;
      expect(q.criteria.length, name).toBe(5);
      for (const level of q.criteria) expect(typeof level, name).toBe('string');
    }
  });

  it('labels each choice question with exactly the shared const array', () => {
    const expected: Record<string, readonly string[]> = {
      genre: GENRES,
      section: SECTIONS,
      motion: MOTIONS,
      beats_to_change: BEATS_TO_CHANGE,
      pre_drop_style: PRE_DROP_STYLES,
    };
    for (const [name, labels] of Object.entries(expected)) {
      const q = MOOD_QUESTIONS[name];
      expect(q?.type, name).toBe('choice');
      if (q?.type !== 'choice') continue;
      expect(Object.keys(q.criteria).sort(), name).toEqual([...labels].sort());
    }
  });

  it('describes both outcomes of every noul', () => {
    for (const [name, q] of Object.entries(MOOD_QUESTIONS)) {
      if (q.type !== 'noul') continue;
      expect(typeof q.criteria?.true, name).toBe('string');
      expect(typeof q.criteria?.false, name).toBe('string');
    }
  });

  it('gives every question non-empty instructions', () => {
    for (const [name, q] of Object.entries(MOOD_QUESTIONS)) {
      expect(typeof q.instructions, name).toBe('string');
      expect(String(q.instructions).length, name).toBeGreaterThan(10);
    }
  });
});

describe('buildState', () => {
  it('carries the payload under music and the field legend beside it', () => {
    const state = buildState(EXAMPLE_INPUT);
    expect(state.music).toEqual(EXAMPLE_INPUT);
    expect(state.legend).toBe(MOOD_PREAMBLE);
    expect(state.legend['bpm']).toBe('beats per minute');
  });

  it('stays inside the per-call state budget', () => {
    // The legend is fixed text (~233 estimated tokens) and the payload is
    // ~143: the brief's 320 is not reachable with the legend it also mandates.
    expect(estimateTokens(JSON.stringify(buildState(EXAMPLE_INPUT)))).toBeLessThanOrEqual(400);
  });
});

describe('selectQuestionIds', () => {
  /** A payload with no build under it at all. */
  const CALM: MoodInput = {
    ...EXAMPLE_INPUT,
    slope4: 0,
    slope8: 0,
    onsetRatio: 1,
    centroidSlope: 0,
    barInPhrase: 2,
  };

  it('asks the ten core questions on every call', () => {
    for (let call = 0; call < 6; call++) {
      const ids = selectQuestionIds({ callIndex: call, input: CALM, previous: null });
      for (const id of CORE_IDS) expect(ids, `call ${call}`).toContain(id);
    }
    expect(CORE_IDS.length).toBe(10);
  });

  it('asks the nouls every other call, starting with the first', () => {
    const asked = (call: number): boolean =>
      selectQuestionIds({ callIndex: call, input: CALM, previous: null }).includes('hypnotic');
    expect([0, 1, 2, 3, 4].map(asked)).toEqual([true, false, true, false, true]);
  });

  it('leaves the predictions alone while nothing is building', () => {
    const ids = selectQuestionIds({ callIndex: 0, input: CALM, previous: null });
    for (const id of PREDICTIVE_IDS) expect(ids).not.toContain(id);
  });

  it('asks the predictions on any one of the four build cues', () => {
    const cued: Partial<MoodInput>[] = [
      { slope8: 2.5 },
      { onsetRatio: 1.4 },
      { barInPhrase: 12 },
    ];
    for (const over of cued) {
      const ids = selectQuestionIds({ callIndex: 1, input: { ...CALM, ...over }, previous: null });
      for (const id of PREDICTIVE_IDS) expect(ids, JSON.stringify(over)).toContain(id);
    }
    // And the fourth cue is not in the payload at all: it is what Jev said the
    // last time, which is the only thing that knows a build has been declared.
    const after = selectQuestionIds({
      callIndex: 1,
      input: CALM,
      previous: { ...NEUTRAL_MOOD, section: 'build' },
    });
    for (const id of PREDICTIVE_IDS) expect(after).toContain(id);
  });

  it('never asks anything MOOD_QUESTIONS does not define', () => {
    const ids = selectQuestionIds({ callIndex: 0, input: EXAMPLE_INPUT, previous: null });
    for (const id of ids) expect(MOOD_QUESTIONS).toHaveProperty(id);
  });

  it('asks everything when the music is building on an even call', () => {
    // The worst case is still the whole set: two-tiering saves tokens on the
    // calls in between, not on the one that matters.
    const ids = selectQuestionIds({ callIndex: 0, input: EXAMPLE_INPUT, previous: null });
    expect(ids.length).toBe(Object.keys(MOOD_QUESTIONS).length);
  });
});

describe('questionsFor', () => {
  it('hands back exactly the questions named, in the canonical order', () => {
    const picked = questionsFor(['motion', 'valence']);
    expect(Object.keys(picked)).toEqual(['valence', 'motion']);
    expect(picked['valence']).toBe(MOOD_QUESTIONS['valence']);
  });

  it('ignores names it does not know', () => {
    expect(Object.keys(questionsFor(['valence', 'nonsense']))).toEqual(['valence']);
  });

  it('falls back to the whole set rather than asking nothing', () => {
    expect(questionsFor([])).toBe(MOOD_QUESTIONS);
    expect(questionsFor(['nonsense'])).toBe(MOOD_QUESTIONS);
  });
});

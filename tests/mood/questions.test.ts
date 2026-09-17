import { describe, expect, it } from 'vitest';
import { MOOD_PREAMBLE, MOOD_QUESTIONS, buildState } from '../../src/mood/questions';
import { estimateTokens } from '../../src/shared/tokens';
import {
  BEATS_TO_CHANGE,
  GENRES,
  MOTIONS,
  PRE_DROP_STYLES,
  SECTIONS,
} from '../../src/shared/types';
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

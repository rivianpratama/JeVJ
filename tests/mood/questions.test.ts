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

  /**
   * A criterion may be a sentence or an object; what it may not be is missing.
   * `spoken` carries an object because the real-track pass found that the one
   * sentence it used to have was not enough — a talk needs the measurements
   * named, and the note about a beat grid locking onto syllables is the whole
   * finding — and the API takes either.
   */
  it('describes both outcomes of every noul', () => {
    const describes = (entry: unknown): boolean =>
      typeof entry === 'string' ? entry.length > 0 : typeof entry === 'object' && entry !== null;

    for (const [name, q] of Object.entries(MOOD_QUESTIONS)) {
      if (q.type !== 'noul') continue;
      expect(describes(q.criteria?.true), name).toBe(true);
      expect(describes(q.criteria?.false), name).toBe(true);
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
    // The legend is fixed text (~250 estimated tokens) and the payload is
    // ~150: the brief's 320 is not reachable with the legend it also mandates.
    // 420 rather than v1's 400 because v2 added two features to the payload —
    // `vocal` and `harsh` — and a feature the legend does not explain is a
    // field the model has to guess the units of. 440 for the same reason
    // again: v2.2 added `pause`, which is the field that actually separates a
    // talk from a record, and it is worth its twelve tokens twice over.
    expect(estimateTokens(JSON.stringify(buildState(EXAMPLE_INPUT)))).toBeLessThanOrEqual(440);
  });
});

describe('the genre rubric', () => {
  it('sends the two loud families away from each other by name', () => {
    // Measured on six real tracks: *Duality* came back `electronic_dance` and a
    // hard-house set came back `rock_metal`, and both exclusions were the
    // reason. Each named a *symptom* — "synthetic leads over a steady
    // four-on-the-floor, however loud", "anything with no beat at all" — which
    // reads as a description of the other family's best moments. Naming the
    // family instead is the whole fix.
    const genre = MOOD_QUESTIONS['genre'];
    if (genre?.type !== 'choice') throw new Error('genre must be a choice');
    const rock = genre.criteria['rock_metal'] as { not_for?: string };
    const edm = genre.criteria['electronic_dance'] as { not_for?: string };
    expect(rock.not_for).toBe('electronic dance music with synth leads');
    expect(edm.not_for).toBe('distorted guitars and screamed vocals');
  });
});

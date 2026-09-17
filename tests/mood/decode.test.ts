import { describe, expect, it } from 'vitest';
import { decodeAnswers } from '../../src/mood/decode';
import { NEUTRAL_MOOD, validateMoodVector } from '../../src/shared/moodSchema';
import { GENRES } from '../../src/shared/types';
import type { MoodVector } from '../../src/shared/types';
import { exampleAnswers } from '../helpers/moodFixture';

describe('decodeAnswers', () => {
  it('normalizes scores by the number of gaps between levels', () => {
    const m = decodeAnswers(exampleAnswers());
    expect(m.valence).toBeCloseTo(3 / 4, 10);
    expect(m.arousal).toBeCloseTo(4 / 4, 10);
    expect(m.warmth).toBeCloseTo(1 / 4, 10);
    expect(m.impact).toBeCloseTo(3 / 4, 10);
  });

  it('passes nouls through as probabilities', () => {
    const m = decodeAnswers(exampleAnswers());
    expect(m.aggression).toBe(0.2);
    expect(m.melancholy).toBe(0.65);
    expect(m.euphoricPeak).toBe(0.05);
    expect(m.dropImminent).toBe(0.72);
  });

  it('takes the chosen label and coerces the probability map onto the const array', () => {
    const m = decodeAnswers(exampleAnswers());
    expect(m.genre).toBe('electronic_dance');
    expect(m.section).toBe('build');
    expect(m.motion).toBe('pulse');
    expect(m.beatsToChange).toBe('8');
    expect(m.preDropStyle).toBe('riser');

    for (const g of GENRES) expect(typeof m.genreP[g]).toBe('number');
    expect(m.genreP['classical']).toBe(0);
    const total = GENRES.reduce((s, g) => s + m.genreP[g], 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('renormalizes a probability map whose labels are partly unknown', () => {
    const answers = exampleAnswers();
    answers['motion'] = {
      type: 'choice',
      choice: 'bloom',
      confidence: 0.5,
      // 'kaleidoscope' is not one of ours: it must drop out and the rest scale up.
      probabilities: { bloom: 0.3, drift: 0.2, kaleidoscope: 0.5 },
    };
    const m = decodeAnswers(answers);
    expect(m.motion).toBe('bloom');
    expect(m.motionP['bloom']).toBeCloseTo(0.6, 10);
    expect(m.motionP['drift']).toBeCloseTo(0.4, 10);
    expect(m.motionP['shatter']).toBe(0);
  });

  it('averages the score and choice confidences and ignores the nouls', () => {
    const m = decodeAnswers(exampleAnswers());
    const scores = [0.8, 0.6, 0.5, 0.9, 0.7, 0.4, 0.6];
    const choices = [0.9, 0.6, 0.5, 0.4, 0.8];
    const all = [...scores, ...choices];
    expect(m.confidence).toBeCloseTo(all.reduce((a, b) => a + b, 0) / all.length, 10);
  });

  it('produces a vector the schema accepts', () => {
    expect(validateMoodVector(decodeAnswers(exampleAnswers())).ok).toBe(true);
  });

  it('falls back to the neutral value for a missing or malformed answer', () => {
    const answers = exampleAnswers();
    delete answers['valence'];
    answers['genre'] = { type: 'choice', choice: 'reggaeton', confidence: 0.5, probabilities: {} };
    const m = decodeAnswers(answers);
    expect(m.valence).toBe(0.5);
    expect(GENRES).toContain(m.genre);
    expect(validateMoodVector(m).ok).toBe(true);
  });
});

describe('decodeAnswers with the last vector behind it', () => {
  /** What Jev said last time: nothing like the neutral mood in any field. */
  const PREVIOUS: MoodVector = {
    ...NEUTRAL_MOOD,
    valence: 0.9,
    aggression: 0.8,
    melancholy: 0.75,
    hypnotic: 0.7,
    euphoricPeak: 0.6,
    genre: 'rock_metal',
    dropImminent: 0.9,
    beatsToChange: '8',
    impact: 0.85,
    preDropStyle: 'riser',
  };

  /** The core ten, which every call asks. */
  function coreOnly(): Record<string, unknown> {
    const all = exampleAnswers();
    const out: Record<string, unknown> = {};
    for (const id of ['valence', 'arousal', 'tension', 'warmth', 'synthetic', 'space', 'spoken', 'genre', 'section', 'motion']) {
      out[id] = all[id];
    }
    return out;
  }

  it('answers what it was asked, whatever came before', () => {
    const m = decodeAnswers(coreOnly(), PREVIOUS);
    expect(m.valence).toBeCloseTo(3 / 4, 10);
    expect(m.genre).toBe('electronic_dance');
  });

  it('keeps the last answer for a question this call did not ask', () => {
    const m = decodeAnswers(coreOnly(), PREVIOUS);
    expect(m.aggression).toBe(0.8);
    expect(m.melancholy).toBe(0.75);
    expect(m.hypnotic).toBe(0.7);
    expect(m.euphoricPeak).toBe(0.6);
  });

  it('withdraws a prediction that was not restated', () => {
    const m = decodeAnswers(coreOnly(), PREVIOUS);
    expect(m.dropImminent).toBe(NEUTRAL_MOOD.dropImminent);
    expect(m.beatsToChange).toBe('none');
    expect(m.impact).toBe(NEUTRAL_MOOD.impact);
    expect(m.preDropStyle).toBe('none');
  });

  it('takes a prediction it did ask about', () => {
    const m = decodeAnswers(exampleAnswers(), PREVIOUS);
    expect(m.dropImminent).toBe(0.72);
    expect(m.beatsToChange).toBe('8');
    expect(m.impact).toBeCloseTo(3 / 4, 10);
    expect(m.preDropStyle).toBe('riser');
  });

  it('still produces a vector the schema accepts', () => {
    expect(validateMoodVector(decodeAnswers(coreOnly(), PREVIOUS)).ok).toBe(true);
    expect(validateMoodVector(decodeAnswers({}, PREVIOUS)).ok).toBe(true);
  });

  it('falls back to neutral when there is no previous vector', () => {
    const m = decodeAnswers(coreOnly(), null);
    expect(m.aggression).toBe(NEUTRAL_MOOD.aggression);
  });
});

import { describe, expect, it } from 'vitest';
import type { Genre, MoodInput } from '../../src/shared/types';
import { NEUTRAL_MOOD, validateMoodInput, validateMoodVector } from '../../src/shared/moodSchema';

function validInput(): MoodInput {
  return {
    pos: '1:32/4:10',
    bpm: 128,
    tempo: 'allegro',
    beatConf: 0.9,
    meter: 'duple',
    sync: 0.2,
    regular: 0.8,
    key: 'F#',
    mode: 'minor',
    modeConf: 0.7,
    modal: 'aeolian',
    consonance: 0.6,
    loud: 'mf',
    range: 0.4,
    trend: 'building',
    crest: 0.5,
    bright: 0.55,
    noise: 0.3,
    attack: 'sharp',
    sub: 0.25,
    bands: [3, 5, 7, 6, 4, 4, 2, 1],
    speech: 0.05,
    vocal: 0.2,
    harsh: 0.45,
    onsetsPerSec: 4.2,
    slope4: 1.5,
    slope8: -2.25,
    onsetRatio: 1.4,
    centroidSlope: 0.15,
    gap: false,
    barsSinceChange: 6,
    barInPhrase: 2,
  };
}

describe('validateMoodInput', () => {
  it('accepts a fully valid MoodInput', () => {
    const r = validateMoodInput(validInput());
    expect(r.ok).toBe(true);
  });

  it('rejects bands with 7 entries', () => {
    const r = validateMoodInput({ ...validInput(), bands: [3, 5, 7, 6, 4, 4, 2] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('bands');
  });

  it("rejects tempo 'fast'", () => {
    const r = validateMoodInput({ ...validInput(), tempo: 'fast' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('tempo');
  });

  it("accepts pos '1:32/live'", () => {
    const r = validateMoodInput({ ...validInput(), pos: '1:32/live' });
    expect(r.ok).toBe(true);
  });

  // The reference payload from docs/superpowers/plans/2026-09-17-jevj-visualizer.md;
  // Task 2's summarizer must produce snapshots that validate.
  it('accepts the reference payload from the plan', () => {
    const reference = JSON.parse(
      '{"pos":"1:32/4:05","bpm":128,"tempo":"allegro","beatConf":0.9,"meter":"duple","sync":0.3,"regular":0.9,"key":"F#","mode":"minor","modeConf":0.7,"modal":"aeolian","consonance":0.6,"loud":"f","range":0.2,"trend":"building","crest":0.3,"bright":0.7,"noise":0.4,"attack":"sharp","sub":0.8,"bands":[9,8,6,5,5,6,7,5],"speech":0.05,"vocal":0.2,"harsh":0.45,"onsetsPerSec":4.2,"slope4":3.5,"slope8":6.1,"onsetRatio":2.1,"centroidSlope":0.4,"gap":false,"barsSinceChange":14,"barInPhrase":14}',
    ) as unknown;
    const r = validateMoodInput(reference);
    expect(r.ok).toBe(true);
  });

  it("rejects pos '92s'", () => {
    const r = validateMoodInput({ ...validInput(), pos: '92s' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('pos');
  });
});

describe('validateMoodVector', () => {
  it('accepts NEUTRAL_MOOD', () => {
    const r = validateMoodVector(NEUTRAL_MOOD);
    expect(r.ok).toBe(true);
  });

  it('rejects a MoodVector whose genreP is missing a genre', () => {
    const missing: Genre = 'folk_acoustic';
    const genreP: Record<string, number> = { ...NEUTRAL_MOOD.genreP };
    delete genreP[missing];
    const r = validateMoodVector({ ...NEUTRAL_MOOD, genreP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('genreP');
  });
});

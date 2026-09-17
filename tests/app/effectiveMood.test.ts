import { describe, expect, it } from 'vitest';
import { mergeMood } from '../../src/app/effectiveMood';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import type { MoodVector } from '../../src/shared/types';

function mood(over: Partial<MoodVector> = {}): MoodVector {
  return { ...NEUTRAL_MOOD, ...over };
}

describe('mergeMood', () => {
  it('writes the live mood through when the timeline says nothing', () => {
    const out = mood();
    expect(mergeMood(out, mood({ valence: 0.9, genre: 'jazz' }), {})).toBe('live');
    expect(out.valence).toBe(0.9);
    expect(out.genre).toBe('jazz');
  });

  it('lets the timeline win where it has an answer, and only there', () => {
    // The timeline's cues are latency-compensated and, for a dropped file,
    // come from a pass that knew what was coming; the live mood stands
    // everywhere it is silent.
    const out = mood();
    const src = mergeMood(out, mood({ valence: 0.9, arousal: 0.1, genre: 'jazz' }), {
      arousal: 0.8,
    });
    expect(src).toBe('timeline');
    expect(out.arousal).toBe(0.8);
    expect(out.valence).toBe(0.9);
    expect(out.genre).toBe('jazz');
  });

  it('treats an explicit undefined as no answer at all', () => {
    const out = mood();
    const src = mergeMood(out, mood({ arousal: 0.1 }), { arousal: undefined });
    expect(src).toBe('live');
    expect(out.arousal).toBe(0.1);
  });

  it('writes into the object it was given rather than allocating', () => {
    const out = mood();
    expect(mergeMood(out, mood({ tension: 0.4 }), {})).toBe('live');
    const again = out;
    mergeMood(out, mood({ tension: 0.7 }), {});
    expect(out).toBe(again);
    expect(out.tension).toBe(0.7);
  });
});

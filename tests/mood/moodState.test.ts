import { describe, expect, it } from 'vitest';
import { MoodState } from '../../src/mood/moodState';
import { NEUTRAL_MOOD, validateMoodVector } from '../../src/shared/moodSchema';
import { MOTIONS, type Motion, type MoodVector } from '../../src/shared/types';

function motionP(over: Partial<Record<Motion, number>>): Record<Motion, number> {
  const out = {} as Record<Motion, number>;
  for (const m of MOTIONS) out[m] = over[m] ?? 0;
  return out;
}

function vector(over: Partial<MoodVector>): MoodVector {
  return { ...NEUTRAL_MOOD, ...over };
}

describe('MoodState', () => {
  it('starts at whatever it was given and holds there', () => {
    const s = new MoodState(vector({ valence: 0 }));
    expect(s.current().valence).toBe(0);
    expect(s.tick(5).valence).toBe(0);
  });

  it('slews a score with a 1.5 s time constant', () => {
    const s = new MoodState(vector({ valence: 0 }));
    s.setTarget(vector({ valence: 1 }), 0);

    expect(s.tick(1.5).valence).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(s.tick(4.5).valence).toBeGreaterThan(0.9);
    expect(s.tick(4.5).valence).toBeCloseTo(1 - Math.exp(-3), 6);
  });

  it('slews a noul with a 1 s time constant', () => {
    const s = new MoodState(vector({ melancholy: 0 }));
    s.setTarget(vector({ melancholy: 1 }), 0);
    expect(s.tick(1).melancholy).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('moves the fast fields with a 0.4 s time constant', () => {
    const s = new MoodState(vector({ dropImminent: 0, impact: 0, euphoricPeak: 0 }));
    s.setTarget(vector({ dropImminent: 1, impact: 1, euphoricPeak: 1 }), 0);

    const m = s.tick(0.4);
    expect(m.dropImminent).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(m.impact).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(m.euphoricPeak).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('flips a choice only once the slewed probability overtakes', () => {
    const s = new MoodState(vector({ motion: 'flow', motionP: motionP({ flow: 0.6, pulse: 0.4 }) }));
    s.setTarget(vector({ motion: 'pulse', motionP: motionP({ flow: 0.1, pulse: 0.9 }) }), 0);

    // They cross at 1.5·ln(1/0.8) ≈ 0.335 s.
    expect(s.tick(0.2).motion).toBe('flow');
    expect(s.tick(0.5).motion).toBe('pulse');
    const m = s.tick(0.5);
    expect(m.motionP['pulse']).toBeGreaterThan(m.motionP['flow']);
    expect(MOTIONS.reduce((a, k) => a + m.motionP[k], 0)).toBeCloseTo(1, 6);
  });

  it('snaps the labels that have no probabilities to slew', () => {
    const s = new MoodState(vector({ beatsToChange: 'none', preDropStyle: 'none' }));
    s.setTarget(vector({ beatsToChange: '4', preDropStyle: 'riser' }), 0);
    expect(s.tick(0.01).beatsToChange).toBe('4');
    expect(s.tick(0.01).preDropStyle).toBe('riser');
  });

  it('holds through a backwards clock and resumes from the new one', () => {
    const s = new MoodState(vector({ valence: 0 }));
    s.setTarget(vector({ valence: 1 }), 10);

    expect(s.tick(10).valence).toBe(0);
    // A seek: time is not negative, it is a different place in the track.
    expect(s.tick(9).valence).toBe(0);
    expect(s.tick(9).valence).toBe(0);
    expect(s.tick(10.5).valence).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(s.tick(1e6).valence).toBeLessThanOrEqual(1);
    expect(s.tick(1e6).valence).toBeCloseTo(1, 6);
  });

  it('always reports a vector the schema accepts', () => {
    const s = new MoodState();
    s.setTarget(vector({ valence: 1, genre: 'jazz' }), 0);
    expect(validateMoodVector(s.tick(2)).ok).toBe(true);
    expect(validateMoodVector(s.current()).ok).toBe(true);
  });
});

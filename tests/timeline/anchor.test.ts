import { describe, expect, it } from 'vitest';

import { steepestStep } from '../../src/timeline/anchor';
import type { FrameFeatures } from '../../src/shared/types';

/** Frames every 10 ms with a loudness given by `dbAt`. */
function frames(seconds: number, dbAt: (t: number) => number): FrameFeatures[] {
  const out: FrameFeatures[] = [];
  for (let t = 0; t < seconds; t += 0.01) {
    out.push({ t, db: dbAt(t) } as FrameFeatures);
  }
  return out;
}

describe('steepestStep', () => {
  it('finds a slam one and a half seconds before the summarizer noticed it', () => {
    const f = frames(20, (t) => (t < 10 ? -30 : -10));
    expect(steepestStep(f, 11.5, 'rise')).toBeCloseTo(10, 1);
    expect(steepestStep(f, 11.5, 'either')).toBeCloseTo(10, 1);
  });

  it('finds a fall, and not a rise, when asked for one', () => {
    const f = frames(20, (t) => (t < 10 ? -10 : -30));
    expect(steepestStep(f, 11, 'fall')).toBeCloseTo(10, 1);
    expect(steepestStep(f, 11, 'rise')).toBeUndefined();
  });

  it('hears nothing in music that is merely breathing', () => {
    const f = frames(20, (t) => -20 + Math.sin(t * 4));
    expect(steepestStep(f, 10, 'either')).toBeUndefined();
  });

  it('looks no further back than the window', () => {
    const f = frames(20, (t) => (t < 5 ? -30 : -10));
    expect(steepestStep(f, 10, 'rise')).toBeUndefined();
  });
});

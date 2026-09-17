import { describe, expect, it } from 'vitest';

import { featherWeights } from '../../src/ui/card';

/** The falloff, sampled finely enough that a kink cannot hide between points. */
const STEP = 0.001;
function profile(from = 0, to = 1.2): { d: number; total: number; blurred: number }[] {
  const out: { d: number; total: number; blurred: number }[] = [];
  for (let d = from; d <= to + 1e-9; d += STEP) {
    const w = featherWeights(d);
    out.push({ d, total: w.sharp + w.blurred, blurred: w.blurred });
  }
  return out;
}

describe('featherWeights', () => {
  it('is the whole picture in the middle and nothing at the rim', () => {
    const middle = featherWeights(0);
    expect(middle.sharp).toBe(1);
    expect(middle.blurred).toBe(0);

    for (const d of [1, 1.05, 2 ** 0.25, 3]) {
      const out = featherWeights(d);
      expect(out.sharp).toBe(0);
      expect(out.blurred).toBe(0);
    }
  });

  /*
   * The point of the whole two-layer arrangement. A falloff with a step in it
   * is an edge; so is a falloff with a step in its *slope*, which is what the
   * single gradient this replaced had where it started and where it stopped.
   */
  it('loses alpha without a step in it', () => {
    const samples = profile();
    let worst = 0;
    for (let i = 1; i < samples.length; i++) {
      worst = Math.max(worst, Math.abs(samples[i]!.total - samples[i - 1]!.total));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('loses alpha without a step in the slope either', () => {
    const samples = profile();
    const slope = (i: number): number => (samples[i]!.total - samples[i - 1]!.total) / STEP;
    let worst = 0;
    for (let i = 2; i < samples.length; i++) {
      worst = Math.max(worst, Math.abs(slope(i) - slope(i - 1)));
    }
    // A C¹ curve's slope moves by its curvature times the step; a corner in it
    // would move by the difference between two slopes, which here is ~3.3.
    expect(worst).toBeLessThan(0.05);
  });

  it('never gives alpha back on the way out', () => {
    const samples = profile();
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.total).toBeLessThanOrEqual(samples[i - 1]!.total + 1e-12);
    }
  });

  it('hands the picture over to the blur before letting go of it', () => {
    const samples = profile();
    const peak = samples.reduce((a, b) => (b.blurred > a.blurred ? b : a));
    expect(peak.d).toBeGreaterThan(0.5);
    expect(peak.d).toBeLessThan(0.8);
    // Out where the sharp layer is gone, the blurred one is all there is.
    expect(featherWeights(0.75).sharp).toBe(0);
    expect(featherWeights(0.75).blurred).toBeGreaterThan(0.4);
  });

  it('keeps both weights on the near side of one', () => {
    for (const { total, blurred } of profile(-0.5, 2)) {
      expect(total).toBeGreaterThanOrEqual(0);
      expect(total).toBeLessThanOrEqual(1);
      expect(blurred).toBeGreaterThanOrEqual(0);
    }
  });
});

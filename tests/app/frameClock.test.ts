import { describe, expect, it } from 'vitest';
import { createFrameClock } from '../../src/app/frameClock';

const FRAME = 1 / 60;

describe('createFrameClock', () => {
  it('follows the audio clock while it is advancing', () => {
    const c = createFrameClock();
    c.advance(10, 100);
    const a = c.advance(10 + FRAME, 100 + FRAME);
    expect(a.step).toBeCloseTo(FRAME, 9);
    const b = c.advance(10 + 2 * FRAME, 100 + 2 * FRAME);
    expect(b.time - a.time).toBeCloseTo(FRAME, 9);
  });

  it('keeps moving when the analysis snapshot repeats', () => {
    // The visuals draw once per display frame; the analyser only produces a
    // new snapshot when it has one. A repeated snapshot means dt 0, and a
    // frozen `uTime` means the ink stops marbling and the grain stops moving
    // while the music plays on.
    const c = createFrameClock();
    c.advance(10, 100);
    const a = c.advance(10, 100 + FRAME);
    const b = c.advance(10, 100 + 2 * FRAME);
    expect(a.step).toBeCloseTo(FRAME, 9);
    expect(b.time).toBeGreaterThan(a.time);
    expect(b.time - a.time).toBeCloseTo(FRAME, 9);
  });

  it('falls back to the wall clock across a seek', () => {
    const c = createFrameClock();
    c.advance(10, 100);
    const back = c.advance(2, 100 + FRAME); // seeked backwards
    expect(back.step).toBeCloseTo(FRAME, 9);
    const forward = c.advance(180, 100 + 2 * FRAME); // seeked far forward
    expect(forward.step).toBeCloseTo(FRAME, 9);
    expect(forward.time).toBeGreaterThan(back.time);
  });

  it('never hands out a zero, negative or absurd step', () => {
    const c = createFrameClock();
    let last = -1;
    for (const [audio, wall] of [
      [0, 0],
      [0, 0],
      [5, 0],
      [5, 900],
      [Number.NaN, 901],
      [6, 901 + FRAME],
    ] as [number, number][]) {
      const r = c.advance(audio, wall);
      expect(r.step).toBeGreaterThan(0);
      expect(r.step).toBeLessThanOrEqual(1);
      expect(r.time).toBeGreaterThan(last);
      last = r.time;
    }
  });
});

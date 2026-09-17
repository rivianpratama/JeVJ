import { describe, expect, it } from 'vitest';
import { MIN_DRAW_WEIGHT, drawsAtWeight } from '../../src/visuals/renderer';

describe('drawsAtWeight', () => {
  it('skips a layer that cannot be seen', () => {
    // Below one part in a hundred a layer is under a single code value after
    // tone mapping, and it costs a full pass — for the particles, a quarter of
    // a million points — to contribute nothing.
    expect(drawsAtWeight(0)).toBe(false);
    expect(drawsAtWeight(0.009)).toBe(false);
    expect(drawsAtWeight(MIN_DRAW_WEIGHT)).toBe(true);
    expect(drawsAtWeight(0.5)).toBe(true);
    expect(drawsAtWeight(1)).toBe(true);
  });

  it('treats a missing or nonsense weight as nothing to draw', () => {
    expect(drawsAtWeight(Number.NaN)).toBe(false);
    expect(drawsAtWeight(-1)).toBe(false);
  });
});

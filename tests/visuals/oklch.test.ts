import { describe, expect, it } from 'vitest';
import { oklchToRgb } from '../../src/visuals/oklch';

describe('oklchToRgb', () => {
  it('turns zero chroma into a neutral gray', () => {
    const [r, g, b] = oklchToRgb(0.9, 0, 0);
    expect(Math.abs(r - g)).toBeLessThan(0.02);
    expect(Math.abs(g - b)).toBeLessThan(0.02);
    // Light, not white.
    expect(r).toBeGreaterThan(0.7);
    expect(r).toBeLessThan(1);
  });

  it('puts hue 30 on the red side', () => {
    const [r, , b] = oklchToRgb(0.6, 0.2, 30);
    expect(r).toBeGreaterThan(b);
  });

  it('puts hue 265 on the blue side', () => {
    const [r, , b] = oklchToRgb(0.45, 0.15, 265);
    expect(b).toBeGreaterThan(r);
  });

  it('clips an out-of-gamut request back inside 0..1', () => {
    for (const h of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const rgb = oklchToRgb(0.6, 0.9, h);
      for (const c of rgb) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the hue of an out-of-gamut request by reducing chroma, not clamping channels', () => {
    // A wildly over-saturated blue must still read blue rather than saturating
    // to white or to a clamped magenta.
    const [r, g, b] = oklchToRgb(0.5, 0.8, 265);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
});

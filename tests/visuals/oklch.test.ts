import { describe, expect, it } from 'vitest';
import { oklchToLinearRgb, oklchToRgb } from '../../src/visuals/oklch';

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

/** The sRGB transfer function, so the two converters can be held against each other. */
function encodeSrgb(x: number): number {
  const v = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function rec709(rgb: [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

describe('oklchToLinearRgb', () => {
  it('is the same color as oklchToRgb, one transfer function earlier', () => {
    for (const h of [0, 90, 200, 330]) {
      const linear = oklchToLinearRgb(0.6, 0.12, h);
      const encoded = oklchToRgb(0.6, 0.12, h);
      for (let i = 0; i < 3; i++) expect(encodeSrgb(linear[i]!)).toBeCloseTo(encoded[i]!, 6);
    }
  });

  it('puts a neutral at L³ relative luminance, which is what "linear" has to mean', () => {
    // Oklab's L is the cube root of relative luminance for a gray, so a stop
    // asked for at L = 0.45 must arrive at the GPU as Y ≈ 0.091 — not as the
    // 0.33 the gamma-encoded value would carry.
    for (const L of [0.25, 0.45, 0.68]) {
      expect(rec709(oklchToLinearRgb(L, 0, 0))).toBeCloseTo(L ** 3, 4);
    }
  });

  it('clips an out-of-gamut request by chroma, keeping the hue', () => {
    const [r, g, b] = oklchToLinearRgb(0.5, 0.8, 265);
    for (const c of [r, g, b]) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
});

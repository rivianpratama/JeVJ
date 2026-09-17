import { describe, expect, it } from 'vitest';
import { paletteFor } from '../../src/visuals/palette';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import type { Genre, MoodVector } from '../../src/shared/types';

function mood(over: Partial<MoodVector>): MoodVector {
  return { ...NEUTRAL_MOOD, ...over };
}

/** max − min channel: how far from gray a color is. */
function sat(rgb: [number, number, number]): number {
  return Math.max(...rgb) - Math.min(...rgb);
}

function forGenre(g: Genre, over: Partial<MoodVector> = {}) {
  return paletteFor(mood({ genre: g, ...over }));
}

describe('paletteFor', () => {
  it('gives five stops, a background and an accent', () => {
    const p = paletteFor(mood({}));
    expect(p.stops).toHaveLength(5);
    for (const stop of p.stops) {
      expect(stop).toHaveLength(3);
      for (const c of stop) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
    expect(p.bg).toHaveLength(3);
    expect(p.accent).toHaveLength(3);
  });

  it('runs dark to light across the stops', () => {
    const p = paletteFor(mood({}));
    const luma = p.stops.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
    for (let i = 1; i < luma.length; i++) expect(luma[i]!).toBeGreaterThan(luma[i - 1]!);
  });

  it('is blue-dominant when cold and red-dominant when warm', () => {
    const cold = paletteFor(mood({ warmth: 0 })).stops[2]!;
    const warm = paletteFor(mood({ warmth: 1 })).stops[2]!;
    expect(cold[2]).toBeGreaterThan(cold[0]);
    expect(warm[0]).toBeGreaterThan(warm[2]);
  });

  it('desaturates with melancholy', () => {
    const bright = paletteFor(mood({ melancholy: 0 })).stops[2]!;
    const sad = paletteFor(mood({ melancholy: 1 })).stops[2]!;
    expect(sat(sad)).toBeLessThan(sat(bright));
  });

  it('raises chroma with valence', () => {
    const dull = paletteFor(mood({ valence: 0 })).stops[2]!;
    const vivid = paletteFor(mood({ valence: 1 })).stops[2]!;
    expect(sat(vivid)).toBeGreaterThan(sat(dull));
  });

  it('keeps the background darker than the darkest stop', () => {
    const p = paletteFor(mood({}));
    const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    expect(lum(p.bg)).toBeLessThan(lum(p.stops[0]!));
  });

  describe('genre nudges', () => {
    it('makes classical paler and less saturated than pop', () => {
      const pop = forGenre('pop').stops[2]!;
      const classical = forGenre('classical').stops[2]!;
      expect(sat(classical)).toBeLessThan(sat(pop));
      const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      expect(lum(classical)).toBeGreaterThan(lum(pop));
    });

    it('makes electronic_dance more saturated and ambient_drone less', () => {
      const pop = sat(forGenre('pop').stops[2]!);
      expect(sat(forGenre('electronic_dance').stops[2]!)).toBeGreaterThan(pop);
      expect(sat(forGenre('ambient_drone').stops[2]!)).toBeLessThan(pop);
    });

    it('darkens rock_metal and pulls it toward red', () => {
      const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const pop = forGenre('pop', { warmth: 0.5 }).stops[2]!;
      const rock = forGenre('rock_metal', { warmth: 0.5 }).stops[2]!;
      expect(lum(rock)).toBeLessThan(lum(pop));
      expect(rock[0] - rock[2]).toBeGreaterThan(pop[0] - pop[2]);
    });
  });

  it('spreads the stop hues apart as tension rises', () => {
    // Measured as an actual hue angle, so the lightness ramp across the stops
    // — which is the same either way — cannot account for the difference.
    const hueOf = ([r, g, b]: [number, number, number]): number => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const c = max - min;
      if (c === 0) return 0;
      const h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
      return (h * 60 + 360) % 360;
    };
    const spread = (p: { stops: [number, number, number][] }): number => {
      const d = Math.abs(hueOf(p.stops[1]!) - hueOf(p.stops[3]!));
      return Math.min(d, 360 - d);
    };
    expect(spread(paletteFor(mood({ tension: 1 })))).toBeGreaterThan(spread(paletteFor(mood({ tension: 0 }))) + 10);
  });
});

/** Rec.709 relative luminance — meaningful only because the stops are linear. */
function lum(rgb: [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

describe('paletteFor is linear-light', () => {
  it('hands the GPU linear RGB, not gamma-encoded sRGB', () => {
    // The mid stop is asked for at Oklab L ≈ 0.45, which is a relative
    // luminance of ~0.09. The gamma-encoded value of the same color is ~0.33:
    // uploading that into a linear chain that encodes again at the OutputPass
    // is what made every mid tone read three stops too bright.
    expect(lum(paletteFor(mood({})).stops[2]!)).toBeCloseTo(0.09, 2);
  });

  it('keeps the background below the darkest stop in linear light too', () => {
    const p = paletteFor(mood({}));
    expect(lum(p.bg)).toBeLessThan(lum(p.stops[0]!));
  });
});

describe('paletteFor hue interpolation', () => {
  it('takes the short way round at warmth 0.5 — magenta, never green', () => {
    // 265° → 35° the short way passes through magenta and crimson; the long
    // way passes through teal and chartreuse, which are colors the direction
    // never asks for. Green dominating the mid stop is the signature of the
    // long way round.
    const [r, g, b] = paletteFor(mood({ warmth: 0.5 })).stops[2]!;
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
  });
});

describe('paletteFor memoization', () => {
  it('hands back the same Palette when nothing it reads has moved', () => {
    const a = paletteFor(mood({ valence: 0.42 }));
    // A field the palette does not read must not invalidate it.
    const b = paletteFor(mood({ valence: 0.42, spoken: 0.9, impact: 1 }));
    expect(b).toBe(a);
  });

  it('rebuilds when a field it reads moves by more than 1e-4', () => {
    const a = paletteFor(mood({ tension: 0.3 }));
    expect(paletteFor(mood({ tension: 0.30005 }))).toBe(a);
    expect(paletteFor(mood({ tension: 0.4 }))).not.toBe(a);
  });

  it('rebuilds when the genre changes', () => {
    const a = paletteFor(mood({ genre: 'pop' }));
    expect(paletteFor(mood({ genre: 'rock_metal' }))).not.toBe(a);
  });
});

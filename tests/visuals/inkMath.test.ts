import { describe, expect, it } from 'vitest';
import { inkEquilibriumDensity, inkLevel } from '../../src/visuals/inkMath';
import {
  AMBIENT_RATE,
  INJECT_RATE,
  KNEE,
  VEIN_HI,
  VEIN_LO,
  idleAmbientLevels,
  mean,
  quantile,
} from '../helpers/inkField';

/** What the director hands the ink at idle: drift decay, arousal 0.3. */
const IDLE = {
  gain: 0.9,
  bands: [0.35, 0.35, 0.35] as [number, number, number],
  decay: 0.99,
};

describe('inkEquilibriumDensity', () => {
  it('is the rate divided by what a frame loses', () => {
    // One unit a second into a buffer that keeps 99% of itself each frame:
    // (1/60) added per frame against 1% lost, so it balances at 100 frames'
    // worth of injection.
    expect(inkEquilibriumDensity(1, 0.99)).toBeCloseTo(1 / 60 / 0.01, 9);
  });

  it('barely depends on the frame rate, and less the slower the decay', () => {
    // The whole reason injection is quoted as a rate and decay per reference
    // frame: the picture should be the same on a 120 Hz display as on a 60 Hz
    // one. It is the same to within a few percent rather than exactly, because
    // a per-frame multiply is a discretised exponential, and the residual
    // shrinks as the decay approaches 1 — which is the direction the ink
    // spends most of its time in.
    const spread = (decay: number): number =>
      inkEquilibriumDensity(1, decay, 1 / 120) / inkEquilibriumDensity(1, decay, 1 / 30);
    for (const decay of [0.93, 0.955, 0.99]) {
      expect(spread(decay)).toBeGreaterThan(0.94);
      expect(spread(decay)).toBeLessThan(1.06);
    }
    expect(1 - spread(0.99)).toBeLessThan(1 - spread(0.93));
  });

  it('never balances in a lossless buffer', () => {
    expect(inkEquilibriumDensity(1, 1)).toBe(Infinity);
    expect(inkEquilibriumDensity(1, 1.02)).toBe(Infinity);
  });

  it('holds much longer ink at a slower decay', () => {
    expect(inkEquilibriumDensity(1, 0.99)).toBeGreaterThan(4 * inkEquilibriumDensity(1, 0.955));
  });
});

describe('inkLevel', () => {
  it('starts at the darkest stop and approaches the lightest without clipping', () => {
    expect(inkLevel(0, KNEE)).toBe(0);
    expect(inkLevel(-1, KNEE)).toBe(0);
    expect(inkLevel(10, KNEE)).toBeLessThan(1);
    expect(inkLevel(10, KNEE)).toBeGreaterThan(0.99);
  });

  it('is monotone, which is what makes the ramp a ramp', () => {
    let last = -1;
    for (let d = 0; d <= 2; d += 0.05) {
      const v = inkLevel(d, KNEE);
      expect(v).toBeGreaterThan(last);
      last = v;
    }
  });
});

describe('the idle ambient field', () => {
  // These are the shipped shader constants, read out of the .glsl, so a tuning
  // pass cannot move one and leave this test asserting the old value.
  it('settles in the exposure window the direction asks for', () => {
    // A dark field with luminous marbling: the frame averages a quarter of the
    // way up the ramp, and the darkest fifth of it is genuinely dark rather
    // than a lifted floor. Both are properties of the *equilibrium*, not of
    // AMBIENT_RATE — the rate is derived from these, by
    // `inkEquilibriumDensity`, and not the other way round.
    const levels = idleAmbientLevels(IDLE, 64);
    expect(mean(levels)).toBeGreaterThanOrEqual(0.22);
    expect(mean(levels)).toBeLessThanOrEqual(0.32);
    expect(quantile(levels, 0.2)).toBeLessThan(0.08);
    // And the top of the frame reaches the stops the bloom is looking for,
    // before the beat lobes add anything at all.
    expect(quantile(levels, 0.95)).toBeGreaterThan(0.7);
  });

  it('is veined rather than flat, which is where the darks come from', () => {
    // The same rate without the vein gate is a plane: it lands near two thirds
    // of the way up the ramp with a spread of a few hundredths and no darks at
    // all, which on screen is a wash of pale lavender. The gate is what makes
    // the field a field.
    const veined = idleAmbientLevels(IDLE, 64);
    const flat = idleAmbientLevels(IDLE, 64, { vein: false });
    expect(mean(flat)).toBeGreaterThan(0.7);
    expect(quantile(flat, 0.95) - quantile(flat, 0.05)).toBeLessThan(0.2);
    expect(quantile(veined, 0.2)).toBeLessThan(0.01);
    expect(quantile(veined, 0.95) - quantile(veined, 0.05)).toBeGreaterThan(0.7);
  });

  it('keeps a dark floor once there is music, not a lifted one', () => {
    // A playing track uses a much faster decay, so the same rate settles far
    // lower and the beat lobes are what light the frame.
    const playing = idleAmbientLevels({ gain: 1.1, bands: [0.4, 0.4, 0.4], decay: 0.955 }, 64);
    expect(mean(playing)).toBeLessThan(0.18);
  });

  it('reads its constants from the shaders it is describing', () => {
    expect(AMBIENT_RATE).toBeGreaterThan(0);
    expect(INJECT_RATE).toBeGreaterThan(0);
    expect(KNEE).toBeGreaterThan(0);
    expect(VEIN_LO).toBeLessThan(VEIN_HI);
  });
});

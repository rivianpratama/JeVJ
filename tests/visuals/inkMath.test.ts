import { describe, expect, it } from 'vitest';
import {
  AMBIENT_LEVEL,
  DRIFT_DECAY,
  ambientInjectPerFrame,
  inkEquilibriumDensity,
  inkLevel,
  smokeLevel,
} from '../../src/visuals/inkMath';
import {
  CARD_FLOOR,
  FALLOFF,
  INJECT_RATE,
  KNEE,
  STRIATE_AMP,
  STRIATE_MEAN,
  VEIN_HI,
  VEIN_LO,
  idleAmbientLevels,
  mean,
  quantile,
  shaderConst,
} from '../helpers/smokeField';
import smokeFeedbackFrag from '../../src/visuals/shaders/smoke_feedback.frag.glsl?raw';

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
    // Smoke on black: two thirds of the frame dark, the rest a long gradient
    // with luminous sheets at the top of it. All three are properties of the
    // *equilibrium*, not of an injection rate — the rate is derived from these,
    // by `inkEquilibriumDensity`, and not the other way round.
    //
    // The window moved for v2 (it was 0.22–0.32 / < 0.08 / > 0.7), and it moved
    // down: the reference images are darker than the v1 look, and the direction
    // states the new numbers.
    const levels = idleAmbientLevels(IDLE, 64);
    expect(mean(levels)).toBeGreaterThanOrEqual(0.19);
    expect(mean(levels)).toBeLessThanOrEqual(0.27);
    expect(quantile(levels, 0.2)).toBeLessThan(0.06);
    // And the top of the frame reaches the stops the bloom is looking for,
    // before a single lobe or filament adds anything at all.
    expect(quantile(levels, 0.95)).toBeGreaterThan(0.55);
  });

  it('leaves the card in a pool of dark and puts the smoke outside it', () => {
    // The v2 requirement the whole annulus exists for: the frame outside the
    // card carries the picture and the card's own square is the darkest part of
    // it. Measured as the direction specifies — the mean outside against the
    // mean inside — with a wide margin, because the advection this model
    // ignores carries smoke *inward* as well as out.
    const inside = mean(idleAmbientLevels(IDLE, 64, { region: 'inside' }));
    const outside = mean(idleAmbientLevels(IDLE, 64, { region: 'outside' }));
    expect(outside).toBeGreaterThan(1.5 * inside);
    // And it is the gate that does it, not an accident of where the noise fell.
    const flat = idleAmbientLevels(IDLE, 64, { card: false });
    expect(mean(idleAmbientLevels(IDLE, 64, { card: false, region: 'inside' }))).toBeGreaterThan(
      1.5 * inside,
    );
    expect(mean(flat)).toBeGreaterThan(mean(idleAmbientLevels(IDLE, 64)));
    expect(CARD_FLOOR).toBeLessThan(0.5);
  });

  it('is veined rather than flat, which is where the darks come from', () => {
    // The same level without the vein gate is a plane: it lands near the top of
    // the ramp with a spread of a few hundredths and no darks at all, which on
    // screen is a wash of pale lavender. The gate is what makes the field a
    // field. Compared against a flat field with the card gate off too, so the
    // only difference between the two is the vein.
    const veined = idleAmbientLevels(IDLE, 64);
    const flat = idleAmbientLevels(IDLE, 64, { vein: false, card: false });
    expect(mean(flat)).toBeGreaterThan(0.7);
    expect(quantile(flat, 0.95) - quantile(flat, 0.05)).toBeLessThan(0.3);
    expect(quantile(veined, 0.2)).toBeLessThan(0.01);
    expect(quantile(veined, 0.95) - quantile(veined, 0.05)).toBeGreaterThan(0.6);
  });

  it('stands at the same level once there is music, rather than falling away', () => {
    // The defect this replaces: the wash was a fixed *rate*, so the level it
    // reached depended on the decay, and the decay is exactly what a loud
    // section lowers. The same constants that read 0.27 at the idle decay of
    // 0.99 read under 0.06 at the 0.94 a climax asks for — the picture went
    // dark precisely when the music got big. The wash is a target density now,
    // so every decay the director can reach lands in the same window, and the
    // frame is lit by the sheets *on top of* a floor rather than only by them.
    const idle = mean(idleAmbientLevels(IDLE, 64));
    for (const decay of [0.93, 0.941, 0.955, 0.985, 0.99]) {
      const playing = mean(idleAmbientLevels({ ...IDLE, decay }, 64));
      expect(playing).toBeCloseTo(idle, 6);
    }
    // And a louder section, which asks for more gain, is brighter than idle
    // rather than darker.
    const loud = mean(idleAmbientLevels({ gain: 1.35, bands: [0.4, 0.4, 0.4], decay: 0.941 }, 64));
    expect(loud).toBeGreaterThan(idle);
  });

  it('draws the same field on a page that is being given one frame in six', () => {
    // A hidden page hands the renderer steps of 0.1 s rather than 0.017, and
    // the injection is scaled by `dt` while the decay is raised to `dt·60`.
    // Both sides of the balance move together, so the field the user comes
    // back to is the field they left.
    const at = (dt: number): number =>
      mean(idleAmbientLevels({ gain: 1.35, bands: [0.4, 0.4, 0.4], decay: 0.941, dt }, 64));
    expect(at(0.1)).toBeCloseTo(at(1 / 60), 6);
    expect(at(1 / 15)).toBeCloseTo(at(1 / 120), 6);
  });

  it('reads its constants from the shaders it is describing', () => {
    expect(INJECT_RATE).toBeGreaterThan(0);
    expect(KNEE).toBeGreaterThan(0);
    expect(VEIN_LO).toBeLessThan(VEIN_HI);
    // The v2 falloff, and the comb whose mean the ambient target is solved with.
    expect(FALLOFF).toBeGreaterThan(1);
    expect(STRIATE_MEAN + STRIATE_AMP).toBeCloseTo(1, 9);
  });
});

describe('smokeLevel', () => {
  it('is the knee with the falloff on top of it', () => {
    for (const d of [0, 0.2, 1, 4]) {
      expect(smokeLevel(d, KNEE, FALLOFF)).toBeCloseTo(inkLevel(d, KNEE) ** FALLOFF, 9);
    }
  });

  it('deepens the mids and leaves the cores, which is what "long falloff" means', () => {
    // A power above 1 costs a mid-grey much more than it costs a highlight, in
    // both absolute and relative terms. That is the whole mechanism of the
    // reference images: bright soft cores fading long into black.
    const midLoss = inkLevel(0.3, KNEE) - smokeLevel(0.3, KNEE, FALLOFF);
    const coreLoss = inkLevel(3, KNEE) - smokeLevel(3, KNEE, FALLOFF);
    expect(midLoss).toBeGreaterThan(coreLoss);
    expect(smokeLevel(0, KNEE, FALLOFF)).toBe(0);
    expect(smokeLevel(10, KNEE, FALLOFF)).toBeLessThan(1);
  });
});

describe('ambientInjectPerFrame', () => {
  it('is exactly what the frame lost, so the level is the fixed point', () => {
    for (const decay of [0.8, 0.93, 0.955, 0.99, 0.999]) {
      for (const dt of [1 / 120, 1 / 60, 1 / 15, 0.1]) {
        const add = ambientInjectPerFrame(AMBIENT_LEVEL, decay, dt);
        expect(inkEquilibriumDensity(add / dt, decay, dt)).toBeCloseTo(AMBIENT_LEVEL, 9);
      }
    }
  });

  it('is a target the look is solved for, not a rate inherited from v1', () => {
    // v1 defined AMBIENT_LEVEL as whatever its own fixed rate happened to
    // produce at the idle decay. v2 cannot: three things now stand between the
    // level and the screen — the striation comb, the card's shadow and the
    // color stage's new falloff — so the number is solved backwards from the
    // measured window above instead. What has not changed is the *mechanism*:
    // whatever the level is, it is the fixed point of the loop at every decay.
    expect(AMBIENT_LEVEL).toBeGreaterThan(inkEquilibriumDensity(0.5 * INJECT_RATE, DRIFT_DECAY));
    for (const decay of [0.9, 0.941, 0.99]) {
      const add = ambientInjectPerFrame(AMBIENT_LEVEL, decay, 1 / 60);
      expect(inkEquilibriumDensity(add * 60, decay)).toBeCloseTo(AMBIENT_LEVEL, 9);
    }
  });

  it('adds nothing where there is nothing to add', () => {
    expect(ambientInjectPerFrame(AMBIENT_LEVEL, 1, 1 / 60)).toBe(0);
    expect(ambientInjectPerFrame(AMBIENT_LEVEL, 0.99, 0)).toBe(0);
    expect(ambientInjectPerFrame(0, 0.99, 1 / 60)).toBe(0);
  });

  it('agrees with the decay the drift flow style substitutes in the shader', () => {
    // `ink_feedback.frag` overrides the director's decay under `drift`, and the
    // compensation has to be computed against the decay the loop will run at.
    expect(shaderConst(smokeFeedbackFrag, 'DRIFT_DECAY')).toBe(DRIFT_DECAY);
  });
});

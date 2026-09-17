import { describe, expect, it } from 'vitest';

import { harshness, saturation, VocalDetector } from '../../src/analysis/vocal';
import { TimbreTracker } from '../../src/analysis/timbre';
import { DynamicsTracker } from '../../src/analysis/dynamics';
import { OnsetDetector } from '../../src/analysis/onset';
import { chord, framesFrom, mulberry32, noiseBurstTrain, sungVowel } from '../helpers/synth';
import type { Attack, FrameFeatures } from '../../src/shared/types';

const SR = 44100;
const SECONDS = 4;

/** The steady-state `vocal` reading for a signal: the mean of its last second. */
function vocalOf(signal: Float32Array): number {
  const frames = framesFrom(signal, SR);
  const detector = new VocalDetector();
  let prev = Number.NaN;
  const tail: number[] = [];

  for (const f of frames) {
    const dt = Number.isNaN(prev) ? 0 : f.t - prev;
    prev = f.t;
    detector.push(f, dt);
    if (f.t >= signal.length / SR - 1) tail.push(detector.score());
  }
  return tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
}

/**
 * The steady-state `harsh` reading for a signal, off the same trackers the
 * pipeline runs: brightness and flatness from the timbre tracker, the loudness
 * position from the dynamics tracker, the attack from the onsets.
 */
function harshOf(signal: Float32Array): number {
  const frames = framesFrom(signal, SR);
  const timbre = new TimbreTracker();
  const dynamics = new DynamicsTracker();
  const onsets = new OnsetDetector();
  let prev = Number.NaN;
  const tail: number[] = [];

  for (const f of frames) {
    const dt = Number.isNaN(prev) ? 0 : f.t - prev;
    prev = f.t;
    const onset = onsets.push(f);
    timbre.push(f, onset, dt);
    dynamics.push(f.db, f.t);
    if (f.t >= signal.length / SR - 1) {
      tail.push(
        harshness({
          bright: timbre.brightness(),
          flatness: timbre.noisiness(),
          loudRel: dynamics.position(),
          crest: dynamics.crest(),
          attack: timbre.attack(),
        }),
      );
    }
  }
  return tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
}

/** White noise, the least pitched thing there is. */
function whiteNoise(seconds: number, sr = SR): Float32Array {
  const rand = mulberry32(0x11115ee);
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * 0.5;
  return out;
}

describe('vocal', () => {
  it('reads a sung vowel as a voice', () => {
    expect(vocalOf(sungVowel(220, SECONDS, SR))).toBeGreaterThanOrEqual(0.6);
  });

  it('reads a sawtooth pad chord as not a voice', () => {
    expect(vocalOf(chord([110, 130.81, 164.81], SECONDS, SR))).toBeLessThanOrEqual(0.35);
  });

  it('reads white noise as not a voice', () => {
    expect(vocalOf(whiteNoise(SECONDS, SR))).toBeLessThanOrEqual(0.2);
  });

  it('finds a voice at any sung pitch', () => {
    for (const f0 of [140, 330, 440]) {
      expect(vocalOf(sungVowel(f0, SECONDS, SR))).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('halves a reading whose fundamental never moves', () => {
    // A synth pad holding one note: the pitch is a number a machine chose, and
    // it does not wander the way a throat does.
    expect(steadyVocal(() => 200)).toBeCloseTo(0.5, 3);
  });

  it('leaves a wavering fundamental at full strength', () => {
    // Half a percent of vibrato, five times a second — a singer's.
    expect(steadyVocal((t) => 200 * (1 + 0.005 * Math.sin(2 * Math.PI * 5 * t)))).toBeCloseTo(1, 3);
  });

  it('does not call a frame with no fundamental stable', () => {
    expect(steadyVocal(() => 0)).toBeCloseTo(1, 3);
  });

  it('waits for half a second of pitch before it judges stability', () => {
    const detector = new VocalDetector();
    for (let i = 0; i < 6; i++) detector.push(frameWith(1, 1, 200, i * 0.02), 0.02);
    // A tenth of a second of a held note is a held note, not a synth.
    expect(detector.score()).toBeCloseTo(1, 3);
  });

  it('starts at nothing and takes about half a second to follow a change', () => {
    const detector = new VocalDetector();
    expect(detector.score()).toBe(0);

    const loud: FrameFeatures = { ...frameWith(1, 1) };
    detector.push(loud, 0);
    expect(detector.score()).toBeCloseTo(1, 6);

    const quiet = frameWith(0, 0);
    const fresh = new VocalDetector();
    fresh.push(loud, 0);
    fresh.push(quiet, 0.5);
    // One time constant of 0.5 s: 63% of the way down, so 0.37 left.
    expect(fresh.score()).toBeCloseTo(Math.exp(-1), 2);
  });
});

describe('harshness', () => {
  it('reads a bright loud burst train as harsh', () => {
    expect(harshOf(noiseBurstTrain(8, SECONDS, SR))).toBeGreaterThanOrEqual(0.7);
  });

  /**
   * 0.25 rather than 0.2, and the number is the fixture rather than the
   * feature. A chord held at one level for four seconds *is* the loudest thing
   * the dynamics tracker has heard, so `loudRel` reads 1 and contributes the
   * whole 0.2 of its weight on its own; a pad inside real music sits some way
   * down its track's range and reads lower. What the feature has to get right
   * is the distance to a burst train, which is a factor of three.
   */
  it('reads a soft pad as not harsh', () => {
    const pad = harshOf(chord([110, 130.81, 164.81], SECONDS, SR));

    expect(pad).toBeLessThanOrEqual(0.25);
    expect(pad).toBeLessThan(harshOf(noiseBurstTrain(8, SECONDS, SR)) / 3);
  });

  it('discounts music that is not striking at all, and only that', () => {
    const o = { bright: 1, flatness: 1, loudRel: 1, crest: 0, attack: 'sharp' as Attack };
    expect(harshness(o)).toBeCloseTo(1, 6);
    // `mixed` is the normal reading for anything dense — a wall of distorted
    // guitar has no onset that stands out against its own flux — so it keeps
    // full marks. Only `soft` is discounted, and only by a tenth.
    expect(harshness({ ...o, attack: 'mixed' })).toBeCloseTo(1, 6);
    expect(harshness({ ...o, attack: 'soft' })).toBeCloseTo(0.9, 6);
  });

  it('weights brightness, flatness, loudness and saturation', () => {
    const at = (bright: number, flatness: number, loudRel: number, crest = 1): number =>
      harshness({ bright, flatness, loudRel, crest, attack: 'sharp' });
    expect(at(1, 0, 0)).toBeCloseTo(0.3, 6);
    expect(at(0, 1, 0)).toBeCloseTo(0.2, 6); // noisy, but its peaks are intact
    expect(at(0, 0, 1)).toBeCloseTo(0.2, 6);
    expect(at(0, 1, 0, 0)).toBeCloseTo(0.2 + 0.3, 6); // noisy and squashed: distortion
    expect(at(0, 0, 0, 0)).toBe(0); // squashed but tonal: a held note, not distortion
    expect(at(0, 0, 0)).toBe(0);
  });
});

describe('saturation', () => {
  /** Noisy enough for the gate to be fully open; the crest is the variable. */
  const NOISY = 0.2;

  it('reads a squashed noisy wall as saturated and a struck note as not', () => {
    // A crest factor at or below 0.08 is a signal whose peaks have been taken
    // off; at or above 0.28 the transients are still standing.
    expect(saturation(0.04, NOISY)).toBe(1);
    expect(saturation(0.08, NOISY)).toBe(1);
    expect(saturation(0.35, NOISY)).toBe(0);
    expect(saturation(0.28, NOISY)).toBe(0);
    expect(saturation(0.18, NOISY)).toBeCloseTo(0.5, 6);
  });

  it('reads a held tonal pad as not saturated, however flat its peaks', () => {
    // The case the crest factor alone gets wrong: a sustained sawtooth chord
    // has a peak about 3 dB over its rms and no noise between its partials.
    expect(saturation(0.15, 0)).toBe(0);
    expect(saturation(0, 0)).toBe(0);
    expect(saturation(0, 0.04)).toBeCloseTo(0.5, 6);
  });

  it('clamps rather than extrapolating outside 0..1', () => {
    expect(saturation(-1, NOISY)).toBe(1);
    expect(saturation(2, NOISY)).toBe(0);
    expect(saturation(0, 5)).toBe(1);
  });
});

/**
 * A fully vocal reading held for two seconds, with `f0Of` choosing the
 * fundamental of each frame: the steady-state score, after the smoothing has
 * settled and the stability window is full.
 */
function steadyVocal(f0Of: (t: number) => number): number {
  const detector = new VocalDetector();
  const dt = 0.02;
  for (let i = 0; i < 100; i++) {
    const t = i * dt;
    detector.push(frameWith(1, 1, f0Of(t), t), dt);
  }
  return detector.score();
}

/** A frame carrying nothing but the two measurements `vocal` is made of. */
function frameWith(pitch: number, formant: number, f0 = 0, t = 0): FrameFeatures {
  return {
    t,
    rms: 0.1,
    db: -20,
    bands: new Float32Array(8),
    bandsRaw: new Float32Array(8),
    centroid: 1000,
    flatness: 0.1,
    rolloff: 4000,
    flux: 0,
    zcr: 100,
    chroma: new Float32Array(12),
    sub: 0.1,
    pitch,
    f0,
    formant,
  };
}

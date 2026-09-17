import { describe, expect, it } from 'vitest';

import { harshness, VocalDetector } from '../../src/analysis/vocal';
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

  it('reads a soft pad as not harsh', () => {
    expect(harshOf(chord([110, 130.81, 164.81], SECONDS, SR))).toBeLessThanOrEqual(0.2);
  });

  it('discounts everything that does not strike sharply', () => {
    const o = { bright: 1, flatness: 1, loudRel: 1, attack: 'sharp' as Attack };
    expect(harshness(o)).toBeCloseTo(1, 6);
    expect(harshness({ ...o, attack: 'soft' })).toBeCloseTo(0.6, 6);
    expect(harshness({ ...o, attack: 'mixed' })).toBeCloseTo(0.6, 6);
  });

  it('weights brightness, flatness and loudness as the plan specifies', () => {
    const at = (bright: number, flatness: number, loudRel: number): number =>
      harshness({ bright, flatness, loudRel, attack: 'sharp' });
    expect(at(1, 0, 0)).toBeCloseTo(0.4, 6);
    expect(at(0, 1, 0)).toBeCloseTo(0.3, 6);
    expect(at(0, 0, 1)).toBeCloseTo(0.3, 6);
    expect(at(0, 0, 0)).toBe(0);
  });
});

/** A frame carrying nothing but the two measurements `vocal` is made of. */
function frameWith(pitch: number, formant: number): FrameFeatures {
  return {
    t: 0,
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
    formant,
  };
}

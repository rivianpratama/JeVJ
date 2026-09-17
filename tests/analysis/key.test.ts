import { describe, expect, it } from 'vitest';
import { KK_MAJOR, KK_MINOR, KeyTracker, PC_NAMES, modalFlavor, pearson } from '../../src/analysis/key';
import { chord, concatSignals, framesFrom, scaleTones } from '../helpers/synth';

const FS = 44100;
const HOP = 735;
const DT = HOP / FS;

/** MIDI numbers, so the scales below read like a keyboard. */
const C4 = 60;
const A3 = 57;
const D4 = 62;

/** Every frame of `signal` through a fresh tracker. */
function track(signal: Float32Array): KeyTracker {
  const tracker = new KeyTracker();
  for (const f of framesFrom(signal, FS)) tracker.push(f.chroma, DT);
  return tracker;
}

/** A chroma vector with 1 in each named pitch class. */
function pcs(...classes: number[]): Float32Array {
  const c = new Float32Array(12);
  for (const pc of classes) c[pc] = 1;
  return c;
}

describe('pearson', () => {
  it('is 1 for a perfectly scaled copy', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('is -1 for a mirrored copy and 0 for something flat', () => {
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, 2, 3], [5, 5, 5])).toBe(0);
  });
});

describe('the Krumhansl-Kessler profiles', () => {
  it('are twelve numbers each, tonic strongest', () => {
    expect(KK_MAJOR).toHaveLength(12);
    expect(KK_MINOR).toHaveLength(12);
    expect(Math.max(...KK_MAJOR)).toBe(KK_MAJOR[0]);
    expect(Math.max(...KK_MINOR)).toBe(KK_MINOR[0]);
    expect(PC_NAMES[0]).toBe('C');
    expect(PC_NAMES).toHaveLength(12);
  });
});

describe('KeyTracker', () => {
  it('hears C major in a C major scale under a C major triad', () => {
    const signal = concatSignals(
      scaleTones([C4, C4 + 2, C4 + 4, C4 + 5, C4 + 7, C4 + 9, C4 + 11, C4 + 12], 4, FS),
      chord([261.63, 329.63, 392.0], 2, FS),
    );
    const e = track(signal).estimate();

    expect(e.key).toBe('C');
    expect(e.mode).toBe('major');
    expect(e.modeConf).toBeGreaterThan(0.3);
  });

  it('hears A minor in a natural minor scale', () => {
    const e = track(scaleTones([A3, A3 + 2, A3 + 3, A3 + 5, A3 + 7, A3 + 8, A3 + 10, A3 + 12], 6, FS)).estimate();

    expect(e.key).toBe('A');
    expect(e.mode).toBe('minor');
  });

  it('hears D dorian as D, with the dorian flavour', () => {
    // D E F G A B C over a D pedal — the tonic between every scale step.
    // A bare dorian scale is the same seven notes as C major with a D on top,
    // and the Krumhansl-Kessler profiles, which only know major and minor,
    // read that as G major: D is the strongest note, and the fifth degree is
    // the second-strongest slot in the major profile. Dorian needs its tonic
    // stated the way modal music actually states it, which is over a drone.
    const scale = [D4 + 2, D4 + 3, D4 + 5, D4 + 7, D4 + 9, D4 + 10, D4 + 12];
    const e = track(scaleTones(scale.flatMap((n) => [D4, n]), 6, FS)).estimate();

    expect(e.tonic).toBe(2); // D
    expect(e.key).toBe('D');
    expect(e.modal).toBe('dorian');
  });

  it('knows it has heard nothing', () => {
    const e = track(new Float32Array(2 * FS)).estimate();

    expect(e.key).toBe('?');
    expect(e.mode).toBe('unclear');
    expect(e.modal).toBe('unclear');
    expect(e.modeConf).toBe(0);
  });

  it('forgets the old key when the music changes', () => {
    const tracker = new KeyTracker();
    for (const f of framesFrom(chord([261.63, 329.63, 392.0], 6, FS), FS)) tracker.push(f.chroma, DT);
    expect(tracker.estimate().key).toBe('C');

    // F# major triad: as far from C as a triad gets.
    for (const f of framesFrom(chord([369.99, 466.16, 554.37], 12, FS), FS)) tracker.push(f.chroma, DT);
    expect(tracker.estimate().key).toBe('F#');
  });
});

describe('modalFlavor', () => {
  it('names each diatonic mode from its own seven notes', () => {
    expect(modalFlavor(pcs(0, 2, 4, 5, 7, 9, 11), 0)).toBe('ionian');
    expect(modalFlavor(pcs(2, 4, 5, 7, 9, 11, 0), 2)).toBe('dorian');
    expect(modalFlavor(pcs(4, 5, 7, 9, 11, 0, 2), 4)).toBe('phrygian');
    expect(modalFlavor(pcs(5, 7, 9, 11, 0, 2, 4), 5)).toBe('lydian');
    expect(modalFlavor(pcs(7, 9, 11, 0, 2, 4, 5), 7)).toBe('mixolydian');
    expect(modalFlavor(pcs(9, 11, 0, 2, 4, 5, 7), 9)).toBe('aeolian');
    expect(modalFlavor(pcs(11, 0, 2, 4, 5, 7, 9), 11)).toBe('locrian');
  });

  it('gives up when two modes fit equally well', () => {
    // A bare triad is in every mode that contains it; nothing chooses.
    expect(modalFlavor(pcs(0, 4, 7), 0)).toBe('unclear');
    expect(modalFlavor(new Float32Array(12), 0)).toBe('unclear');
  });
});

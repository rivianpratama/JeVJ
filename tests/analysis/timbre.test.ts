import { describe, expect, it } from 'vitest';
import { IC_DISSONANCE, TimbreTracker, consonance } from '../../src/analysis/timbre';
import { OnsetDetector } from '../../src/analysis/onset';
import { chord, clickTrack, concatSignals, framesFrom } from '../helpers/synth';

const FS = 44100;
const DT = 735 / FS;

/** A chroma vector with equal weight in each named pitch class. */
function pcs(...classes: number[]): Float32Array {
  const c = new Float32Array(12);
  for (const pc of classes) c[pc] = 1 / classes.length;
  return c;
}

/** Every frame of `signal` through a tracker, onsets included. */
function track(signal: Float32Array): TimbreTracker {
  const tracker = new TimbreTracker();
  const onsets = new OnsetDetector();
  for (const f of framesFrom(signal, FS)) tracker.push(f, onsets.push(f), DT);
  return tracker;
}

describe('consonance', () => {
  it('has a weight for each interval class', () => {
    expect(IC_DISSONANCE).toHaveLength(7);
    expect(IC_DISSONANCE[1]).toBe(1.0);
    expect(IC_DISSONANCE[5]).toBe(0.05);
  });

  it('is total for a single pitch class, and for silence', () => {
    expect(consonance(pcs(0))).toBe(1);
    expect(consonance(new Float32Array(12))).toBe(1);
  });

  it('is near total for a fifth', () => {
    expect(consonance(pcs(0, 7))).toBeGreaterThan(0.9);
  });

  it('collapses for a minor second', () => {
    expect(consonance(pcs(0, 1))).toBeLessThan(0.2);
  });

  it('sits where a major triad should', () => {
    const c = consonance(pcs(0, 4, 7));

    expect(c).toBeGreaterThanOrEqual(0.75);
    expect(c).toBeLessThanOrEqual(0.95);
  });

  it('is unchanged by how loud the chord is', () => {
    const quiet = pcs(0, 4, 7);
    const loud = new Float32Array(12);
    for (let i = 0; i < 12; i++) loud[i] = quiet[i]! * 100;

    expect(consonance(loud)).toBeCloseTo(consonance(quiet), 6);
  });
});

describe('TimbreTracker', () => {
  it('hears a high chord as brighter than a low one', () => {
    const low = track(chord([110, 138.59, 164.81], 3, FS)).brightness();
    const high = track(chord([880, 1108.7, 1318.5], 3, FS)).brightness();

    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it('hears clicks as noisier than a chord', () => {
    const tonal = track(chord([220, 277.18, 329.63], 3, FS)).noisiness();
    const noisy = track(clickTrack(120, 3, FS)).noisiness();

    expect(noisy).toBeGreaterThan(tonal);
  });

  it('calls a click track a sharp attack', () => {
    expect(track(clickTrack(120, 6, FS)).attack()).toBe('sharp');
  });

  it('has no opinion on attack before an onset', () => {
    expect(new TimbreTracker().attack()).toBe('mixed');
  });

  it('follows the sub share and the centroid as they rise', () => {
    const riser = concatSignals(chord([220, 277.18, 329.63], 4, FS), chord([1760, 2217, 2637], 4, FS));
    const tracker = track(riser);

    expect(tracker.centroidSlope()).toBeGreaterThan(0.1);
    expect(tracker.subWeight()).toBeGreaterThanOrEqual(0);
    expect(tracker.subWeight()).toBeLessThanOrEqual(1);
  });

  it('keeps the centroid slope inside its bounds', () => {
    const faller = concatSignals(chord([1760, 2217, 2637], 4, FS), chord([220, 277.18, 329.63], 4, FS));

    expect(track(faller).centroidSlope()).toBeLessThan(0);
    expect(track(faller).centroidSlope()).toBeGreaterThanOrEqual(-1);
  });
});

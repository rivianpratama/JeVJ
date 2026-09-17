import { describe, expect, it } from 'vitest';
import { OnsetDetector } from '../../src/analysis/onset';
import { beatTimes, clickTrack, framesFrom } from '../helpers/synth';

const FS = 44100;
const TOLERANCE = 0.02; // 20 ms

/** Onset times of `frames`, in order. */
function onsetsOf(frames: ReturnType<typeof framesFrom>, det = new OnsetDetector()): number[] {
  const out: number[] = [];
  for (const f of frames) if (det.push(f) > 0) out.push(f.t);
  return out;
}

/** Greedy one-to-one match of detections to beats within `TOLERANCE`. */
function matchBeats(onsets: number[], beats: number[]): { matched: number; extra: number } {
  const used = new Set<number>();
  let matched = 0;
  for (const beat of beats) {
    const hit = onsets.findIndex((t, i) => !used.has(i) && Math.abs(t - beat) <= TOLERANCE);
    if (hit >= 0) {
      used.add(hit);
      matched += 1;
    }
  }
  return { matched, extra: onsets.length - used.size };
}

describe('OnsetDetector', () => {
  it('finds the beats of a 120 BPM click track within 20 ms', () => {
    const frames = framesFrom(clickTrack(120, 8, FS), FS);
    const beats = beatTimes(120, 8);
    expect(beats.length).toBe(16);

    const { matched, extra } = matchBeats(onsetsOf(frames), beats);

    expect(matched).toBeGreaterThanOrEqual(14);
    expect(extra).toBeLessThanOrEqual(2);
  });

  it('stays quiet through silence', () => {
    const frames = framesFrom(new Float32Array(4 * FS), FS);

    expect(onsetsOf(frames).length).toBe(0);
  });

  it('honours the minimum gap between onsets', () => {
    const det = new OnsetDetector({ minGapSec: 0.4 });
    const frames = framesFrom(clickTrack(120, 8, FS), FS);
    const onsets = onsetsOf(frames, det);

    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i]! - onsets[i - 1]!).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('reports a stronger low-band kick on the accented beat', () => {
    const frames = framesFrom(clickTrack(120, 8, FS), FS);
    const det = new OnsetDetector();
    const downbeats: number[] = [];
    const offbeats: number[] = [];

    for (const f of frames) {
      if (det.push(f) <= 0) continue;
      // Beats land every 0.5 s; every second bar boundary is a multiple of 2 s.
      const beat = Math.round(f.t / 0.5);
      (beat % 4 === 0 ? downbeats : offbeats).push(det.lowOnsetStrength());
    }

    expect(downbeats.length).toBeGreaterThanOrEqual(3);
    expect(offbeats.length).toBeGreaterThanOrEqual(9);
    expect(Math.min(...downbeats)).toBeGreaterThan(Math.max(...offbeats));
  });

  it('resamples its envelope to 100 Hz over the window asked for', () => {
    const frames = framesFrom(clickTrack(120, 8, FS), FS);
    const det = new OnsetDetector();
    let last = 0;
    for (const f of frames) {
      det.push(f);
      last = f.t;
    }

    const env = det.envelope(6, last);
    expect(env.length).toBe(600);
    for (const v of env) expect(Number.isFinite(v)).toBe(true);

    // Twelve beats in six seconds: the envelope must be spiky, not a wash.
    let peak = 0;
    let sum = 0;
    for (const v of env) {
      peak = Math.max(peak, v);
      sum += v;
    }
    expect(peak).toBeGreaterThan((4 * sum) / env.length);
  });

  it('gives an all-zero envelope before it has seen anything', () => {
    const env = new OnsetDetector().envelope(2, 10);

    expect(env.length).toBe(200);
    for (const v of env) expect(v).toBe(0);
  });
});

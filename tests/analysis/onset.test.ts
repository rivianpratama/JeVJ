import { describe, expect, it } from 'vitest';
import { ONSET_REPORT_LAG_SEC, OnsetDetector } from '../../src/analysis/onset';
import { beatTimes, clickTrack, framesFrom } from '../helpers/synth';

const FS = 44100;
/** How far from a beat a detection may sit and still be *that* beat's. */
const PAIRING_WINDOW = 0.12;

/** Onset times of `frames`, in order. */
function onsetsOf(frames: ReturnType<typeof framesFrom>, det = new OnsetDetector()): number[] {
  const out: number[] = [];
  for (const f of frames) if (det.push(f) > 0) out.push(f.t);
  return out;
}

/**
 * Greedy one-to-one pairing of detections to beats, and the signed lag of each
 * pair. Positive means the detection came *after* the beat that caused it.
 */
function lagsAgainst(onsets: number[], beats: number[]): { lags: number[]; extra: number } {
  const used = new Set<number>();
  const lags: number[] = [];
  for (const beat of beats) {
    const hit = onsets.findIndex((t, i) => !used.has(i) && Math.abs(t - beat) <= PAIRING_WINDOW);
    if (hit < 0) continue;
    used.add(hit);
    lags.push(onsets[hit]! - beat);
  }
  return { lags, extra: onsets.length - used.size };
}

function stats(xs: number[]): { mean: number; std: number; min: number; max: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, std, min: Math.min(...xs), max: Math.max(...xs) };
}

/** The 120 BPM fixture's detection lags — the basis of both lag tests. */
function clickTrackLags(): { lags: number[]; extra: number; beats: number[] } {
  const frames = framesFrom(clickTrack(120, 8, FS), FS);
  const beats = beatTimes(120, 8);
  return { ...lagsAgainst(onsetsOf(frames), beats), beats };
}

describe('OnsetDetector', () => {
  it('reports every beat of a 120 BPM click track late, and by a steady amount', () => {
    const { lags, extra, beats } = clickTrackLags();
    expect(beats.length).toBe(16);
    expect(lags.length).toBe(beats.length);
    expect(extra).toBe(0);

    const { std, min, max } = stats(lags);
    // The analysis window ends at `t`, so a hit is only fully inside the window
    // some frames after it sounded: detections are late, never early.
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(0.06);
    // A constant lag is a latency the cue timeline can subtract; jitter is not.
    expect(std).toBeLessThan(0.012);
  });

  it('lags by the amount ONSET_REPORT_LAG_SEC promises', () => {
    const { mean } = stats(clickTrackLags().lags);

    expect(mean).toBeGreaterThan(ONSET_REPORT_LAG_SEC - 0.015);
    expect(mean).toBeLessThan(ONSET_REPORT_LAG_SEC + 0.015);
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

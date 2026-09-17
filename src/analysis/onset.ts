/**
 * Where the music *hits*.
 *
 * Spectral flux already says how much the spectrum gained since the last
 * frame; this turns that stream into discrete events — one per drum hit,
 * chord stab or note attack — and keeps a short history of the raw detection
 * function so the tempo estimator has something periodic to correlate.
 *
 * Two ideas do the work:
 *
 * - Bass counts double. `flux` averages over 60 Hz - 8 kHz, so a kick drum —
 *   a lot of energy in very few bins — barely moves it. Adding the rise of the
 *   two lowest bands back in makes kicks the loudest thing in the detection
 *   function, which is what a beat tracker wants to lock onto.
 * - The threshold is relative. Music does not have an absolute loudness, so an
 *   onset is a local maximum that stands out from the *median* of the last
 *   second — the median, not the mean, so one big hit does not raise the bar
 *   for the hits around it.
 *
 * Pure: no DOM, no Web Audio, and every time it handles comes from the audio
 * clock in `FrameFeatures.t`.
 */

import type { FrameFeatures } from '../shared/types';
import { Ring } from './ring';

export interface OnsetOptions {
  /** How far back the median threshold looks: 43 frames is ~0.7 s at 60 fps. */
  historyFrames?: number;
  /** How far above that median a frame must rise to count. */
  thresholdRatio?: number;
  /** Two onsets closer than this are the same hit seen twice. */
  minGapSec?: number;
}

const DEFAULT_HISTORY = 43;
const DEFAULT_RATIO = 1.5;
const DEFAULT_MIN_GAP = 0.05;

/** Weight on the low-band rise, relative to full-spectrum flux. */
const LOW_WEIGHT = 0.5;
/** Added to the threshold so silence, whose median is 0, cannot trigger. */
const ABSOLUTE_FLOOR = 0.01;

/** How much detection function to keep, and at what rate it is handed out. */
const ENVELOPE_SECONDS = 8;
const ENVELOPE_RATE = 100;
/** 8 s at 200 frames a second — more headroom than any real loop needs. */
const CAPACITY = ENVELOPE_SECONDS * 200;

export class OnsetDetector {
  private readonly history: Ring;
  private readonly scratch: Float32Array;
  private readonly ratio: number;
  private readonly minGap: number;

  /** The detection function of the previous two frames, for the local max. */
  private prev1 = 0;
  private prev2 = 0;

  private prevLow0 = 0;
  private prevLow1 = 0;
  private hasPrevBands = false;

  private lastOnset = -Infinity;
  private lastLow = 0;

  /** A ring of (t, detection function) pairs: the envelope, unresampled. */
  private readonly ts = new Float64Array(CAPACITY);
  private readonly vs = new Float32Array(CAPACITY);
  private head = 0;
  private stored = 0;

  constructor(o: OnsetOptions = {}) {
    const frames = o.historyFrames ?? DEFAULT_HISTORY;
    if (!Number.isInteger(frames) || frames < 1) {
      throw new RangeError(`historyFrames must be a positive integer, got ${frames}`);
    }
    this.history = new Ring(frames);
    this.scratch = new Float32Array(frames);
    this.ratio = o.thresholdRatio ?? DEFAULT_RATIO;
    this.minGap = o.minGapSec ?? DEFAULT_MIN_GAP;
  }

  /**
   * One frame in; the onset strength out, or 0 when this frame is not an
   * onset. The strength is the detection function itself, so a kick reports
   * more than a hi-hat and callers can weight by it.
   */
  push(f: FrameFeatures): number {
    const low0 = f.bandsRaw[0] ?? 0;
    const low1 = f.bandsRaw[1] ?? 0;
    // Half-wave rectified on the *sum*: energy moving from band 0 to band 1
    // is one event, not a rise and a fall.
    const lowRise = this.hasPrevBands ? Math.max(0, low0 - this.prevLow0 + (low1 - this.prevLow1)) : 0;
    this.prevLow0 = low0;
    this.prevLow1 = low1;
    this.hasPrevBands = true;

    const low = LOW_WEIGHT * lowRise;
    const df = f.flux + low;
    this.record(f.t, df);

    // Threshold against the frames *before* this one: including it would let a
    // single loud frame raise its own bar.
    const threshold = this.ratio * this.median() + ABSOLUTE_FLOOR;
    const isPeak = df >= this.prev1 && df >= this.prev2;
    const isOnset = df > threshold && isPeak && f.t - this.lastOnset >= this.minGap;

    this.history.push(df);
    this.prev2 = this.prev1;
    this.prev1 = df;

    if (!isOnset) return 0;
    this.lastOnset = f.t;
    this.lastLow = low;
    return df;
  }

  /**
   * The detection function over the last `seconds` before `now`, linearly
   * resampled to 100 Hz — a fixed rate, so the tempo estimator can talk in
   * lags instead of in frames whose spacing depends on the display.
   *
   * Times outside what has been seen read as 0.
   */
  envelope(seconds: number, now: number): Float32Array {
    const length = Math.max(0, Math.round(seconds * ENVELOPE_RATE));
    const out = new Float32Array(length);
    if (this.stored === 0) return out;

    const start = now - seconds;
    // `read` walks forward with the output: both are in ascending time, so
    // the whole resample is one pass over the ring.
    let read = 0;
    for (let i = 0; i < length; i++) {
      const t = start + i / ENVELOPE_RATE;
      while (read + 1 < this.stored && this.timeAt(read + 1) <= t) read += 1;

      const t0 = this.timeAt(read);
      if (t < t0) continue; // before the first sample: silence
      if (read + 1 >= this.stored) {
        // After the last sample: hold nothing, the future is not data.
        if (t <= t0) out[i] = this.valueAt(read);
        continue;
      }
      const t1 = this.timeAt(read + 1);
      const span = t1 - t0;
      const w = span > 0 ? (t - t0) / span : 0;
      out[i] = this.valueAt(read) * (1 - w) + this.valueAt(read + 1) * w;
    }
    return out;
  }

  /**
   * How much of the last onset was bass — what a downbeat is made of. Stays
   * put between onsets, so the beat grid can read it when it is told.
   */
  lowOnsetStrength(): number {
    return this.lastLow;
  }

  /** Audio-clock time of the last onset, or -Infinity if there has been none. */
  lastOnsetTime(): number {
    return this.lastOnset;
  }

  private record(t: number, v: number): void {
    this.ts[this.head] = t;
    this.vs[this.head] = v;
    this.head = (this.head + 1) % CAPACITY;
    if (this.stored < CAPACITY) this.stored += 1;
  }

  /** `i` counts from the oldest retained pair. */
  private slot(i: number): number {
    const oldest = this.stored < CAPACITY ? 0 : this.head;
    return (oldest + i) % CAPACITY;
  }

  private timeAt(i: number): number {
    return this.ts[this.slot(i)]!;
  }

  private valueAt(i: number): number {
    return this.vs[this.slot(i)]!;
  }

  /** Median of the retained history. Copies into a scratch buffer to sort. */
  private median(): number {
    const n = this.history.length;
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) this.scratch[i] = this.history.at(i);
    const window = this.scratch.subarray(0, n);
    window.sort();
    const mid = n >> 1;
    return n % 2 === 1 ? window[mid]! : (window[mid - 1]! + window[mid]!) / 2;
  }
}

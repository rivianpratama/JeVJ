/**
 * Is this talking rather than music?
 *
 * Speech has a signature no instrument quite shares: syllables arrive three to
 * six times a second, so the loudness envelope has a broad hump there; there is
 * no tempo to lock onto; the spectral centroid sits in the 1-3 kHz formant
 * region; and the alternation of voiced and unvoiced sounds makes the zero
 * crossing rate swing about. Four weak cues, combined, are worth more than any
 * one of them.
 *
 * The envelope modulation spectrum is the main one. The rms history is
 * resampled onto a fixed 50 Hz grid so the answer does not depend on the
 * display rate, mean-removed so the dc level is not the loudest thing in it,
 * and transformed with a plain 200-point DFT — four seconds at 0.25 Hz
 * resolution, which is as much as the 3-6 Hz question needs.
 *
 * Pure: numbers and frames in, one number out.
 */

import type { FrameFeatures } from '../shared/types';
import { TimedRing } from './ring';

/** The grid the envelope is resampled onto, and how much of it is used. */
const ENVELOPE_RATE = 50;
const ENVELOPE_SECONDS = 4;
const ENVELOPE_POINTS = ENVELOPE_RATE * ENVELOPE_SECONDS; // 200

/** The syllabic band, and the band it is measured as a share of. */
const SYLLABLE_LO_HZ = 3;
const SYLLABLE_HI_HZ = 6;
const MODULATION_LO_HZ = 0.5;
const MODULATION_HI_HZ = 15;
/**
 * The brief asked for the share to be doubled before clamping, on the reading
 * that even fluent speech spreads its modulation well outside 3-6 Hz. Measured,
 * that leaves no room to tell speech from a metronome: a beat at 120 BPM
 * modulates the envelope at 2 Hz, and the second and third harmonics of a 2 Hz
 * pulse train land at 4 and 6 Hz, inside the syllabic band. A 120 BPM click
 * track puts 47% of its modulation energy in 3-6 Hz and a 90 BPM one more than
 * half — doubled, both saturate at 1.0, exactly like speech, and the whole
 * 0.4-weighted cue stops discriminating (the click track scored 0.44 against a
 * brief that wants it under 0.3).
 *
 * Ungained, the same measurement separates them: 0.47 for the metronome
 * against 1.0 for a 4 Hz syllabic envelope. See the task report.
 */
const MOD_RATIO_GAIN = 1;

/** The formant region, and where the credit has fallen away to nothing. */
const CENTROID_LO_HZ = 400;
const CENTROID_MID_LO_HZ = 1000;
const CENTROID_MID_HI_HZ = 3000;
const CENTROID_HI_HZ = 6000;

/** How long the centroid and zcr statistics look over. */
const SHORT_WINDOW_SEC = 2;

/**
 * Frames quiet enough to be between words say nothing about the timbre of the
 * voice, and averaging them in would drag a metronome's centroid down into the
 * formant band. A frame counts only if it carries a tenth of the window's
 * loudest rms.
 */
const ACTIVE_SHARE = 0.1;

/** How the four cues are weighted. */
const W_MODULATION = 0.4;
const W_NO_BEAT = 0.25;
const W_CENTROID = 0.2;
const W_ZCR = 0.15;

/** A 200-point DFT is not free; this often is often enough. */
const CACHE_SEC = 0.1;

/** Eight seconds of frames at up to 200 a second. */
const CAPACITY = 8 * 200;

/**
 * `cos` and `sin` of every angle the 200-point DFT can ask for. The transform
 * touches 200 samples in each of 59 bins and this runs inside the render loop,
 * so the twelve thousand pairs of trig calls are worth turning into two array
 * reads. `k·n mod 200` covers every distinct angle.
 */
const TWIDDLE_COS = new Float64Array(ENVELOPE_POINTS);
const TWIDDLE_SIN = new Float64Array(ENVELOPE_POINTS);
for (let m = 0; m < ENVELOPE_POINTS; m++) {
  TWIDDLE_COS[m] = Math.cos((-2 * Math.PI * m) / ENVELOPE_POINTS);
  TWIDDLE_SIN[m] = Math.sin((-2 * Math.PI * m) / ENVELOPE_POINTS);
}

export class SpeechDetector {
  /**
   * Three histories of the same length, written in lockstep by `push`, so an
   * index found in one is the same frame in the others. That is what lets the
   * rms history decide which frames the centroid and zcr statistics may use.
   */
  private readonly rmsHistory = new TimedRing(CAPACITY);
  private readonly centroids = new TimedRing(CAPACITY);
  private readonly zcrs = new TimedRing(CAPACITY);
  private lastT = 0;
  private any = false;

  private readonly grid = new Float64Array(ENVELOPE_POINTS);
  private cachedAt = -Infinity;
  private cachedCues = 0;

  push(rms: number, t: number, f: FrameFeatures): void {
    this.rmsHistory.push(t, Math.max(0, rms));
    this.centroids.push(t, f.centroid);
    this.zcrs.push(t, f.zcr);
    this.lastT = t;
    this.any = true;
  }

  /**
   * 0..1. `beatConfidence` is the beat grid's — music that the tracker is sure
   * of is music, whatever its envelope looks like.
   */
  score(beatConfidence: number): number {
    if (!this.any) return 0;

    if (this.lastT - this.cachedAt >= CACHE_SEC) {
      this.cachedAt = this.lastT;
      this.cachedCues =
        W_MODULATION * this.modulationRatio() + W_CENTROID * this.centroidMid() + W_ZCR * this.zcrVariation();
    }
    return clamp(this.cachedCues + W_NO_BEAT * (1 - clamp(beatConfidence, 0, 1)), 0, 1);
  }

  /** Share of the envelope's modulation energy that sits at syllable rate. */
  private modulationRatio(): number {
    const grid = this.resample();
    if (grid === null) return 0;

    let mean = 0;
    for (let i = 0; i < ENVELOPE_POINTS; i++) mean += grid[i]!;
    mean /= ENVELOPE_POINTS;

    const perBin = ENVELOPE_RATE / ENVELOPE_POINTS; // 0.25 Hz
    const loBin = Math.round(SYLLABLE_LO_HZ / perBin);
    const hiBin = Math.round(SYLLABLE_HI_HZ / perBin);
    const bandLo = Math.max(1, Math.round(MODULATION_LO_HZ / perBin));
    const bandHi = Math.min(ENVELOPE_POINTS >> 1, Math.round(MODULATION_HI_HZ / perBin));

    let syllable = 0;
    let all = 0;
    for (let k = bandLo; k <= bandHi; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < ENVELOPE_POINTS; n++) {
        const m = (k * n) % ENVELOPE_POINTS;
        const v = grid[n]! - mean;
        re += v * TWIDDLE_COS[m]!;
        im += v * TWIDDLE_SIN[m]!;
      }
      const power = re * re + im * im;
      all += power;
      if (k >= loBin && k <= hiBin) syllable += power;
    }

    return all > 0 ? clamp((syllable / all) * MOD_RATIO_GAIN, 0, 1) : 0;
  }

  /**
   * The rms history on the fixed 50 Hz grid, or null when four seconds of it
   * have not gone by yet. Linear interpolation between the frames either side.
   */
  private resample(): Float64Array | null {
    const from = this.lastT - ENVELOPE_SECONDS;
    if (this.rmsHistory.length < 2 || this.rmsHistory.startTime() > from) return null;

    let read = this.rmsHistory.indexAtOrAfter(from);
    if (read > 0) read -= 1;

    for (let i = 0; i < ENVELOPE_POINTS; i++) {
      const t = from + i / ENVELOPE_RATE;
      while (read + 1 < this.rmsHistory.length && this.rmsHistory.timeAt(read + 1) <= t) read += 1;

      const t0 = this.rmsHistory.timeAt(read);
      if (read + 1 >= this.rmsHistory.length) {
        this.grid[i] = this.rmsHistory.valueAt(read);
        continue;
      }
      const t1 = this.rmsHistory.timeAt(read + 1);
      const span = t1 - t0;
      const w = span > 0 ? clamp((t - t0) / span, 0, 1) : 0;
      this.grid[i] = this.rmsHistory.valueAt(read) * (1 - w) + this.rmsHistory.valueAt(read + 1) * w;
    }
    return this.grid;
  }

  /** 1 while the voice sits in the formant band, falling away either side. */
  private centroidMid(): number {
    const centroid = this.activeMean(this.centroids);
    if (!(centroid > 0)) return 0;
    if (centroid < CENTROID_MID_LO_HZ) {
      return clamp((centroid - CENTROID_LO_HZ) / (CENTROID_MID_LO_HZ - CENTROID_LO_HZ), 0, 1);
    }
    if (centroid > CENTROID_MID_HI_HZ) {
      return clamp((CENTROID_HI_HZ - centroid) / (CENTROID_HI_HZ - CENTROID_MID_HI_HZ), 0, 1);
    }
    return 1;
  }

  /** How much the zero crossing rate swings about, relative to its own mean. */
  private zcrVariation(): number {
    const from = this.lastT - SHORT_WINDOW_SEC;
    const start = this.rmsHistory.indexAtOrAfter(from);
    const floor = this.activeFloor(from);

    let mean = 0;
    let n = 0;
    for (let i = start; i < this.zcrs.length; i++) {
      if (this.rmsHistory.valueAt(i) < floor) continue;
      mean += this.zcrs.valueAt(i);
      n += 1;
    }
    if (n < 2 || !(mean > 0)) return 0;
    mean /= n;

    let variance = 0;
    for (let i = start; i < this.zcrs.length; i++) {
      if (this.rmsHistory.valueAt(i) < floor) continue;
      const d = this.zcrs.valueAt(i) - mean;
      variance += d * d;
    }
    return clamp(Math.sqrt(variance / n) / mean, 0, 1);
  }

  /** Mean of `series` over the last two seconds, quiet frames left out. */
  private activeMean(series: TimedRing): number {
    const from = this.lastT - SHORT_WINDOW_SEC;
    const start = this.rmsHistory.indexAtOrAfter(from);
    const floor = this.activeFloor(from);

    let sum = 0;
    let n = 0;
    for (let i = start; i < series.length; i++) {
      if (this.rmsHistory.valueAt(i) < floor) continue;
      sum += series.valueAt(i);
      n += 1;
    }
    return n > 0 ? sum / n : 0;
  }

  /** The rms a frame has to reach to be worth listening to. */
  private activeFloor(from: number): number {
    const loudest = this.rmsHistory.max(from, this.lastT);
    return Number.isFinite(loudest) ? loudest * ACTIVE_SHARE : 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

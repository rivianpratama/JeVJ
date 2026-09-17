/**
 * One magnitude spectrum in, one `FrameFeatures` out.
 *
 * These are the raw, per-frame numbers everything else is built from: Task 4
 * smooths them into tempo and key, Task 5 summarises them for Jev, Task 6
 * drives the visuals with them. Nothing here knows about time beyond the
 * previous frame, and nothing here touches the DOM or Web Audio, so the whole
 * file runs under vitest in Node.
 *
 * The extractor is stateful on purpose: spectral flux needs the previous
 * spectrum, and the band levels need a per-band peak tracker so that quiet
 * music still fills the bars. One instance per audio source.
 */

import { BAND_EDGES_HZ, type FrameFeatures } from '../shared/types';

const BAND_COUNT = BAND_EDGES_HZ.length - 1;

/** Per-band peak tracker: how fast the remembered peak forgets a loud moment. */
const PEAK_DECAY = 0.995;
/** Keeps a silent band from normalising its own noise floor up to full scale. */
const PEAK_FLOOR = 1e-4;
/** Fraction of the peak treated as floor, so hiss does not light the bar. */
const BAND_GATE = 0.05;
/** >1 makes the bars sit lower and punch harder. */
const BAND_SHAPE = 1.3;
const BAND_ATTACK = 0.6;
const BAND_RELEASE = 0.12;

const CENTROID_MIN_HZ = 20;
const NOISE_LO_HZ = 60;
const NOISE_HI_HZ = 8000;
const CHROMA_MIN_HZ = 60;
const ROLLOFF_FRACTION = 0.95;
/** Keeps log(0) out of the flatness geometric mean. */
const FLATNESS_EPS = 1e-12;
/** -100 dBFS is the quietest thing we bother to distinguish. */
const RMS_FLOOR = 1e-5;
/**
 * Turns `sqrt(sum(mags^2)) / (fftSize/2)` into the rms a full-scale sine would
 * have: 2/sqrt(3) undoes the Hann power gain of 3/8 and the half-spectrum.
 */
const MAGS_RMS_SCALE = 2 / Math.sqrt(3);

export interface FeatureExtractorOptions {
  sampleRate: number;
  fftSize: number;
}

/** Bin ranges `[start, end)` for each of the 8 bands in `BAND_EDGES_HZ`. */
export function bandIndexRanges(sampleRate: number, fftSize: number): Array<[number, number]> {
  const bins = fftSize >> 1;
  const hzPerBin = sampleRate / fftSize;
  const ranges: Array<[number, number]> = [];

  for (let b = 0; b < BAND_COUNT; b++) {
    const lo = clamp(Math.round(BAND_EDGES_HZ[b]! / hzPerBin), 0, bins - 1);
    // Bands that reach past Nyquist collapse onto the top bin rather than
    // producing an empty range that every mean() would have to guard against.
    const hi = clamp(Math.round(BAND_EDGES_HZ[b + 1]! / hzPerBin), lo + 1, bins);
    ranges.push([lo, hi]);
  }
  return ranges;
}

/**
 * Energy per pitch class, normalised to sum 1 (all zeros when silent).
 *
 * Squared magnitude is the weight, so a strong partial counts for much more
 * than the wash around it, and bins below 60 Hz are skipped: down there one
 * bin is wider than a semitone and the pitch class is meaningless.
 */
export function chromaFromMagnitudes(mags: Float32Array, sampleRate: number, fftSize: number): Float32Array {
  const hzPerBin = sampleRate / fftSize;
  const out = new Float32Array(12);
  let total = 0;

  for (let k = Math.max(1, Math.ceil(CHROMA_MIN_HZ / hzPerBin)); k < mags.length; k++) {
    const energy = mags[k]! * mags[k]!;
    if (energy === 0) continue;
    const midi = 69 + 12 * Math.log2((k * hzPerBin) / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    out[pc] = out[pc]! + energy;
    total += energy;
  }

  if (total > 0) for (let i = 0; i < 12; i++) out[i] = out[i]! / total;
  return out;
}

export class FeatureExtractor {
  private readonly sampleRate: number;
  private readonly fftSize: number;
  private readonly bins: number;
  private readonly hzPerBin: number;
  private readonly ranges: Array<[number, number]>;

  private readonly peaks = new Float32Array(BAND_COUNT);
  private readonly levels = new Float32Array(BAND_COUNT);
  private readonly prev: Float32Array;
  private hasPrev = false;

  constructor(o: FeatureExtractorOptions) {
    this.sampleRate = o.sampleRate;
    this.fftSize = o.fftSize;
    this.bins = o.fftSize >> 1;
    this.hzPerBin = o.sampleRate / o.fftSize;
    this.ranges = bandIndexRanges(o.sampleRate, o.fftSize);
    this.prev = new Float32Array(this.bins);
  }

  /**
   * `mags` is `fftSize / 2` linear magnitudes; `time` is the matching
   * time-domain frame when one is available (the live graph always has one,
   * the offline pass does not); `t` is the audio clock the frame belongs to.
   *
   * Neither input is retained — the extractor copies what it needs.
   */
  extract(mags: Float32Array, time: Float32Array | null, t: number): FrameFeatures {
    if (mags.length !== this.bins) {
      throw new RangeError(`expected ${this.bins} magnitude bins, got ${mags.length}`);
    }

    const rms = time ? rmsOf(time) : this.rmsFromMagnitudes(mags);
    const bandsRaw = this.bandMeans(mags);

    return {
      t,
      rms,
      db: 20 * Math.log10(Math.max(rms, RMS_FLOOR)),
      bands: this.adapt(bandsRaw),
      bandsRaw,
      centroid: this.centroid(mags),
      flatness: this.flatness(mags),
      rolloff: this.rolloff(mags),
      flux: this.flux(mags),
      zcr: time ? (zeroCrossings(time) * this.sampleRate) / time.length : 0,
      chroma: chromaFromMagnitudes(mags, this.sampleRate, this.fftSize),
      sub: this.subShare(mags),
    };
  }

  /** Only used when there is no time-domain frame — see MAGS_RMS_SCALE. */
  private rmsFromMagnitudes(mags: Float32Array): number {
    let sum = 0;
    for (let k = 0; k < mags.length; k++) sum += mags[k]! * mags[k]!;
    return (Math.sqrt(sum) / this.bins) * MAGS_RMS_SCALE;
  }

  private bandMeans(mags: Float32Array): Float32Array {
    const out = new Float32Array(BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      const [start, end] = this.ranges[b]!;
      let sum = 0;
      for (let k = start; k < end; k++) sum += mags[k]!;
      out[b] = sum / (end - start);
    }
    return out;
  }

  /**
   * Each band is scored against its own recent peak, so a quiet mix still
   * moves the bars and a loud one does not clip them. The peak decays slowly;
   * the level rises fast and falls slowly, which is what reads as "punch".
   */
  private adapt(raw: Float32Array): Float32Array {
    const out = new Float32Array(BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      const value = raw[b]!;
      const peak = Math.max(value, this.peaks[b]! * PEAK_DECAY, PEAK_FLOOR);
      this.peaks[b] = peak;

      const norm = clamp((value - BAND_GATE * peak) / ((1 - BAND_GATE) * peak), 0, 1);
      const shaped = Math.pow(norm, BAND_SHAPE);
      const level = this.levels[b]!;
      this.levels[b] = level + (shaped - level) * (shaped > level ? BAND_ATTACK : BAND_RELEASE);
      out[b] = this.levels[b]!;
    }
    return out;
  }

  /** Energy-weighted mean frequency — "brightness". */
  private centroid(mags: Float32Array): number {
    let weighted = 0;
    let energy = 0;
    for (let k = Math.ceil(CENTROID_MIN_HZ / this.hzPerBin); k < mags.length; k++) {
      const e = mags[k]! * mags[k]!;
      weighted += k * this.hzPerBin * e;
      energy += e;
    }
    return energy > 0 ? weighted / energy : 0;
  }

  /**
   * Geometric mean over arithmetic mean of the power spectrum: 1 for a flat
   * (noise-like) band, near 0 for a few sharp partials. Restricted to
   * 60 Hz - 8 kHz, where music actually distinguishes tone from noise.
   *
   * The power is averaged over three neighbouring bins first. A single-frame
   * periodogram of true white noise is exponentially distributed bin to bin,
   * and geomean/mean of that is exp(-gamma) = 0.56 however flat the source
   * really is — half the range wasted on an artefact of the estimator. Three
   * bins is the width of the Hann main lobe, so this undoes the window's own
   * smear and nothing more: noise then reads ~0.77 and a pure tone still
   * reads ~1e-13.
   */
  private flatness(mags: Float32Array): number {
    const [start, end] = this.noiseRange();
    const n = end - start;
    if (n <= 0) return 0;

    let logSum = 0;
    let sum = 0;
    for (let k = start; k < end; k++) {
      const e = this.smoothedPower(mags, k) + FLATNESS_EPS;
      logSum += Math.log(e);
      sum += e;
    }
    if (sum <= 0) return 0;
    return clamp(Math.exp(logSum / n) / (sum / n), 0, 1);
  }

  /** Mean power over bin `k` and its two neighbours, clipped at the edges. */
  private smoothedPower(mags: Float32Array, k: number): number {
    let sum = 0;
    let count = 0;
    for (let j = k - 1; j <= k + 1; j++) {
      if (j < 0 || j >= mags.length) continue;
      sum += mags[j]! * mags[j]!;
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  }

  /** The frequency below which 95% of the energy sits. */
  private rolloff(mags: Float32Array): number {
    let total = 0;
    for (let k = 0; k < mags.length; k++) total += mags[k]! * mags[k]!;
    if (total <= 0) return 0;

    const target = total * ROLLOFF_FRACTION;
    let running = 0;
    for (let k = 0; k < mags.length; k++) {
      running += mags[k]! * mags[k]!;
      if (running >= target) return k * this.hzPerBin;
    }
    return (mags.length - 1) * this.hzPerBin;
  }

  /**
   * Half-wave rectified spectral flux: how much the spectrum *gained* since
   * the last frame, which is the raw material for onset detection in Task 4.
   * The first frame has nothing to compare against and reports 0 rather than
   * a phantom onset at t=0.
   */
  private flux(mags: Float32Array): number {
    const [start, end] = this.noiseRange();
    let sum = 0;
    if (this.hasPrev) {
      for (let k = start; k < end; k++) {
        const rise = mags[k]! - this.prev[k]!;
        if (rise > 0) sum += rise;
      }
    }
    this.prev.set(mags);
    this.hasPrev = true;
    return end > start ? sum / (end - start) : 0;
  }

  /** Share of the total band energy sitting in 20-60 Hz. */
  private subShare(mags: Float32Array): number {
    let sub = 0;
    let total = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const [start, end] = this.ranges[b]!;
      let energy = 0;
      for (let k = start; k < end; k++) energy += mags[k]! * mags[k]!;
      if (b === 0) sub = energy;
      total += energy;
    }
    return total > 0 ? sub / total : 0;
  }

  private noiseRange(): [number, number] {
    const start = clamp(Math.ceil(NOISE_LO_HZ / this.hzPerBin), 1, this.bins - 1);
    const end = clamp(Math.floor(NOISE_HI_HZ / this.hzPerBin) + 1, start + 1, this.bins);
    return [start, end];
  }
}

function rmsOf(time: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < time.length; i++) sum += time[i]! * time[i]!;
  return time.length > 0 ? Math.sqrt(sum / time.length) : 0;
}

function zeroCrossings(time: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < time.length; i++) {
    if (time[i - 1]! < 0 !== time[i]! < 0) crossings += 1;
  }
  return crossings;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

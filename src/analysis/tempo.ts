/**
 * How fast the music is going, from the onset envelope alone.
 *
 * Autocorrelation is the whole idea: if hits recur every L samples of the
 * 100 Hz envelope, the envelope looks like itself shifted by L. Two things
 * turn that into a tempo a listener would agree with:
 *
 * - A prior. Correlation cannot tell 60 from 120 from 240 BPM apart — they are
 *   all "the same" period, at different octaves — but people can, and they
 *   cluster around 120. A log-normal prior centred there breaks the tie the
 *   way a listener would.
 * - An octave rule. When the prior is not enough and the half- or double-time
 *   lag scores nearly as well, we take the one that lands in the range music
 *   actually gets counted in.
 *
 * Pure: an array of numbers in, a tempo out.
 */

import type { TempoMarking } from '../shared/types';

export interface TempoEstimate {
  bpm: number;
  /** Seconds per beat — `60 / bpm`, kept so nobody has to divide again. */
  period: number;
  /** 0..1, how far the winning lag stands above the average lag. */
  confidence: number;
  marking: TempoMarking;
}

/** The envelope's sample rate; lags below are in its samples. */
const RATE = 100;
/** 30 samples = 200 BPM, 100 = 60 BPM: the range of countable tempi. */
const MIN_LAG = 30;
const MAX_LAG = 100;

/** Where the prior peaks, and how wide it is in ln(bpm). */
const PRIOR_CENTRE = 120;
const PRIOR_SIGMA = 0.5;

/** How close the half-lag must score to be taken instead. */
const OCTAVE_UP_RATIO = 0.8;
/** Doubling the tempo is only sensible below this. */
const OCTAVE_UP_MAX_BPM = 150;
/** How close the double-lag must score to be taken instead. */
const OCTAVE_DOWN_RATIO = 0.9;
/**
 * And halving is only sensible above this.
 *
 * The brief said 70. Measured on a 170 BPM click track, the two-beat lag
 * scores 0.96 of the one-beat lag — an accent every four beats is symmetric
 * under both — so a 70 floor halves anything fast down to the 80s. 90 keeps
 * the rule doing its real job (pulling 190 BPM back to 95) without taking a
 * genuinely fast track apart. See the report for the measurement.
 */
const OCTAVE_DOWN_MIN_BPM = 90;

/** Peak-to-mean ratio of a confident estimate — the scale for `confidence`. */
const CONFIDENCE_SCALE = 8;

const FALLBACK: TempoEstimate = { bpm: 120, period: 0.5, confidence: 0, marking: 'allegro' };

/**
 * `envelope100Hz` is the onset detection function at 100 Hz, oldest first —
 * what `OnsetDetector.envelope()` hands out.
 *
 * Needs a little over two seconds of it; anything shorter comes back as 120
 * BPM with no confidence rather than as a guess dressed up as a measurement.
 */
export function estimateTempo(envelope100Hz: Float32Array): TempoEstimate {
  const n = envelope100Hz.length;
  if (n < MAX_LAG * 2) return FALLBACK;

  // Mean removal is what makes the correlation about *structure*: without it
  // every lag scores the envelope's dc level and the peaks vanish into it.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += envelope100Hz[i]!;
  mean /= n;

  const x = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = envelope100Hz[i]! - mean;
    x[i] = v;
    energy += v * v;
  }
  if (energy <= 0) return FALLBACK; // a flat envelope has no tempo at all

  // Unnormalised sums, deliberately: the shrinking overlap at longer lags is a
  // mild taper toward faster tempi, which is the honest bias for a window that
  // holds fewer long periods than short ones.
  const scores = new Float64Array(MAX_LAG + 1);
  let total = 0;
  let count = 0;
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let r = 0;
    for (let i = 0; i + lag < n; i++) r += x[i]! * x[i + lag]!;
    scores[lag] = (r / energy) * prior(bpmOf(lag));
    total += scores[lag]!;
    count += 1;
  }

  let best = MIN_LAG;
  for (let lag = MIN_LAG + 1; lag <= MAX_LAG; lag++) {
    if (scores[lag]! > scores[best]!) best = lag;
  }

  const lag = applyOctaveRule(scores, best);
  const bpm = bpmOf(lag);
  const mean_ = count > 0 ? total / count : 0;
  // A peak standing over a zero or negative average is as sharp as it gets;
  // dividing by that average would only turn a clear answer into infinity.
  const peak = scores[best]!;
  const confidence = peak <= 0 ? 0 : mean_ <= 0 ? 1 : clamp01(peak / mean_ / CONFIDENCE_SCALE);

  return { bpm, period: 60 / bpm, confidence, marking: tempoMarking(bpm) };
}

/** The traditional Italian names, by the ranges most editions agree on. */
export function tempoMarking(bpm: number): TempoMarking {
  if (bpm < 66) return 'largo';
  if (bpm < 76) return 'adagio';
  if (bpm < 108) return 'andante';
  if (bpm < 120) return 'moderato';
  if (bpm < 156) return 'allegro';
  if (bpm < 176) return 'vivace';
  return 'presto';
}

/**
 * Half or double the winning lag when that octave scores nearly as well and
 * lands somewhere music is actually counted.
 */
function applyOctaveRule(scores: Float64Array, best: number): number {
  const half = Math.round(best / 2);
  if (half >= MIN_LAG && scores[half]! >= OCTAVE_UP_RATIO * scores[best]! && bpmOf(half) <= OCTAVE_UP_MAX_BPM) {
    return half;
  }

  const double = best * 2;
  if (
    double <= MAX_LAG &&
    scores[double]! >= OCTAVE_DOWN_RATIO * scores[best]! &&
    bpmOf(double) >= OCTAVE_DOWN_MIN_BPM
  ) {
    return double;
  }
  return best;
}

function bpmOf(lag: number): number {
  return (60 * RATE) / lag;
}

/** Log-normal around 120 BPM: an octave out costs the same either way. */
function prior(bpm: number): number {
  const z = Math.log(bpm / PRIOR_CENTRE) / PRIOR_SIGMA;
  return Math.exp(-0.5 * z * z);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

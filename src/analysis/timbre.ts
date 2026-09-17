/**
 * What the music is made of, rather than what it is playing: how bright, how
 * noisy, how sharply it strikes, how much weight sits under it — and how
 * consonant the harmony is.
 *
 * Consonance is the odd one out here because it is harmonic, not spectral, but
 * it belongs with the rest: it is a property of the *sound*, the thing that
 * makes a chord feel settled or unresolved, and it is the input Jev turns into
 * tension. Plomp and Levelt measured roughness as a function of how close two
 * partials sit inside a critical band; collapsed to pitch classes that becomes
 * a weight per interval class, and a chord's dissonance is the energy-weighted
 * average of the weights of its intervals.
 *
 * The spectral features are one-pole smoothed. Per-frame centroid and flatness
 * jitter far more than the timbre they describe, and a visual driven by the
 * raw numbers would shimmer.
 *
 * Pure: frames and seconds in, numbers out.
 */

import type { Attack, FrameFeatures } from '../shared/types';
import { Ring, TimedRing } from './ring';

/** Sensory dissonance by interval class: ic1 is a semitone, ic6 the tritone. */
export const IC_DISSONANCE = [0, 1.0, 0.6, 0.2, 0.15, 0.05, 0.9];

/** How long the smoothed features take to follow a change (63% of the way). */
const SMOOTH_TAU_SEC = 0.25;
/** A tab left in the background must not be smoothed through. */
const MAX_DT = 1;

/** Brightness maps the centroid from 200 Hz up over five octaves. */
const BRIGHT_BASE_HZ = 200;
const BRIGHT_OCTAVES = 5;

/** Flux is compared against its own mean over this long. */
const FLUX_WINDOW_SEC = 2;
/** How many onsets the attack judgment averages over. */
const ATTACK_ONSETS = 16;
/** Above this rise-over-average an attack is sharp, below it is soft. */
const ATTACK_SHARP = 2.5;
const ATTACK_SOFT = 1.4;

/** `centroidSlope` compares the last 2 s against the 4 s before that. */
const SLOPE_RECENT_SEC = 2;
const SLOPE_PAST_SEC = 6;
/** Hertz of movement that counts as a full-scale riser. */
const SLOPE_FULL_HZ = 2000;

/** Eight seconds of centroid at up to 200 frames a second. */
const CENTROID_CAPACITY = 8 * 200;
const FLUX_CAPACITY = FLUX_WINDOW_SEC * 200;

/**
 * How settled the harmony is: 1 for a single pitch class or an empty chroma,
 * down toward 0 as the energy piles into semitones and tritones.
 *
 * Every pair of pitch classes contributes its product — the energy actually
 * present in that interval — weighted by the interval's dissonance. Dividing
 * by the total pair energy makes the answer independent of how loud the chord
 * is and of how many notes it has.
 */
export function consonance(chroma: Float32Array): number {
  let rough = 0;
  let total = 0;

  for (let i = 0; i < 12; i++) {
    const ci = Math.max(0, chroma[i] ?? 0);
    if (ci === 0) continue;
    for (let j = i + 1; j < 12; j++) {
      const cj = Math.max(0, chroma[j] ?? 0);
      if (cj === 0) continue;
      const pair = ci * cj;
      const gap = j - i;
      total += pair;
      rough += pair * IC_DISSONANCE[Math.min(gap, 12 - gap)]!;
    }
  }

  return total > 0 ? 1 - rough / total : 1;
}

export class TimbreTracker {
  private readonly centroids = new TimedRing(CENTROID_CAPACITY);
  private readonly fluxes = new TimedRing(FLUX_CAPACITY);
  private readonly rises = new Ring(ATTACK_ONSETS);

  private bright = 0;
  private noise = 0;
  private sub = 0;
  private started = false;
  private lastT = 0;

  /**
   * One frame, the onset strength the detector reported for it (0 when it was
   * not an onset), and the seconds since the previous frame.
   */
  push(f: FrameFeatures, onsetStrength: number, dt: number): void {
    const step = 1 - Math.exp(-Math.min(MAX_DT, Math.max(0, dt)) / SMOOTH_TAU_SEC);

    const target = clamp(Math.log2(Math.max(f.centroid, 1) / BRIGHT_BASE_HZ) / BRIGHT_OCTAVES, 0, 1);
    if (!this.started) {
      this.bright = target;
      this.noise = f.flatness;
      this.sub = f.sub;
      this.started = true;
    } else {
      this.bright += (target - this.bright) * step;
      this.noise += (f.flatness - this.noise) * step;
      this.sub += (f.sub - this.sub) * step;
    }

    // The rise is measured against the frames *before* this one: a spike that
    // was allowed into its own reference would flatten itself.
    if (onsetStrength > 0) {
      const average = this.fluxes.mean(f.t - FLUX_WINDOW_SEC, f.t);
      if (average > 0) this.rises.push(f.flux / average);
    }

    this.centroids.push(f.t, f.centroid);
    this.fluxes.push(f.t, f.flux);
    this.lastT = f.t;
  }

  brightness(): number {
    return this.bright;
  }

  noisiness(): number {
    return this.noise;
  }

  subWeight(): number {
    return this.sub;
  }

  /** Staccato or legato, from how far the onsets rise above the ordinary. */
  attack(): Attack {
    if (this.rises.length === 0) return 'mixed';
    const mean = this.rises.mean();
    if (mean > ATTACK_SHARP) return 'sharp';
    if (mean < ATTACK_SOFT) return 'soft';
    return 'mixed';
  }

  /** -1..1: a riser climbs toward 1, a filter sweep down falls toward -1. */
  centroidSlope(): number {
    const now = this.lastT;
    const recent = this.centroids.mean(now - SLOPE_RECENT_SEC, now);
    const before = this.centroids.mean(now - SLOPE_PAST_SEC, now - SLOPE_RECENT_SEC);
    if (this.centroids.countIn(now - SLOPE_PAST_SEC, now - SLOPE_RECENT_SEC) === 0) return 0;
    return clamp((recent - before) / SLOPE_FULL_HZ, -1, 1);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

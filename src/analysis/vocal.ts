/**
 * Is somebody singing, and is it hurting?
 *
 * Two features, opposite ends of one axis, and both of them things a listener
 * reacts to before they could name them. A voice entering is the moment a
 * track acquires a protagonist — every mix in the world makes room for it, and
 * a visualizer that does not notice is looking at the wrong thing. A scream,
 * a distorted guitar, a saturated snare roll is the other pole: the moment the
 * music stops being pleasant on purpose.
 *
 * Neither is a judgment. Jev makes those; these are the measurements it is
 * shown, and they are deliberately shallow:
 *
 * - **vocal** is the product of two independent readings taken in
 *   `FeatureExtractor`: how much of the mid-band energy belongs to a single
 *   harmonic series (`pitch`), and how much of it sits in the 1-3 kHz formant
 *   region (`formant`). Either alone is ambiguous — a cello is harmonic, a
 *   hi-hat is full of 1-3 kHz — and the product is not: a sound that is both
 *   is a throat. It is then smoothed over half a second, because a voice is a
 *   thing that is *present*, not a thing that happens on one frame — and
 *   halved when the fundamental under it never moves, because that is a
 *   synthesizer holding a note rather than a person singing one.
 * - **harsh** is loudness, brightness and noisiness read together, and then
 *   halved unless the music is actually striking. The discount is what stops a
 *   loud bright pad — a supersaw, a cymbal wash, an orchestral swell — from
 *   reading as aggression: harshness is an attack, and something that arrives
 *   smoothly is not one, however much high end it has.
 *
 * Pure: frames and readings in, numbers out. No clock of its own.
 */

import { TimedRing } from './ring';
import type { Attack, FrameFeatures } from '../shared/types';

/**
 * The pitch salience and formant share a fully vocal frame is credited with.
 *
 * Both are calibrated rather than assumed, against the synthesized vowels in
 * `tests/helpers/synth.ts`. A sung vowel measures 0.31-0.98 salience depending
 * on where its fundamental sits relative to the formants — a low note puts its
 * first three harmonics *below* the resonance that is lifting the rest — and
 * 0.10-0.21 formant share. A sawtooth chord, three harmonic series at once
 * with nothing above 1.5 kHz, measures 0.47 and 0.04; white noise measures
 * 0.06 and 0.26. So the salience knee sits where a chord already saturates it
 * (a pad is pitched; that is not the question being asked) and the formant
 * knee where a chord is nowhere near — which is what makes the *product* the
 * discriminating thing rather than either factor.
 */
const PITCH_FULL = 0.45;
const FORMANT_FULL = 0.14;

/** How long `vocal` takes to follow a change, as a time constant. */
const VOCAL_TAU_SEC = 0.5;
/** A tab left in the background must not be smoothed through. */
const MAX_DT = 1;

/**
 * How long the fundamental is watched, and how still it has to hold to be a
 * machine rather than a throat.
 *
 * The first real track this ran on called a synth lead a voice: a saw wave
 * through a formant-ish filter is harmonic and has energy at 1-3 kHz, which is
 * both halves of the measurement above. What it does not have is a *body*. A
 * sung note is held by muscles that cannot hold anything perfectly — a singer's
 * vibrato is around half a percent either way, and even a deliberately flat
 * note drifts several times that — while an oscillator is given a number and
 * sits on it. So half a second of fundamentals with a relative standard
 * deviation under 0.2% is not a voice, and the reading is halved rather than
 * zeroed: it is evidence, not proof, and a vocoder is a real case.
 *
 * 0.5 s is the same window the smoothing uses, and for the same reason:
 * shorter than a phrase, longer than a note's attack.
 */
const STABILITY_WINDOW_SEC = 0.5;
const STABLE_REL_STD = 0.002;
/** What is left of `vocal` when the fundamental never moves. */
const STATIC_PITCH_DISCOUNT = 0.5;
/**
 * The least of that window that has to be filled before stillness means
 * anything. Three frames of a note are three frames of a note; only a span
 * long enough to hold a vibrato cycle can say one is missing.
 */
const MIN_STABILITY_SPAN_SEC = 0.4;
const MIN_STABILITY_SAMPLES = 8;
/** Frames in the window at any plausible rate, with room to spare. */
const F0_HISTORY = 128;

/** How `harsh` weights its three readings, as the plan specifies. */
const W_BRIGHT = 0.4;
const W_FLATNESS = 0.3;
const W_LOUD = 0.3;
/** What is left of harshness when the music is not striking sharply. */
const SOFT_ATTACK_DISCOUNT = 0.6;

/**
 * The raw, unsmoothed vocal reading of one frame: both factors scaled to their
 * knee and multiplied.
 */
export function vocalOfFrame(f: FrameFeatures): number {
  const pitch = clamp(f.pitch / PITCH_FULL, 0, 1);
  const formant = clamp(f.formant / FORMANT_FULL, 0, 1);
  return pitch * formant;
}

/**
 * `vocal` over time: the frame reading, one-pole smoothed with a half-second
 * time constant.
 *
 * The first frame seeds the value rather than sliding up from zero, exactly as
 * `TimbreTracker` does: the alternative is a detector that reports "no voice"
 * for the first half second of every track, which is a lie about the music
 * rather than a lag in the measurement.
 */
export class VocalDetector {
  private value = 0;
  private started = false;
  /** The fundamentals of the recent past, for the stability discount. */
  private readonly f0s = new TimedRing(F0_HISTORY);
  /** The newest frame's instant, which the window is measured back from. */
  private now = 0;

  /** One frame and the seconds since the previous one. */
  push(f: FrameFeatures, dt: number): void {
    this.now = f.t;
    // An unpitched frame is not a still one: it ends the run rather than
    // extending it, which is what keeps a silence between two held notes from
    // reading as one very steady note.
    if (f.f0 > 0) this.f0s.push(f.t, f.f0);
    else this.f0s.clear();

    const target = vocalOfFrame(f);
    if (!this.started) {
      this.started = true;
      this.value = target;
      return;
    }
    const step = 1 - Math.exp(-Math.min(MAX_DT, Math.max(0, dt)) / VOCAL_TAU_SEC);
    this.value += (target - this.value) * step;
  }

  /** 0..1: how much of a voice is present. 0 before the first frame. */
  score(): number {
    return this.staticPitch() ? this.value * STATIC_PITCH_DISCOUNT : this.value;
  }

  /**
   * Whether the fundamental has held too still over the window to be a throat.
   * False whenever there is not enough of a window to say so.
   */
  private staticPitch(): boolean {
    const from = this.now - STABILITY_WINDOW_SEC;
    const start = this.f0s.indexAtOrAfter(from);
    const n = this.f0s.length - start;
    if (n < MIN_STABILITY_SAMPLES) return false;
    if (this.f0s.timeAt(this.f0s.length - 1) - this.f0s.timeAt(start) < MIN_STABILITY_SPAN_SEC) {
      return false;
    }

    const mean = this.f0s.mean(from, this.now);
    if (!(mean > 0)) return false;
    let sum = 0;
    for (let i = start; i < this.f0s.length; i++) {
      const d = this.f0s.valueAt(i) - mean;
      sum += d * d;
    }
    return Math.sqrt(sum / n) / mean < STABLE_REL_STD;
  }
}

export interface HarshReadings {
  /** 0 dark..1 bright, from the timbre tracker. */
  bright: number;
  /** 0 tonal..1 noisy — smoothed spectral flatness. */
  flatness: number;
  /** Where the present sits in the session's own loudness range, 0..1. */
  loudRel: number;
  /** How sharply the music is striking. */
  attack: Attack;
}

/**
 * 0..1: how abrasive this is.
 *
 * The three readings are weighted as the plan specifies, and the whole thing
 * is cut to 60% when the attack is anything but `sharp`. That discount is the
 * only non-linear part and it is doing all the work: brightness, noisiness and
 * loudness describe a cymbal wash as well as they describe a scream, and the
 * attack is what tells them apart.
 */
export function harshness(o: HarshReadings): number {
  const raw =
    W_BRIGHT * clamp(o.bright, 0, 1) +
    W_FLATNESS * clamp(o.flatness, 0, 1) +
    W_LOUD * clamp(o.loudRel, 0, 1);
  return clamp(o.attack === 'sharp' ? raw : raw * SOFT_ATTACK_DISCOUNT, 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Is this talking rather than music?
 *
 * Speech has a signature no instrument quite shares. Syllables arrive three to
 * six times a second, so the loudness envelope has a broad hump there. A
 * speaker stops to breathe and to think, so the envelope has *holes* in it —
 * short ones, several a sentence, and music has none. The pitch of a spoken
 * sentence wanders continuously over an octave instead of stepping between
 * held notes. The spectral centroid sits in the 1-3 kHz formant region, and
 * the alternation of voiced and unvoiced sounds makes the zero crossing rate
 * swing about. Six weak cues, combined, are worth more than any one of them.
 *
 * ## What the first real talk taught this file
 *
 * Every constant below was calibrated twice: once against the synthetic AM
 * noise in `tests/helpers/synth.ts`, and then again against four minutes of a
 * TED talk and a minute each of Slipknot, *Levels*, *SICKO MODE*, a Gymnopédie
 * and an Eno pad, with `scripts/calibrate/probe-features.ts`. The second pass
 * is what moved them. The old detector reported 0.35 on the talk and 0.28-0.29
 * on the music, which is not a detector; it now reports 0.58 and 0.12-0.20.
 * Three things were wrong and all three were wrong in the same direction:
 *
 * - **The beat grid locks onto speech.** On the talk, `beatConf` reads 1.00
 *   from about thirty seconds in — syllables are periodic enough for an
 *   autocorrelation to find a tempo in them. The old score handed a confident
 *   beat a veto: it took away 70% of the modulation cue and all of the
 *   "there is no beat" cue, which capped a talk at 0.47 whatever else it did.
 *   What separates the talk from the music is not the confidence but the
 *   *regularity*: the grid is sure of a period nothing is actually playing on.
 *   So the beat's veto now runs on `beatTrust` — confidence tempered by how
 *   regular the rhythm under it is — and a confident grid over an irregular
 *   rhythm is worth about a quarter of what a confident grid over a groove is.
 * - **The modulation ratio was measured on a linear envelope**, which is a
 *   measurement of the vowels only: a linear envelope's energy is all in the
 *   loud parts, and the gaps between words — the thing that makes speech
 *   speech — contribute almost nothing to the transform. It is taken on the
 *   *log* envelope now, where a pause is as big an excursion as a shout, and
 *   the band is 2.5-8 Hz over 0.5-20 Hz rather than 3-6 over 0.5-15, because a
 *   real speaker's syllable rate is not as tidy as a synthesizer's.
 * - **The cue that settles it was missing.** `pauseRatio` is new and it is
 *   what actually carries the answer: a speaker breathes and a mixed record
 *   does not. It is the heaviest term *and* a gate on all the others, because
 *   measured over five real tracks it is the only one of the six that
 *   separates them at all. See its own comment.
 *
 * ## The cue that was measured and not used
 *
 * `pitchVariation` is here, is pure, is tested, and carries no weight in the
 * score. It was added on the theory that a spoken sentence's fundamental
 * wanders where a sung note is held, which is true of a voice on its own and
 * is not measurable through a mix: the frame-level `f0` is the best fundamental
 * the harmonic sum could find in 100-1000 Hz, and over a polyphonic second
 * that number wanders for every kind of music alike. Measured over one minute,
 * with and without a salience gate, it reads 0.99 on *Levels*, 0.92 on an
 * ambient pad, 0.79 on metal and 0.83 on the talk — a constant with noise on
 * it. It is published on the snapshot because the probe prints it and because
 * the next attempt at a pitch cue should start from the measurement rather
 * than from the theory, and it is weighted at nothing because a term that is
 * the same for every input is an offset, not a feature.
 *
 * Pure: numbers and frames in, numbers out. No clock of its own.
 */

import type { FrameFeatures } from '../shared/types';
import { TimedRing } from './ring';

/** The grid the envelope is resampled onto, and how much of it is used. */
const ENVELOPE_RATE = 50;
const ENVELOPE_SECONDS = 4;
const ENVELOPE_POINTS = ENVELOPE_RATE * ENVELOPE_SECONDS; // 200

/**
 * The syllabic band, and the band it is measured as a share of.
 *
 * 2.5-8 Hz rather than the 3-6 the first cut used. A speaker's syllable rate
 * is not one number: an unhurried sentence runs near 3 Hz and an excited one
 * past 7, and the *same* speaker crosses both inside a paragraph. Measured on
 * the talk, widening the band moved the cue from 0.34 to 0.55 and moved
 * *Levels* by 0.02, because a four-on-the-floor's modulation is a line at the
 * beat and its harmonics rather than a hump anywhere.
 */
const SYLLABLE_LO_HZ = 2.5;
const SYLLABLE_HI_HZ = 8;
const MODULATION_LO_HZ = 0.5;
const MODULATION_HI_HZ = 20;

/**
 * The floor the log envelope is taken above, in dB below full scale.
 *
 * The transform is taken on `20·log10(rms)` rather than on `rms`, so that the
 * holes in the envelope count for as much as the peaks — which is the whole
 * point when the feature being measured is "does this stop several times a
 * second". A floor is needed because the log of a digital silence is minus
 * infinity, and one such sample would be the entire spectrum. 60 dB of range
 * is more than any speaker uses within a sentence.
 */
const ENVELOPE_FLOOR_DB = -60;

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

/* ------------------------------------------------------------ pause ratio */

/**
 * How long a hole has to be to be a pause, how far below the passage it has to
 * sit, and how much of a window has to be holes for the cue to saturate.
 *
 * This is the cue that actually separates a talk from a record, and it is the
 * simplest one here. A speaker breathes: between phrases the level drops to
 * the room, ten to twenty decibels down, for a third of a second at a time,
 * several times in any four seconds. A mixed record does not do this even in
 * its quiet passages, because something is always sustaining — a reverb tail,
 * a pad, a ride cymbal — and a compressor is holding it up.
 *
 * Measured as a raw share of windows, at this depth: the talk 0.08-0.23 wherever
 * it is talking, *Levels* 0.000 in every window of a minute, *Duality* 0.000,
 * an Eno pad 0.000, and a Gymnopédie 0.000 except for the two windows over its
 * opening rests, which are real. `PAUSE_FULL` is set at 0.10 — below the
 * bottom of the talk's observed range — because the difference between a talk
 * and a record is the *presence* of holes, not how many: one measured hole in
 * four seconds already means a speaker, and counting further would only
 * measure how long their sentences are.
 */
const PAUSE_WINDOW_SEC = 0.3;
const PAUSE_DEPTH_DB = 15;
const PAUSE_FULL = 0.1;

/**
 * What is left of every other cue when there are no pauses at all.
 *
 * The pause ratio is not only the heaviest term, it is a *gate*. Measured over
 * the first minute of each of five real tracks, at this depth, it is exactly
 * 0.000 in every four-second window of *Levels*, of *Duality* and of an Eno
 * pad, 0.02 on a Gymnopédie, and 0.26-0.96 across a talk once the talking
 * starts. Nothing else here separates that cleanly — the centroid cue gives a
 * house record full marks because its centroid also sits at 1.4 kHz, and the
 * modulation ratio is within 0.05 of the talk's on every track measured.
 *
 * So the other four cues are scaled by `PAUSE_GATE_FLOOR + (1 − floor)·pause`:
 * a passage that never stops is allowed two thirds of what its cues would
 * otherwise say, and no more. Two thirds rather than something smaller because
 * a speaker being listened to in silence, over a compressed broadcast mix,
 * genuinely does produce stretches with no measurable holes — the talk's first
 * twenty-four seconds are one — and a detector that called those seconds music
 * would flicker between two scenes inside one sentence. Measured, the floor is
 * what the music tracks are actually reading: 0.20 on *Duality*, 0.14 on
 * *Levels*, 0.12 on the Gymnopédie and the Eno, against 0.58 on the talk.
 */
const PAUSE_GATE_FLOOR = 0.66;

/* ------------------------------------------------------ pitch variability */

/**
 * How long the fundamental is watched, the spread that counts as full marks,
 * and how much of the window has to be pitched for the answer to mean
 * anything.
 *
 * A sung note is *held*: a singer picks a pitch, sits on it for a beat or
 * more, and steps to the next one. A spoken sentence has no notes at all — the
 * fundamental slides continuously through its whole range and the unvoiced
 * consonants between the vowels throw it further. Over one second a singer's
 * f0 has a standard deviation of well under a semitone inside a note and two
 * or three across a phrase; a speaker's is four and up.
 *
 * Measured in semitones rather than in hertz so that a bass and a soprano
 * saying the same sentence measure the same thing.
 */
const PITCH_WINDOW_SEC = 1;
const PITCH_VAR_FULL_SEMITONES = 4;
const MIN_PITCH_SAMPLES = 10;
/**
 * The harmonic salience a frame needs before its fundamental is believed.
 *
 * Without this the cue measures nothing. Unpitched frames still carry a *best*
 * fundamental — whatever in 100-1000 Hz the harmonic sum liked most — and on a
 * drum-led mix that number is noise, so the spread over a second saturates for
 * every track alike: measured, 0.99 on *Levels*, 0.92 on an Eno pad and 0.94
 * on the talk, which is a constant, not a feature. Gated, the question becomes
 * the one worth asking: *of the frames that really are a note, does the note
 * move*. 0.3 is where `features.ts` puts a sung vowel's floor.
 */
const PITCH_SALIENCE_MIN = 0.3;

/* ------------------------------------------------------------ beat, notch */

/**
 * Beat confidence at which the beat's own harmonics are notched out of the
 * modulation spectrum, and how wide each notch is.
 *
 * A beat is a pulse train, a pulse train has harmonics, and 128 BPM is 2.13 Hz
 * whose second and third harmonics are 4.3 and 6.4 Hz — inside the syllabic
 * band, by arithmetic, on every dance record ever made. So the detector is
 * told where the beat is and takes those harmonics out of the measurement
 * before it makes it.
 *
 * The width is a little over the 0.25 Hz the 200-point transform resolves, so
 * a harmonic that has drifted a bin either way — a beat that is not exactly
 * where the grid put it, which is every real beat — is still inside it.
 */
const NOTCH_CONFIDENCE = 0.5;
const NOTCH_HALF_WIDTH_HZ = 0.35;
/** The highest harmonic of the beat that is notched out. */
const NOTCH_HARMONICS = 4;

/**
 * How much of a confident grid survives an irregular rhythm.
 *
 * `beatConf` answers "did an autocorrelation find a period", which speech
 * obliges with; `regular` answers "do the onsets keep landing on it", which
 * speech does not. The talk reads confidence 1.00 against regularity 0.00 for
 * its entire second half. So the number the veto is spent against is
 * `confidence · (BEAT_TRUST_FLOOR + (1 − floor) · regular)`: a confident grid
 * over nothing regular is worth a fifth of a confident grid over a groove, and
 * a grid that is not confident is still worth nothing whatever the regularity.
 *
 * Not zero, because a genuinely metrical passage can read low regularity for a
 * bar or two — a fill, a stop — and a detector that decided those bars were
 * speech would flicker.
 */
const BEAT_TRUST_FLOOR = 0.2;

/**
 * How much of the modulation cue a fully trusted beat takes away.
 *
 * The notch removes the beat's own lines; this covers what a notch cannot —
 * the swing, the shuffle and the sixteenths that smear a real groove's
 * modulation across the whole band. Music the grid is certain about keeps
 * three tenths of the cue, which is enough for a spoken word over a loop to
 * still out-score the loop, and not enough for the loop to reach the score a
 * voice does.
 */
const BEAT_DISCOUNT = 0.7;

/**
 * How the five cues are weighted.
 *
 * The pause ratio carries nearly three fifths, because it is the only one that
 * was measured to separate a talk from a record. The rest are corroboration
 * and are weighted by how much they were measured to be worth: the modulation
 * ratio, which used to be the centrepiece, lands within 0.05 of the talk's
 * value on every music track tried, and the centroid cue gives a house record
 * full marks because a house record's centroid also sits at 1.4 kHz. They are
 * kept because they cost nothing and because each of them fails on a different
 * kind of music, not because any of them would do on its own.
 */
const W_MODULATION = 0.08;
const W_PAUSE = 0.58;
const W_CENTROID = 0.14;
const W_ZCR = 0.04;
const W_NO_BEAT = 0.16;

/** A 200-point DFT is not free; this often is often enough. */
const CACHE_SEC = 0.1;

/** Eight seconds of frames at up to 200 a second. */
const CAPACITY = 8 * 200;

/**
 * `cos` and `sin` of every angle the 200-point DFT can ask for. The transform
 * touches 200 samples in each of 79 bins and this runs inside the render loop,
 * so the sixteen thousand pairs of trig calls are worth turning into two array
 * reads. `k·n mod 200` covers every distinct angle.
 */
const TWIDDLE_COS = new Float64Array(ENVELOPE_POINTS);
const TWIDDLE_SIN = new Float64Array(ENVELOPE_POINTS);
for (let m = 0; m < ENVELOPE_POINTS; m++) {
  TWIDDLE_COS[m] = Math.cos((-2 * Math.PI * m) / ENVELOPE_POINTS);
  TWIDDLE_SIN[m] = Math.sin((-2 * Math.PI * m) / ENVELOPE_POINTS);
}

/* ------------------------------------------------------- the pure features */

/**
 * 0..1: how much of this stretch of envelope is holes.
 *
 * `envelopeDb` is a uniformly sampled loudness envelope in dB, `rate` its
 * sample rate. The reference is the *median* of the whole stretch rather than
 * its mean, because a mean is dragged down by the very holes being counted and
 * a passage with many pauses would then find none.
 *
 * The answer is the share of `PAUSE_WINDOW_SEC` windows whose mean sits
 * `PAUSE_DEPTH_DB` below that median, scaled so that `PAUSE_FULL` reads 1.
 * Exported and pure so it can be held against a fixture directly.
 */
export function pauseRatio(envelopeDb: ArrayLike<number>, rate: number): number {
  const n = envelopeDb.length;
  const per = Math.max(1, Math.round(PAUSE_WINDOW_SEC * rate));
  if (n < per * 2 || !(rate > 0)) return 0;

  const sorted = Array.from({ length: n }, (_, i) => envelopeDb[i] ?? 0).sort((a, b) => a - b);
  const median = sorted[n >> 1] ?? 0;
  const floor = median - PAUSE_DEPTH_DB;

  let windows = 0;
  let quiet = 0;
  for (let i = 0; i + per <= n; i += per) {
    let sum = 0;
    for (let j = 0; j < per; j++) sum += envelopeDb[i + j] ?? 0;
    windows += 1;
    if (sum / per < floor) quiet += 1;
  }
  if (windows === 0) return 0;
  return clamp(quiet / windows / PAUSE_FULL, 0, 1);
}

/**
 * 0..1: how far the fundamental wanders, as a share of a speaker's spread.
 *
 * `f0s` are fundamentals in Hz; anything at or below zero is an unpitched
 * frame and is left out rather than counted as a very low note. The spread is
 * the standard deviation of the pitches in semitones, so the answer does not
 * depend on the register the voice sits in. Fewer than `MIN_PITCH_SAMPLES`
 * pitched frames is not a contour and reads 0.
 *
 * Exported and pure for the same reason as `pauseRatio`.
 */
export function pitchVariation(f0s: ArrayLike<number>): number {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < f0s.length; i++) {
    const f = f0s[i] ?? 0;
    if (f > 0) {
      sum += Math.log2(f) * 12;
      n += 1;
    }
  }
  if (n < MIN_PITCH_SAMPLES) return 0;

  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < f0s.length; i++) {
    const f = f0s[i] ?? 0;
    if (f > 0) {
      const d = Math.log2(f) * 12 - mean;
      variance += d * d;
    }
  }
  return clamp(Math.sqrt(variance / n) / PITCH_VAR_FULL_SEMITONES, 0, 1);
}

/**
 * How much of a confident beat survives an irregular rhythm, 0..1.
 *
 * Exported because two other readings — the score below and anything
 * downstream that wants to know whether the grid is describing real metre —
 * have to agree about it.
 */
export function beatTrust(confidence: number, regular: number): number {
  const c = clamp(confidence, 0, 1);
  return c * (BEAT_TRUST_FLOOR + (1 - BEAT_TRUST_FLOOR) * clamp(regular, 0, 1));
}

/* ------------------------------------------------------------- the tracker */

export class SpeechDetector {
  /**
   * Four histories of the same length, written in lockstep by `push`, so an
   * index found in one is the same frame in the others. That is what lets the
   * rms history decide which frames the centroid and zcr statistics may use.
   */
  private readonly rmsHistory = new TimedRing(CAPACITY);
  private readonly centroids = new TimedRing(CAPACITY);
  private readonly zcrs = new TimedRing(CAPACITY);
  private readonly f0s = new TimedRing(CAPACITY);
  private lastT = 0;
  private any = false;

  /** The resampled envelope, in dB, and whether this frame's is current. */
  private readonly grid = new Float64Array(ENVELOPE_POINTS);
  private gridAt = -Infinity;
  private gridReady = false;

  private cachedAt = -Infinity;
  /** The modulation cue, and the beat that was notched out of it. */
  private cachedMod = 0;
  private cachedNotchHz = 0;
  /** The four cues that do not depend on the beat at all. */
  private cachedRest = 0;
  private cachedPause = 0;
  private cachedPitchVar = 0;

  push(rms: number, t: number, f: FrameFeatures): void {
    this.rmsHistory.push(t, Math.max(0, rms));
    this.centroids.push(t, f.centroid);
    this.zcrs.push(t, f.zcr);
    // Gated on salience: an unpitched frame's `f0` is the noise floor's
    // favourite bin, and counting it would make every track's contour wander.
    this.f0s.push(t, f.pitch >= PITCH_SALIENCE_MIN ? f.f0 : 0);
    this.lastT = t;
    this.any = true;
  }

  /**
   * 0..1. `beatConfidence` is the beat grid's, `beatHz` is the beat it is that
   * sure of in beats per second (0 when there is no grid to ask), and
   * `regular` is how regularly the onsets actually land on it.
   *
   * The three do different jobs. `beatHz` only matters once `beatConfidence`
   * clears `NOTCH_CONFIDENCE`: that is what tells the notch where to cut the
   * beat and its harmonics out of the modulation spectrum. `beatConfidence`
   * and `regular` together make `beatTrust`, which is what both the discount
   * on the modulation cue and the "there is no beat" cue are spent against.
   * Told nothing — all three 0 — it behaves as a detector with no grid to ask.
   */
  score(beatConfidence: number, beatHz = 0, regular = 0): number {
    if (!this.any) return 0;
    const trust = beatTrust(beatConfidence, regular);
    const notchHz =
      clamp(beatConfidence, 0, 1) >= NOTCH_CONFIDENCE && beatHz > 0 ? beatHz : 0;

    this.refresh(notchHz);
    const cues =
      W_MODULATION * this.cachedMod * (1 - BEAT_DISCOUNT * trust) +
      W_PAUSE * this.cachedPause +
      this.cachedRest +
      W_NO_BEAT * (1 - trust);
    const gate = PAUSE_GATE_FLOOR + (1 - PAUSE_GATE_FLOOR) * this.cachedPause;
    return clamp(cues * gate, 0, 1);
  }

  /**
   * 0..1: how much of the last four seconds is holes, as the score reads it.
   *
   * Published because the model is shown it: "speech ≥ 0.5 with a pause ratio
   * ≥ 0.15" is a sentence a rubric can use and "speech 0.62" is not. Reads the
   * same cache the score does, so asking for both costs one transform.
   */
  pause(): number {
    if (!this.any) return 0;
    this.refresh(this.cachedNotchHz);
    return this.cachedPause;
  }

  /** 0..1: how far the fundamental wandered over the last second. */
  pitchVar(): number {
    if (!this.any) return 0;
    this.refresh(this.cachedNotchHz);
    return this.cachedPitchVar;
  }

  /** Recompute the cues, at most every `CACHE_SEC` and on a new notch. */
  private refresh(notchHz: number): void {
    if (this.lastT - this.cachedAt < CACHE_SEC && notchHz === this.cachedNotchHz) return;
    this.cachedAt = this.lastT;
    this.cachedNotchHz = notchHz;
    this.gridAt = -Infinity;

    this.cachedMod = this.modulationRatio(notchHz);
    this.cachedPause = this.resample() === null ? 0 : pauseRatio(this.grid, ENVELOPE_RATE);
    this.cachedPitchVar = pitchVariation(this.recentF0s());
    this.cachedRest = W_CENTROID * this.centroidMid() + W_ZCR * this.zcrVariation();
  }

  /**
   * Share of the log envelope's modulation energy that sits at syllable rate,
   * with the bins around `notchHz` and its harmonics left out of both the
   * share and the total. `notchHz` of 0 notches nothing.
   */
  private modulationRatio(notchHz: number): number {
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
      if (isBeatHarmonic(k * perBin, notchHz)) continue;
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

    return all > 0 ? clamp(syllable / all, 0, 1) : 0;
  }

  /**
   * The rms history as a dB envelope on the fixed 50 Hz grid, or null when
   * four seconds of it have not gone by yet. Linear interpolation between the
   * frames either side, and the log taken after the interpolation so that the
   * grid is a resampling of the signal rather than of its logarithm.
   */
  private resample(): Float64Array | null {
    if (this.gridAt === this.lastT) return this.gridReady ? this.grid : null;
    this.gridAt = this.lastT;
    this.gridReady = false;

    const from = this.lastT - ENVELOPE_SECONDS;
    if (this.rmsHistory.length < 2 || this.rmsHistory.startTime() > from) return null;

    let read = this.rmsHistory.indexAtOrAfter(from);
    if (read > 0) read -= 1;

    for (let i = 0; i < ENVELOPE_POINTS; i++) {
      const t = from + i / ENVELOPE_RATE;
      while (read + 1 < this.rmsHistory.length && this.rmsHistory.timeAt(read + 1) <= t) read += 1;

      const t0 = this.rmsHistory.timeAt(read);
      let rms: number;
      if (read + 1 >= this.rmsHistory.length) {
        rms = this.rmsHistory.valueAt(read);
      } else {
        const t1 = this.rmsHistory.timeAt(read + 1);
        const span = t1 - t0;
        const w = span > 0 ? clamp((t - t0) / span, 0, 1) : 0;
        rms = this.rmsHistory.valueAt(read) * (1 - w) + this.rmsHistory.valueAt(read + 1) * w;
      }
      this.grid[i] = Math.max(ENVELOPE_FLOOR_DB, 20 * Math.log10(Math.max(rms, 1e-12)));
    }
    this.gridReady = true;
    return this.grid;
  }

  /** The fundamentals of the last `PITCH_WINDOW_SEC`, oldest first. */
  private recentF0s(): number[] {
    const start = this.f0s.indexAtOrAfter(this.lastT - PITCH_WINDOW_SEC);
    const out: number[] = [];
    for (let i = start; i < this.f0s.length; i++) out.push(this.f0s.valueAt(i));
    return out;
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

/**
 * Whether `hz` is within a notch of the beat or one of its first few
 * harmonics. False for every frequency when `beatHz` is 0.
 */
function isBeatHarmonic(hz: number, beatHz: number): boolean {
  if (!(beatHz > 0)) return false;
  for (let n = 1; n <= NOTCH_HARMONICS; n++) {
    if (Math.abs(hz - n * beatHz) <= NOTCH_HALF_WIDTH_HZ) return true;
  }
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

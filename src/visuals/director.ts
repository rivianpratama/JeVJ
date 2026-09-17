/**
 * The director: what the music feels like → what the renderer should do.
 *
 * This is the only place that decides anything about the look. The scenes and
 * the passes are dumb — they take numbers and draw — and the mood layer knows
 * nothing about rendering. Everything in between is here, as formulas, so that
 * the whole visual language of the app can be read in one file and tested in
 * Node without a GPU.
 *
 * Two rules shape the whole thing:
 *
 *  - **Slew, don't cut.** Every slow scalar moves toward its target with a
 *    0.8 s time constant. Jev answers arrive seconds apart and land as steps;
 *    without the slew the picture would snap on every answer. What must *not*
 *    be slewed is anything driven by `impact`, because a hit that arrives
 *    smoothed is not a hit.
 *  - **Never strobe.** Exposure is the one parameter that can flash the whole
 *    screen, so its *direction* is rate-limited: the luminance may not reverse
 *    more than three times a second however hard the music alternates. A
 *    frame-alternating impact would otherwise drive a 30 Hz flash.
 *
 * Pure: no three.js, no DOM. What state it does need — the strobe limiter's
 * clock, the slewed chroma base, the held fold count — lives in a
 * `DirectorState` the caller owns, so two directors on one page cannot tread
 * on each other and a test cannot inherit the last test's clock. The state
 * restarts whenever `direct` is called with `prev === null`.
 */

import { paletteFor, type Palette } from './palette';
import { GENRES, MOTIONS, SECTIONS } from '../shared/types';
import type { Genre, Motion, MoodVector, Section } from '../shared/types';

/** What the renderer needs to know about *this* frame of audio. */
export interface FastFrame {
  rms: number;
  bands: Float32Array;
  sub: number;
  onset: number;
  beatPhase: number;
  /** 1 on a downbeat, decaying with τ = 0.3 s. */
  downbeatPulse: number;
  impact: number;
  build: number;
}

export interface RenderParams {
  /** How much of each scene is in the mix; sums to 1. */
  weights: { ink: number; particles: number; strands: number; relief: number; breath: number };
  palette: Palette;

  // ink
  flowAmt: number;
  decay: number;
  turbulence: number;
  injectGain: number;
  pushKick: number;

  // particles (Task 10)
  /** World units per second the dust travels at full tilt. */
  particleSpeed: number;
  /** Scales the impact kick and the onset scatter; halved under reduced motion. */
  particleImpulse: number;
  attractor: 'sphere' | 'plane' | 'vortex' | 'explode' | 'swarm';
  /** The shell the sphere attractor pulls toward; breathes on a pulse. */
  attractorRadius: number;
  /** How hard the attractor pulls. Below 1 only for the bloom's soft burst. */
  attractorForce: number;
  /** Point sprite size in CSS pixels, before the device pixel ratio. */
  pointSize: number;
  /** How far an impact snaps the camera out. 0 under reduced motion. */
  dollySnap: number;

  // strands (Task 10)
  strandBend: number;
  strandThickness: number;

  // relief (Task 11)
  reliefHeight: number;
  reliefContrast: number;

  // post
  bloomStrength: number;
  bloomThreshold: number;
  chroma: number;
  /** Color levels; 0 is off. */
  posterize: number;
  /** Kaleidoscope folds; 0 is off. */
  mirrorFolds: number;
  grain: number;
  vignette: number;
  exposure: number;

  flowStyle: Motion;
}

/** Seconds for a slewed scalar to cover ~63% of the distance to its target. */
const SLEW_TAU = 0.8;
/** The strobe cap: at most three luminance reversals a second. */
const MIN_FLIP_SEC = 1 / 3;
/** Exposure moves smaller than this do not count as a direction. */
const FLIP_EPS = 1e-4;
/** Reduced motion never lets the screen get brighter than this. */
const REDUCED_MAX_EXPOSURE = 1.1;
/** The kaleidoscope's range, when it is on at all. */
const MIN_FOLDS = 2;
const MAX_FOLDS = 6;
/** How long a different fold count has to be wanted before it is taken. */
const FOLD_HOLD_SEC = 0.5;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function leaning<K extends string>(keys: readonly K[], chosen: K, p = 0.6): Record<K, number> {
  const rest = (1 - p) / (keys.length - 1);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = k === chosen ? p : rest;
  return out;
}

/**
 * What the page believes before it has heard anything: calm, spacious, a touch
 * bright, drifting. Not neutral — neutral would sit at arousal 0.5 and pulse
 * at a page that has no music.
 */
export const IDLE_MOOD: MoodVector = {
  valence: 0.55,
  arousal: 0.3,
  tension: 0.3,
  warmth: 0.15,
  synthetic: 0.5,
  space: 0.7,
  aggression: 0.1,
  melancholy: 0.1,
  hypnotic: 0.1,
  euphoricPeak: 0.1,
  spoken: 0.1,
  genre: 'ambient_drone' satisfies Genre,
  genreP: leaning(GENRES, 'ambient_drone'),
  section: 'intro' satisfies Section,
  sectionP: leaning(SECTIONS, 'intro'),
  motion: 'drift' satisfies Motion,
  motionP: leaning(MOTIONS, 'drift'),
  dropImminent: 0,
  beatsToChange: 'none',
  impact: 0,
  preDropStyle: 'none',
  confidence: 0,
};

/** Which particle attractor each motion label implies. */
const ATTRACTOR: Record<Motion, RenderParams['attractor']> = {
  flow: 'plane',
  pulse: 'sphere',
  shatter: 'explode',
  drift: 'plane',
  swarm: 'swarm',
  bloom: 'vortex',
};

/** The ink is always under everything; the other layers are mixed on top of it. */
const INK_BED = 0.55;
/** The shell the sphere attractor gathers onto. */
const SHELL_RADIUS = 1.2;
/** How far a pulse breathes that shell, per beat. */
const SHELL_BREATH = 0.25;
/** A bloom's burst, as a fraction of a real explosion. */
const BLOOM_FORCE = 0.35;
/** How much of a downbeat pulse is still "on the downbeat". */
const BLOOM_GATE = 0.5;
/** How far an impact snaps the particle camera out. */
const DOLLY_SNAP = 0.8;

/**
 * Everything `direct` has to remember between frames and cannot read back off
 * the previous `RenderParams`.
 */
export interface DirectorState {
  /** Seconds since this director started; the strobe limiter's only clock. */
  clock: number;
  lastFlipAt: number;
  lastDir: number;
  /**
   * The slewed *base* of chroma, kept aside because `RenderParams.chroma` is
   * the base plus an instant impact term and the two cannot be told apart
   * again from the previous frame's total.
   */
  heldChromaBase: number;
  /** The fold count actually in use, and the one waiting to replace it. */
  folds: number;
  pendingFolds: number;
  pendingFoldsSince: number;
}

/** A director that has never run. One per renderer. */
export function createDirector(): DirectorState {
  return {
    clock: 0,
    lastFlipAt: Number.NEGATIVE_INFINITY,
    lastDir: 0,
    heldChromaBase: 0,
    folds: 0,
    pendingFolds: 0,
    pendingFoldsSince: Number.NEGATIVE_INFINITY,
  };
}

/**
 * Hold `desired` back when taking it would reverse the screen's luminance
 * sooner than `MIN_FLIP_SEC` after the last reversal.
 */
function limitStrobe(s: DirectorState, desired: number, held: number): number {
  const delta = desired - held;
  const dir = Math.abs(delta) < FLIP_EPS ? 0 : Math.sign(delta);
  if (dir === 0) return held;
  if (s.lastDir !== 0 && dir !== s.lastDir && s.clock - s.lastFlipAt < MIN_FLIP_SEC) return held;
  if (dir !== s.lastDir) {
    s.lastFlipAt = s.clock;
    s.lastDir = dir;
  }
  return desired;
}

/**
 * The fold count, with a hand on it.
 *
 * `tension` wobbling across a rounding boundary would re-fold the entire
 * screen several times a second, which is the one thing a kaleidoscope must
 * not do — the figure is the point, and a figure that keeps changing its
 * symmetry is noise. A different count has to be wanted continuously for half
 * a second before it is taken.
 */
function holdFolds(s: DirectorState, target: number, fresh: boolean): number {
  if (fresh) {
    s.folds = target;
    s.pendingFolds = target;
    s.pendingFoldsSince = s.clock;
    return s.folds;
  }
  if (Math.abs(target - s.folds) < 1) {
    s.pendingFolds = s.folds;
    s.pendingFoldsSince = s.clock;
    return s.folds;
  }
  if (target !== s.pendingFolds) {
    s.pendingFolds = target;
    s.pendingFoldsSince = s.clock;
  } else if (s.clock - s.pendingFoldsSince >= FOLD_HOLD_SEC) {
    s.folds = target;
  }
  return s.folds;
}

export function direct(
  state: DirectorState,
  mood: MoodVector,
  fast: FastFrame,
  dt: number,
  prev: RenderParams | null,
  reducedMotion: boolean,
): RenderParams {
  const step = Math.max(0, Math.min(0.1, dt));
  if (prev === null) {
    state.clock = 0;
    state.lastFlipAt = Number.NEGATIVE_INFINITY;
    state.lastDir = 0;
  }
  state.clock += step;

  // One frame's worth of a first-order lag. With prev === null there is
  // nothing to lag from, so the first frame is the target.
  const k = prev === null ? 1 : 1 - Math.exp(-step / SLEW_TAU);
  const slew = (target: number, from: number): number => from + (target - from) * k;

  const arousal = clamp01(mood.arousal);
  const valence = clamp01(mood.valence);
  const tension = clamp01(mood.tension);
  const synthetic = clamp01(mood.synthetic);
  const hypnotic = clamp01(mood.hypnotic);
  const space = clamp01(mood.space);
  const impact = clamp01(fast.impact);
  const build = clamp01(fast.build);

  // The brief's `grain = lerp(0.02, 0.12, noise)` wants the *noisiness* of the
  // sound, which the mood vector does not carry as such: it is a fact about
  // the spectrum, not a judgment. The nearest judgment is "gritty and not
  // machine-made" — aggression, and the absence of synthetic — so that is what
  // stands in for it, and it lands in the same 0..1 range.
  const noise = clamp01(0.5 * clamp01(mood.aggression) + 0.5 * (1 - synthetic));

  // Ink.
  let flowAmtTarget = lerp(0.15, 0.9, arousal);
  const decayTarget = lerp(0.93, 0.985, clamp01(build * 0.6 + hypnotic * 0.4));
  const turbulenceTarget = lerp(0.1, 1.0, tension);
  const injectGainTarget = lerp(0.6, 1.6, arousal);
  // Impact-driven: a kick that has been slewed is not a kick.
  let pushKick = clamp01(fast.sub) * 0.02 + impact * 0.08;

  // Post.
  const bloomStrengthTarget = lerp(0.3, 1.4, arousal);
  const bloomThresholdTarget = lerp(0.85, 0.55, valence);
  const chromaBaseTarget = lerp(0, 0.012, synthetic * arousal);
  if (prev === null) state.heldChromaBase = chromaBaseTarget;
  else state.heldChromaBase += (chromaBaseTarget - state.heldChromaBase) * k;
  let chroma = state.heldChromaBase + impact * 0.02;
  // The floor is 0.03 rather than 0.02 because below that the grain is not
  // grain, it is a dither nobody can see — and an ungrained frame reads as
  // computer graphics however good the ink is.
  const grainTarget = lerp(0.03, 0.12, noise);
  const vignetteTarget = lerp(0.55, 0.2, space);

  // The acid look is reserved for hard electronic peaks; everywhere else it
  // would read as a bug.
  const posterize = synthetic > 0.7 && arousal > 0.7 ? 6 : 0;
  // Hypnotic only, and two to six folds. Eight folds read as sharp static
  // spokes rather than as a figure, and repetitive dance music that is not
  // hypnotic is not asking to be kaleidoscoped at all.
  const foldTarget = hypnotic >= 0.6 ? Math.round(lerp(MIN_FOLDS, MAX_FOLDS, tension)) : 0;
  let mirrorFolds = holdFolds(state, foldTarget, prev === null);

  // The mix.
  //
  // The ink is a constant bed and the other two layers are bid on top of it,
  // then the lot is normalised — so the *ratio* is what the formulas decide and
  // the total is always exactly one frame's worth of light. Particles want
  // energy and machines; strands want stillness and tension; both get out of
  // the way of a voice, because dust and silk over speech read as decoration
  // over a person talking.
  const spoken = clamp01(mood.spoken);
  const motion = mood.motion;
  let wParticles = arousal * (1 - spoken) * (0.6 + 0.4 * synthetic);
  let wStrands = (1 - arousal) * (0.5 + 0.5 * tension) * (1 - spoken);
  // The motion bonuses fade with speech too. Added flat they would put a
  // swarm's dust back over a talking voice at full strength, which is the one
  // thing the `(1 − spoken)` factors above exist to prevent.
  if (motion === 'swarm') wParticles += 0.3 * (1 - spoken);
  if (motion === 'drift') wStrands += 0.2 * (1 - spoken);
  const total = INK_BED + wParticles + wStrands;

  // Particles.
  let particleSpeed = lerp(0.2, 2.2, arousal);
  let particleImpulse = 1;
  let dollySnap = DOLLY_SNAP;
  // A bloom is a soft burst *on the downbeat* and a vortex the rest of the
  // time; it is the one motion whose attractor is not a constant.
  const blooming = motion === 'bloom' && clamp01(fast.downbeatPulse) >= BLOOM_GATE;
  const attractor = blooming ? 'explode' : ATTRACTOR[motion];
  const attractorForce = blooming ? BLOOM_FORCE : 1;
  const attractorRadius =
    motion === 'pulse'
      ? SHELL_RADIUS + SHELL_BREATH * Math.sin(2 * Math.PI * fast.beatPhase)
      : SHELL_RADIUS;
  // Synthetic music has hard, discrete grains; acoustic music has fine dust.
  const pointSizeTarget = lerp(1.2, 3.0, synthetic) * (motion === 'shatter' ? 1.6 : 1);
  if (motion === 'shatter') chroma *= 2;

  // Strands: how far the current bends the silk, and how fat each ribbon is.
  const strandBendTarget = lerp(0.2, 1.4, tension);

  if (reducedMotion) {
    flowAmtTarget *= 0.5;
    pushKick *= 0.5;
    chroma *= 0.5;
    mirrorFolds = 0;
    particleSpeed *= 0.5;
    particleImpulse *= 0.5;
    // Not halved: a camera that lunges at the viewer is exactly what reduced
    // motion is asking us not to do.
    dollySnap = 0;
  }

  // Exposure is instant (it is impact-driven), then capped, then rate-limited
  // in *direction* so it can never strobe.
  let exposure = 1 + 0.25 * impact + 0.1 * clamp01(fast.downbeatPulse) * arousal;
  if (reducedMotion) exposure = Math.min(exposure, REDUCED_MAX_EXPOSURE);
  exposure = prev === null ? exposure : limitStrobe(state, exposure, prev.exposure);

  return {
    weights: {
      ink: INK_BED / total,
      particles: wParticles / total,
      strands: wStrands / total,
      // Task 11.
      relief: 0,
      breath: 0,
    },
    palette: paletteFor(mood),

    flowAmt: slew(flowAmtTarget, prev?.flowAmt ?? flowAmtTarget),
    decay: slew(decayTarget, prev?.decay ?? decayTarget),
    turbulence: slew(turbulenceTarget, prev?.turbulence ?? turbulenceTarget),
    injectGain: slew(injectGainTarget, prev?.injectGain ?? injectGainTarget),
    pushKick,

    particleSpeed: slew(particleSpeed, prev?.particleSpeed ?? particleSpeed),
    particleImpulse,
    attractor,
    attractorRadius,
    attractorForce,
    pointSize: slew(pointSizeTarget, prev?.pointSize ?? pointSizeTarget),
    dollySnap,

    strandBend: slew(strandBendTarget, prev?.strandBend ?? strandBendTarget),
    // Not slewed: the thickness *is* the bass, and silk that swells a second
    // after the note is silk that is not listening.
    strandThickness: lerp(0.004, 0.02, clamp01(fast.sub)),

    reliefHeight: slew(lerp(0.2, 1, clamp01(fast.rms)), prev?.reliefHeight ?? 0.2),
    reliefContrast: slew(lerp(0.3, 1, tension), prev?.reliefContrast ?? 0.3),

    bloomStrength: slew(bloomStrengthTarget, prev?.bloomStrength ?? bloomStrengthTarget),
    bloomThreshold: slew(bloomThresholdTarget, prev?.bloomThreshold ?? bloomThresholdTarget),
    chroma,
    posterize,
    mirrorFolds,
    grain: slew(grainTarget, prev?.grain ?? grainTarget),
    vignette: slew(vignetteTarget, prev?.vignette ?? vignetteTarget),
    exposure,

    flowStyle: mood.motion,
  };
}

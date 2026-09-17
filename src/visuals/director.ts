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
  /** How far the terrain is displaced, in world units. */
  reliefHeight: number;
  /** The exponent on the lambert term; high is charcoal, low is chalk. */
  reliefContrast: number;
  /**
   * How angry the music is, which is what decides whether the high ground
   * glows. It cannot be read back off `reliefHeight` — that is the average of
   * aggression and melancholy, and a desolate landscape is as tall as a
   * furious one and must not have embers in it.
   */
  reliefAggression: number;
  /** How far a section pulls the particle camera in, 0..1. */
  particleDolly: number;

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

/** What melancholy and aggression bid for the terrain, at most. */
const RELIEF_BID = 0.8;
/** The extra the two genres built out of texture rather than notes get. */
const RELIEF_GENRE_BONUS = 0.3;
/** Genres whose whole character is surface rather than melody. */
const RELIEF_GENRES: ReadonlySet<Genre> = new Set<Genre>(['rock_metal', 'ambient_drone']);
/** Below this `spoken` the voice layer is not asked for at all. */
const BREATH_GATE = 0.5;
/**
 * Above this share of the frame the Breath layer is the picture, and the
 * safety clamps come down: nothing that can flash a screen survives over a
 * talking voice.
 */
const BREATH_SAFE_OVER = 0.5;
/** The most bloom a speech frame may carry. */
const BREATH_MAX_BLOOM = 0.4;
/** Above this share of the frame the terrain wants a mirror line. */
const RELIEF_MIRROR_OVER = 0.5;

/** What a section does to the ink, the dust and the bloom. */
const BUILD_DECAY = 0.02;
const BUILD_INJECT = 1.3;
const BREAKDOWN_DECAY = 0.03;
const BREAKDOWN_SPEED = 0.5;
/** How hard a climax flares the bloom, and for how long after the hit. */
const CLIMAX_BLOOM = 1.3;
const CLIMAX_BLOOM_SEC = 1;
/** How big a hit starts that second. */
const CLIMAX_IMPACT_GATE = 0.5;
/** The decay is a multiplier per frame; outside this it is not a fade. */
const MIN_DECAY = 0.8;
const MAX_DECAY = 0.999;

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
  /**
   * The slewed *base* of the bloom, kept aside for the same reason: the
   * climax flare is a multiplier on top of it and cannot be told apart again
   * from the previous frame's total.
   */
  heldBloomBase: number;
  /** The fold count actually in use, and the one waiting to replace it. */
  folds: number;
  pendingFolds: number;
  pendingFoldsSince: number;
  /**
   * When the last climax impact landed, on the same clock. The bloom flare is
   * a one-second window after a hit and cannot be read back off the previous
   * frame's `bloomStrength`, which is the flared number rather than the base.
   */
  lastClimaxAt: number;
}

/** A director that has never run. One per renderer. */
export function createDirector(): DirectorState {
  return {
    clock: 0,
    lastFlipAt: Number.NEGATIVE_INFINITY,
    lastDir: 0,
    heldChromaBase: 0,
    heldBloomBase: 0,
    folds: 0,
    pendingFolds: 0,
    pendingFoldsSince: Number.NEGATIVE_INFINITY,
    lastClimaxAt: Number.NEGATIVE_INFINITY,
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
    state.lastClimaxAt = Number.NEGATIVE_INFINITY;
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
  const melancholy = clamp01(mood.melancholy);
  const aggression = clamp01(mood.aggression);
  const spoken = clamp01(mood.spoken);
  const section = mood.section;

  // The brief's `grain = lerp(0.02, 0.12, noise)` wants the *noisiness* of the
  // sound, which the mood vector does not carry as such: it is a fact about
  // the spectrum, not a judgment. The nearest judgment is "gritty and not
  // machine-made" — aggression, and the absence of synthetic — so that is what
  // stands in for it, and it lands in the same 0..1 range.
  const noise = clamp01(0.5 * aggression + 0.5 * (1 - synthetic));

  // Ink, with the section's hand on it: a build holds the picture together for
  // longer and pushes more ink in, a breakdown lets it dissolve.
  let flowAmtTarget = lerp(0.15, 0.9, arousal);
  let decayTarget = lerp(0.93, 0.985, clamp01(build * 0.6 + hypnotic * 0.4));
  if (section === 'build') decayTarget += BUILD_DECAY;
  if (section === 'breakdown') decayTarget -= BREAKDOWN_DECAY;
  decayTarget = Math.min(MAX_DECAY, Math.max(MIN_DECAY, decayTarget));
  const turbulenceTarget = lerp(0.1, 1.0, tension);
  let injectGainTarget = lerp(0.6, 1.6, arousal);
  if (section === 'build') injectGainTarget *= BUILD_INJECT;
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
  let posterize = synthetic > 0.7 && arousal > 0.7 ? 6 : 0;

  // The mix.
  //
  // The ink is a bed and the other four layers are bid on top of it, then the
  // lot is normalised — so the *ratio* is what the formulas decide and the
  // total is always exactly one frame's worth of light. Particles want energy
  // and machines; strands want stillness and tension; relief wants grief or
  // anger, and more of both from the two genres that are made of texture
  // rather than of notes. All four get out of the way of a voice — dust, silk
  // and terrain over speech all read as decoration over a person talking — and
  // so does the *ink*, which up to now carried a podcast on its own. Breath is
  // the layer built for that, and it takes the whole frame.
  const motion = mood.motion;
  const voiced = 1 - spoken;
  const wInk = INK_BED * voiced;
  let wParticles = arousal * voiced * (0.6 + 0.4 * synthetic);
  let wStrands = (1 - arousal) * (0.5 + 0.5 * tension) * voiced;
  let wRelief = Math.max(melancholy, aggression) * RELIEF_BID * voiced;
  // The genre bonus fades with speech for the same reason the motion bonuses
  // below do: added flat, a drone podcast would keep a full terrain under the
  // voice layer that is supposed to have the frame to itself.
  if (RELIEF_GENRES.has(mood.genre)) wRelief += RELIEF_GENRE_BONUS * voiced;
  const wBreath = spoken >= BREATH_GATE ? spoken : 0;
  // The motion bonuses fade with speech too. Added flat they would put a
  // swarm's dust back over a talking voice at full strength, which is the one
  // thing the `(1 − spoken)` factors above exist to prevent.
  if (motion === 'swarm') wParticles += 0.3 * voiced;
  // A drift leans the mix toward silk; it does not hand it over. At 0.2 the
  // bonus put the strands ahead of the ink at IDLE_MOOD — which drifts — so a
  // page that had heard nothing opened on a curtain instead of on the ink.
  if (motion === 'drift') wStrands += 0.1 * voiced;
  // Never zero in practice — `spoken` 1 makes the breath 1 and anything less
  // leaves the ink bed — but a mix that could divide by zero is a black frame
  // waiting for the one mood nobody tried.
  const bid = wInk + wParticles + wStrands + wRelief + wBreath;
  const total = bid > 1e-6 ? bid : 1;
  const weights = {
    ink: bid > 1e-6 ? wInk / total : 1,
    particles: wParticles / total,
    strands: wStrands / total,
    relief: wRelief / total,
    breath: wBreath / total,
  };

  // Hypnotic, or terrain that has taken the frame. Two to six folds: eight read
  // as sharp static spokes rather than as a figure, and repetitive dance music
  // that is not hypnotic is not asking to be kaleidoscoped at all. The terrain
  // is the other way round — a mirrored ridge is the reference image, so a
  // dominant relief gets a mirror line whatever the music is doing.
  let foldTarget = hypnotic >= 0.6 ? Math.round(lerp(MIN_FOLDS, MAX_FOLDS, tension)) : 0;
  if (weights.relief > RELIEF_MIRROR_OVER) foldTarget = Math.max(foldTarget, MIN_FOLDS);
  let mirrorFolds = holdFolds(state, foldTarget, prev === null);

  // Particles.
  let particleSpeed = lerp(0.2, 2.2, arousal);
  if (section === 'breakdown') particleSpeed *= BREAKDOWN_SPEED;
  // A build pulls the camera in. It is a separate number from `fast.build`,
  // which is the analysis's own rising-energy reading: the section label is a
  // judgment about where we are in the track, and the two do not always agree.
  const particleDollyTarget = section === 'build' ? 1 : 0;
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

  // Relief: how far the terrain is displaced, and how hard the light falls off
  // across it. Grief and anger both raise the ridges — one reads as a slow
  // swell and the other as a jagged one, which is the noise's business, not
  // the height's — and tension is what turns a lit surface into charcoal.
  const reliefHeightTarget = lerp(0.3, 1.2, clamp01(aggression * 0.5 + melancholy * 0.5));
  const reliefContrastTarget = lerp(1.0, 3.0, tension);

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

  // The bloom's slewed base is held aside for the same reason chroma's is: the
  // climax flare is a multiplier on top, and a flared `prev.bloomStrength` fed
  // back into the slew would ratchet the bloom up and never come down.
  if (prev === null) state.heldBloomBase = bloomStrengthTarget;
  else state.heldBloomBase += (bloomStrengthTarget - state.heldBloomBase) * k;
  if (section === 'drop_climax' && impact >= CLIMAX_IMPACT_GATE) state.lastClimaxAt = state.clock;
  const flaring = section === 'drop_climax' && state.clock - state.lastClimaxAt < CLIMAX_BLOOM_SEC;
  let bloomStrength = state.heldBloomBase * (flaring ? CLIMAX_BLOOM : 1);

  // Safety. Over a talking voice nothing that can flash a screen survives:
  // no kaleidoscope, no fringing, no banding, a bloom that cannot bloom, and
  // an exposure pinned flat — an impact-driven lift over speech is precisely
  // the flash the Breath scene exists to avoid.
  if (weights.breath > BREATH_SAFE_OVER) {
    mirrorFolds = 0;
    chroma = 0;
    posterize = 0;
    bloomStrength = Math.min(bloomStrength, BREATH_MAX_BLOOM);
    exposure = 1;
  }

  return {
    weights,
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
    // after the note is silk that is not listening. Ribbons, not hairlines —
    // at 0.004 a strand was a hairline scratch and four hundred of them read
    // as rain rather than as silk.
    strandThickness: lerp(0.012, 0.035, clamp01(fast.sub)),

    reliefHeight: slew(reliefHeightTarget, prev?.reliefHeight ?? reliefHeightTarget),
    reliefContrast: slew(reliefContrastTarget, prev?.reliefContrast ?? reliefContrastTarget),
    reliefAggression: slew(aggression, prev?.reliefAggression ?? aggression),
    particleDolly: slew(particleDollyTarget, prev?.particleDolly ?? particleDollyTarget),

    bloomStrength,
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

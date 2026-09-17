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
import {
  activeFlourish,
  afterimageDamp,
  applyFlourish,
  createFlourishes,
  createSpin,
  fireFlourish,
  neutralFlourish,
  pushOutFor,
  resetFlourishes,
  stepSpin,
  strandWaveFor,
  striateFor,
  temperFlourish,
  type FlourishEffect,
  type FlourishState,
  type SpinState,
} from './smokeMath';
import { FLOURISH_SEC } from './smokeMath';
import { GENRES, MOTIONS, SECTIONS } from '../shared/types';
import type { Genre, Motion, MoodVector, Section, TransitionKind } from '../shared/types';

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
  /**
   * How sure the beat grid is that it has found the beat, 0..1, and how even
   * the onsets are.
   *
   * Both are facts about the rhythm rather than judgments about the music, so
   * they come off the analysis snapshot rather than out of the mood vector —
   * and they are here because the rotation is driven by them: a field that
   * turns on music with no findable beat is turning for no reason. An idle
   * page reports the two the idle clock deserves; see `visualLink`.
   */
  beatConf: number;
  regular: number;
  /**
   * Seconds in a bar, as the grid has it. The one thing on this frame that is
   * about *musical* length rather than about energy, and the only honest unit
   * for "hold this for a bar" — a fixed second is two bars of a 120 BPM track
   * and half a bar of a slow one. An idle page reports the idle clock's own.
   */
  barSec: number;
}

export interface RenderParams {
  /** How much of each scene is in the mix; sums to 1. */
  weights: { ink: number; particles: number; strands: number; relief: number; breath: number };
  palette: Palette;

  // smoke (the layer is still mixed under the name `ink`)
  flowAmt: number;
  decay: number;
  turbulence: number;
  injectGain: number;
  pushKick: number;
  /**
   * The global rotation of the flow field about the card, in radians. Advanced
   * here rather than in the shader from `uTime`, because it has to survive beat
   * kicks and a reversal that takes a second and a half — see `stepSpin`.
   */
  spin: number;
  /** How fast that angle is moving this frame, signed. rad/s. */
  spinRate: number;
  /** How hard the smoke is carried away from the card, in uv per second. */
  pushOut: number;
  /** The spatial frequency of the striations across the flow. */
  striate: number;

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

  // strands (Task 10, wavy since Task 17)
  strandBend: number;
  strandThickness: number;
  /** The traveling wave: how far it throws a ribbon, how tight, how fast. */
  strandWaveAmp: number;
  strandWaveFreq: number;
  strandWaveSpeed: number;
  /** How much brighter a `vocal_entry` flourish is burning the silk, 0..1. */
  strandGlow: number;

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
  /**
   * How much of the kaleidoscope is actually on screen, 0..1.
   *
   * `mirrorFolds` is an integer and cannot be crossfaded, so this is what moves.
   * The count changes only while this is near zero, and everything that wants
   * the mirror *off* — reduced motion, the speech clamp — drives this to zero
   * rather than snapping the count, because a figure that vanishes between two
   * frames is a cut.
   */
  mirrorMix: number;
  grain: number;
  vignette: number;
  exposure: number;
  /**
   * How much of the last frame the `AfterimagePass` keeps, 0..1. 0 is off,
   * which is what reduced motion asks for.
   */
  afterimage: number;

  flowStyle: Motion;

  /**
   * Whether the dust's accent grains burn rather than counterpoint.
   *
   * The rule: **warmth ≥ 0.4 takes the palette's `ember`, below it the
   * `accent`.** The accent is the complement, which on a warm palette is a cold
   * colour — the right answer for a cold track, where the sparks are the one
   * thing that is *not* the hue, and the wrong one for a warm track, where they
   * read as debris from another picture.
   *
   * With one exception, `COOL_GRAIN_GENRES`: a frame that is already terrain
   * and embers has no cold left in it to lose.
   */
  warmGrains: boolean;
}

/** Seconds for a slewed scalar to cover ~63% of the distance to its target. */
const SLEW_TAU = 0.8;
/**
 * The kaleidoscope's own, faster time constant, and how quiet it has to be
 * before the fold count may change underneath it.
 */
const MIRROR_TAU = 0.5;
const MIRROR_SWITCH = 0.05;
/**
 * Below this the mirror is simply off.
 *
 * An exponential approach never reaches its target, so a kaleidoscope that has
 * been faded out sits at 1e-9 for the rest of the track — invisible, and still
 * a full-screen pass with a fold count in it, because `MirrorPass` early-outs
 * on exactly zero. This is where "invisible" becomes "off": a mix of 0.001 is
 * a quarter of one code value at 8 bits.
 */
const MIRROR_OFF = 1e-3;
/** Above this warmth the dust's accent grains are embers rather than the complement. */
const WARM_GRAINS_AT = 0.4;
/**
 * The genres whose own picture is already warm enough without warm dust.
 *
 * Metal takes terrain for its own sake (`RELIEF_GENRES`) and the terrain glows
 * when the music is angry, so a warm palette there is a rust landscape with
 * embers in it — and warm accent grains on top make the whole frame one colour.
 * The complement is the only cold thing left in the picture.
 */
const COOL_GRAIN_GENRES: ReadonlySet<Genre> = new Set<Genre>(['rock_metal']);
/**
 * The safety at which the posterize clamp engages, and where it lets go.
 *
 * One threshold is one flicker: `spoken` lands as a step every few seconds and
 * the safety slews across it, so a bare `safety > 0.5` put the banding on and
 * off about once a second for as long as the reading sat near the middle —
 * which over a podcast with music under it is most of the time. Everything else
 * the safety touches is mixed rather than switched, and this one cannot be:
 * posterize is a level count, and 5.5 levels is not a picture.
 */
const POSTERIZE_CLAMP_ON = 0.6;
const POSTERIZE_CLAMP_OFF = 0.4;
/**
 * The chromatic aberration's ceilings.
 *
 * `CHROMA_BASE_MAX` is the standing fringe under the loudest machine music;
 * everything above it belongs to `impact` and to the flourishes, which are
 * events. `CHROMA_QUIET_MAX` is what a calm page may carry at all, and
 * `CHROMA_QUIET_AT` is where "calm" starts — below it there is nothing for
 * fringing to be about, and the afterimage smears whatever is there into a
 * permanent coloured ghost.
 */
const CHROMA_BASE_MAX = 0.004;
const CHROMA_QUIET_AT = 0.4;
const CHROMA_QUIET_MAX = 0.002;
/** How far into a drop or a scream the posterize window reaches. */
const POSTERIZE_FLOURISH_SEC = 1.5;
/** The kaleidoscope's ceiling through a climax, and the hypnotic that lifts it. */
const CLIMAX_MIRROR_MAX = 0.6;
const CLIMAX_MIRROR_FREE = 0.8;
/**
 * The hardest the frame may ever be printed.
 *
 * A slam is supposed to white the screen out for an instant and then decay; it
 * is not supposed to clip to flat white and stay there. The flare is
 * `1 + 0.25·impact` plus a drop flourish's own 0.35 on `(1 − t)²`, which tops
 * out at 1.6 — this is the ceiling under it, measured so the brightest
 * twentieth of the impact frame lands at 0.95 rather than at 1.
 */
const EXPOSURE_MAX = 1.6;
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
/** The shortest gap between two reversals of the flow; see the use site. */
const REVERSE_COOLDOWN_SEC = 4;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** GLSL's smoothstep, so a gate in here reads the same as a gate in a shader. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
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
/** The extra the one genre built out of surface rather than notes gets. */
const RELIEF_GENRE_BONUS = 0.3;
/**
 * Genres that want terrain for their own sake.
 *
 * `ambient_drone` was here too and was taken out: `IDLE_MOOD` *is* an ambient
 * drone, so the flat bonus put a fifth of the frame under a landscape on a page
 * that had heard nothing, and the idle picture stopped being ink-dominant. A
 * drone still gets terrain the moment it is a *sad* or an *angry* drone, which
 * is what the melancholy/aggression bid is for.
 */
const RELIEF_GENRES: ReadonlySet<Genre> = new Set<Genre>(['rock_metal']);
/**
 * The speech gate: no voice layer below 0.35, all of it above 0.65.
 *
 * It is a smoothstep and not a threshold because `spoken` is a judgment that
 * arrives every few seconds and lands as a step. At `spoken ≥ 0.5 ? spoken : 0`
 * an answer moving from 0.49 to 0.51 put half the frame under a new layer
 * between two frames — a cut, and the most visible one in the app.
 */
const BREATH_GATE_LO = 0.35;
const BREATH_GATE_HI = 0.65;
/**
 * The share of the frame at which the safety clamps come down.
 *
 * It is 0.25 because that is where the *blend* is already half breath — the
 * composite is mixed by `weight / 0.5` — so the clamp engages exactly when the
 * voice layer becomes the thing being looked at. At 0.5, the old number, there
 * was a quarter of the range where the breath was plainly on screen and the
 * kaleidoscope was still turning over it.
 */
const BREATH_SAFE_OVER = 0.25;
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
/** The lowest the bright pass may sit through a climax; see the use site. */
const CLIMAX_BLOOM_THRESHOLD = 0.85;
/**
 * How long the climax flare holds: one bar, not one second.
 *
 * A `drop_climax` section with a hit in it lifts the bloom, and the lift used
 * to last a flat second — which is half a bar of a 60 BPM piece and two bars of
 * a 150 BPM one, so the same instruction meant two different gestures depending
 * on the tempo. A bar is what a drop is measured in by everyone who writes one.
 *
 * Bounded either side, because a grid that has locked onto a wrong multiple
 * would otherwise hold the flare for eight seconds or blink it for two tenths.
 */
const CLIMAX_BLOOM_MIN_SEC = 0.5;
const CLIMAX_BLOOM_MAX_SEC = 4;
const CLIMAX_BLOOM_FALLBACK_SEC = 2;

export function climaxBloomSec(barSec: number): number {
  if (!Number.isFinite(barSec) || barSec <= 0) return CLIMAX_BLOOM_FALLBACK_SEC;
  return Math.min(CLIMAX_BLOOM_MAX_SEC, Math.max(CLIMAX_BLOOM_MIN_SEC, barSec));
}
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
  /**
   * The five layers' *un-normalised* bids, slewed.
   *
   * They are held here rather than read back off `prev.weights` because those
   * are normalised: a layer whose own bid never moved still changes share when
   * another layer's does, and slewing the normalised number would chase that
   * change instead of the mood. Slewing the bids and normalising afterwards
   * keeps every layer's crossfade its own, and the mix exactly one.
   */
  bids: { ink: number; particles: number; strands: number; relief: number; breath: number };
  /** The fold count actually in use, the debounced one the music wants, and the pending one. */
  folds: number;
  wantedFolds: number;
  pendingFolds: number;
  pendingFoldsSince: number;
  /** How much of the kaleidoscope is on screen, slewed. */
  mirrorMix: number;
  /** How far the speech clamp is engaged, slewed: 1 is fully clamped. */
  safety: number;
  /** Whether the safety currently has posterize switched off; see the constants. */
  posterizeClamped: boolean;
  /**
   * When the last climax impact landed, on the same clock. The bloom flare is
   * a one-second window after a hit and cannot be read back off the previous
   * frame's `bloomStrength`, which is the flared number rather than the base.
   */
  lastClimaxAt: number;
  /** When the flow last turned round, on the same clock. */
  lastReverseAt: number;
  /**
   * The rotation's integrator: angle, rate, the decaying beat kick and where a
   * reversal has got to. It cannot be read back off the previous `RenderParams`
   * — that carries the angle and the rate, and neither of them says which way
   * the field is heading or how much of the flip is left.
   */
  spin: SpinState;
  /** Which one-shot is running, and when each kind last fired. */
  flourishes: FlourishState;
  /**
   * This frame's flourish, as numbers. One object for the life of the
   * director: `applyFlourish` overwrites every field, so nothing survives from
   * the last flourish to ratchet the picture up, and the render loop allocates
   * nothing.
   */
  effect: FlourishEffect;
}

/** A director that has never run. One per renderer. */
export function createDirector(): DirectorState {
  return {
    clock: 0,
    lastFlipAt: Number.NEGATIVE_INFINITY,
    lastDir: 0,
    heldChromaBase: 0,
    heldBloomBase: 0,
    bids: { ink: 0, particles: 0, strands: 0, relief: 0, breath: 0 },
    folds: 0,
    wantedFolds: 0,
    pendingFolds: 0,
    pendingFoldsSince: Number.NEGATIVE_INFINITY,
    mirrorMix: 0,
    safety: 0,
    posterizeClamped: false,
    lastClimaxAt: Number.NEGATIVE_INFINITY,
    lastReverseAt: Number.NEGATIVE_INFINITY,
    spin: createSpin(),
    flourishes: createFlourishes(),
    effect: neutralFlourish(),
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
 * The fold count the music is asking for, with a hand on it.
 *
 * `tension` wobbling across a rounding boundary would re-fold the entire
 * screen several times a second, which is the one thing a kaleidoscope must
 * not do — the figure is the point, and a figure that keeps changing its
 * symmetry is noise. A different count has to be wanted continuously for half
 * a second before it is even *wanted*, and wanting it is not the same as
 * getting it: the caller only commits the new count while the mirror's mix has
 * faded to nothing, so the change happens where nobody can see it.
 */
function holdFolds(s: DirectorState, target: number, fresh: boolean): number {
  if (fresh) {
    s.wantedFolds = target;
    s.pendingFolds = target;
    s.pendingFoldsSince = s.clock;
    return target;
  }
  if (target === s.wantedFolds) {
    s.pendingFolds = target;
    s.pendingFoldsSince = s.clock;
    return s.wantedFolds;
  }
  if (target !== s.pendingFolds) {
    s.pendingFolds = target;
    s.pendingFoldsSince = s.clock;
  } else if (s.clock - s.pendingFoldsSince >= FOLD_HOLD_SEC) {
    s.wantedFolds = target;
  }
  return s.wantedFolds;
}

/**
 * `transitions` is the kinds of the timeline cues whose instant went by since
 * the last frame — usually none, one on a seam. They are what fire the
 * one-shot flourishes and the spin reversal; everything else the director
 * reads is a level rather than an event.
 */
export function direct(
  state: DirectorState,
  mood: MoodVector,
  fast: FastFrame,
  dt: number,
  prev: RenderParams | null,
  reducedMotion: boolean,
  transitions: readonly TransitionKind[] = [],
): RenderParams {
  const step = Math.max(0, Math.min(0.1, dt));
  if (prev === null) {
    state.clock = 0;
    state.lastFlipAt = Number.NEGATIVE_INFINITY;
    state.lastDir = 0;
    state.lastClimaxAt = Number.NEGATIVE_INFINITY;
    state.lastReverseAt = Number.NEGATIVE_INFINITY;
    resetFlourishes(state.flourishes);
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
  const wBreath = smoothstep(BREATH_GATE_LO, BREATH_GATE_HI, spoken) * spoken;
  // The motion bonuses fade with speech too. Added flat they would put a
  // swarm's dust back over a talking voice at full strength, which is the one
  // thing the `(1 − spoken)` factors above exist to prevent.
  if (motion === 'swarm') wParticles += 0.3 * voiced;
  // A drift leans the mix toward silk; it does not hand it over. At 0.2 the
  // bonus put the strands ahead of the ink at IDLE_MOOD — which drifts — so a
  // page that had heard nothing opened on a curtain instead of on the ink.
  if (motion === 'drift') wStrands += 0.1 * voiced;
  // Every bid is slewed toward its target before the mix is taken, so no layer
  // can appear or vanish between two frames however hard the mood layer steps —
  // and the normalisation afterwards keeps the total exactly one frame's worth
  // of light at every point of the crossfade.
  const b = state.bids;
  if (prev === null) {
    b.ink = wInk;
    b.particles = wParticles;
    b.strands = wStrands;
    b.relief = wRelief;
    b.breath = wBreath;
  } else {
    b.ink += (wInk - b.ink) * k;
    b.particles += (wParticles - b.particles) * k;
    b.strands += (wStrands - b.strands) * k;
    b.relief += (wRelief - b.relief) * k;
    b.breath += (wBreath - b.breath) * k;
  }
  // Never zero in practice — `spoken` 1 makes the breath 1 and anything less
  // leaves the ink bed — but a mix that could divide by zero is a black frame
  // waiting for the one mood nobody tried.
  const bid = b.ink + b.particles + b.strands + b.relief + b.breath;
  const total = bid > 1e-6 ? bid : 1;
  const weights = {
    ink: bid > 1e-6 ? b.ink / total : 1,
    particles: b.particles / total,
    strands: b.strands / total,
    relief: b.relief / total,
    breath: b.breath / total,
  };

  // The safety, as a number rather than a switch. It engages on the same share
  // of the frame the blend composites the breath with, and it is slewed, so
  // everything it takes away leaves gradually instead of being snatched.
  const safetyTarget = weights.breath >= BREATH_SAFE_OVER ? 1 : 0;
  const kMirror = prev === null ? 1 : 1 - Math.exp(-step / MIRROR_TAU);
  state.safety += (safetyTarget - state.safety) * kMirror;
  const safety = state.safety;

  // The seams. A `drop` or a `breakdown` turns the whole field the other way —
  // over a second and a half, never between two frames — and anything Jev
  // called dramatic also fires a one-shot. A reversal already in flight is not
  // restarted: two cues 200 ms apart are one seam, and letting the second
  // cancel the first would leave the smoke turning the way it started.
  let reverse = false;
  for (const kind of transitions) {
    if (kind === 'drop' || kind === 'breakdown') reverse = true;
    // The hit as the timeline reads it on this frame, which at a seam is the
    // cue's own intensity: a drop's burst runs for as long as the drop was big.
    fireFlourish(state.flourishes, kind, state.clock, clamp01(fast.impact));
  }
  if (state.spin.reverseLeft > 0) reverse = false;
  // And a cooldown of its own, which the real-track pass made necessary.
  //
  // A reversal is the largest single gesture the picture has: every pixel of a
  // rotating field changes velocity at once, over a second and a half. Pass 2
  // on a spoken-word recording named nine `drop`s and five `breakdown`s in four
  // minutes — applause and laughter read as slams — and without a hand on it
  // the field spent the whole talk turning itself round. The flourishes each
  // have a cooldown for exactly this reason; the reversal did not, because
  // "one already in flight" is not a cooldown, it is a lock that lets go the
  // instant the gesture ends.
  if (reverse && state.clock - state.lastReverseAt < REVERSE_COOLDOWN_SEC) reverse = false;
  if (reverse) state.lastReverseAt = state.clock;

  // Which one-shot is running, read *before* the rotation is stepped: a
  // `quiet_fall` is one of the two things that slow the base rate down, and a
  // flourish that fires this frame is running this frame.
  const firing = activeFlourish(state.flourishes, state.clock);
  // The rotation is a *reaction*, not a rate: it is the product of energy, a
  // beat the grid is confident about, a rhythm that is regular, and the absence
  // of a talking voice — so a podcast and a beatless drone sit at the drift and
  // an EDM track turns. See `spinBaseRate`.
  stepSpin(state.spin, {
    dt: step,
    arousal,
    beatConf: clamp01(fast.beatConf),
    regular: clamp01(fast.regular),
    spoken,
    build,
    section:
      section === 'build'
        ? 'build'
        : section === 'breakdown'
          ? 'breakdown'
          : firing?.kind === 'quiet_fall'
            ? 'quiet'
            : 'other',
    onset: fast.onset,
    downbeatPulse: fast.downbeatPulse,
    motion: mood.motion,
    reverse,
    reducedMotion,
  });

  const effect = state.effect;
  applyFlourish(effect, firing?.kind ?? null, firing?.t ?? 0);
  // Reduced motion keeps half of a flourish — the picture still marks the
  // moment, it just does not lunge — and the breath safety pulls the whole
  // thing toward doing nothing.
  //
  // Both are applied *here*, before a single target has been built from the
  // effect. They used to be applied at opposite ends of the frame, and the
  // later one was too late to matter: `pushOut`, the `flowAmt`/`decay`
  // overrides, `injectGainMul` and `grainMul` had all been read out of the
  // untempered effect by then, so over a talking voice a drop still burst the
  // smoke outward and a hole still froze the field. The mix and the safety are
  // computed above for exactly this reason.
  if (reducedMotion) temperFlourish(effect, 0.5);
  temperFlourish(effect, 1 - safety);

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
  // The standing outward creep that fills the frame around the card, and the
  // comb that combs the sheets. Both are instant: the push is what a hit
  // *does*, and the striation frequency is a property of the material.
  let pushOut = pushOutFor(arousal, impact) * effect.pushOutMul;
  const striate = striateFor(synthetic);

  // A flourish's overrides go onto the *targets*, not onto the results. The
  // slew is the rule this whole file is built on — a decay that changes
  // between two frames is a cut — so a hole's freeze arrives over half a
  // second rather than instantly, which over a 1.5 s hole is the shape of the
  // gesture anyway.
  if (effect.flowAmt !== null) flowAmtTarget = effect.flowAmt;
  if (effect.decay !== null) decayTarget = effect.decay;
  injectGainTarget *= effect.injectGainMul;

  // Post.
  const bloomStrengthTarget = lerp(0.3, 1.4, arousal);
  let bloomThresholdTarget = lerp(0.85, 0.55, valence);
  // A climax blooms its *cores*, not its mid-tones.
  //
  // The flare is a multiplier on the strength, and a strong bloom over a low
  // threshold is a glow that fills the frame's darks: measured half a second
  // after a drop, the darkest fifth of the frame sat at 0.39 and not one pixel
  // was black. The bright pass is what decides which pixels are allowed to
  // spread, so that is where the blacks are kept — the hot streaks still bloom
  // as hard as before, and the field they sit in stays a field.
  if (section === 'drop_climax') {
    bloomThresholdTarget = Math.max(bloomThresholdTarget, CLIMAX_BLOOM_THRESHOLD);
  }
  // The baseline fringing, capped at `CHROMA_BASE_MAX`. It used to reach
  // 0.012, which is visible as magenta and green edges on every filament in a
  // still frame — fringing is supposed to be something a hit *does*, and the
  // `+ impact·0.02` term is where that lives.
  const chromaBaseTarget = Math.min(CHROMA_BASE_MAX, lerp(0, 0.012, synthetic * arousal));
  if (prev === null) state.heldChromaBase = chromaBaseTarget;
  else state.heldChromaBase += (chromaBaseTarget - state.heldChromaBase) * k;
  let chroma = state.heldChromaBase + impact * 0.02 + effect.chromaAdd;
  // And a hard ceiling on a calm page. At idle the impact term is zero and the
  // afterimage holds the last frame at 0.9, so even a small standing fringe is
  // smeared into a permanent coloured ghost on the filaments — measured as
  // visible magenta/green at the idle arousal of 0.3. Below `CHROMA_QUIET_AT`
  // there is nothing happening that fringing could be *about*.
  if (arousal < CHROMA_QUIET_AT) chroma = Math.min(chroma, CHROMA_QUIET_MAX);
  // The floor is 0.03 rather than 0.02 because below that the grain is not
  // grain, it is a dither nobody can see — and an ungrained frame reads as
  // computer graphics however good the ink is.
  const grainTarget = lerp(0.03, 0.12, noise) * effect.grainMul;
  const vignetteTarget = lerp(0.55, 0.2, space);

  // The acid look, and it is a *moment* rather than a setting.
  //
  // Sustained through a whole section, hard colour steps read as banding — a
  // broken gradient, not a style. So it is allowed in two places only: inside
  // the first `POSTERIZE_FLOURISH_SEC` of a drop or a scream, which is where a
  // hard-edged frame is the gesture; and under music that is both hypnotic and
  // machine-made, where the repetition is the point. Plain "loud and
  // synthetic" — which is most of a dance track — no longer qualifies.
  const flourishing =
    firing !== null &&
    (firing.kind === 'drop' || firing.kind === 'scream_peak') &&
    firing.t * FLOURISH_SEC[firing.kind] <= POSTERIZE_FLOURISH_SEC;
  let posterize = flourishing || (hypnotic >= 0.6 && synthetic > 0.7) ? 6 : 0;

  // Hypnotic, or terrain that has taken the frame. Two to six folds: eight read
  // as sharp static spokes rather than as a figure, and repetitive dance music
  // that is not hypnotic is not asking to be kaleidoscoped at all. The terrain
  // is the other way round — a mirrored ridge is the reference image, so a
  // dominant relief gets a mirror line whatever the music is doing.
  let rawFolds = hypnotic >= 0.6 ? Math.round(lerp(MIN_FOLDS, MAX_FOLDS, tension)) : 0;
  if (weights.relief > RELIEF_MIRROR_OVER) rawFolds = Math.max(rawFolds, MIN_FOLDS);
  // The half-second debounce exists so a wobbling `tension` cannot re-fold the
  // screen; a scream is not a wobble, and a 1 s flare cannot wait half of
  // itself for a fold count. Taking it immediately is free here, because the
  // mirror is off — a count may always change while nobody can see the figure.
  const snapFolds = prev === null || (effect.mirrorMix > 0 && state.folds === 0);
  // The *music's* own count, debounced. It is what the mirror's mix is gated
  // on further down, and it has to be the held number rather than the raw one:
  // gated on the raw count, a `hypnotic` that dipped under 0.6 for two frames
  // faded the whole figure out and back, which is the flicker `holdFolds`
  // exists to prevent and which it was not covering.
  const musicFolds = holdFolds(state, rawFolds, snapFolds);
  // A flourish can open the mirror over a track that never wanted one, and
  // when it does the figure comes in at the flourish's own strength rather
  // than at full. Not debounced: a one-shot is its own hold.
  const wantedFolds = effect.mirrorMix > 0 ? Math.max(musicFolds, MIN_FOLDS) : musicFolds;
  if (snapFolds) state.folds = wantedFolds;

  // The mirror's mix, and the one rule that makes a fold count safe to change:
  // while the count on screen is not the one the music wants, the figure fades
  // *out* — and only once it is invisible does the count move and the figure
  // come back. Reduced motion and the speech clamp pull the same lever, so they
  // dim the kaleidoscope away rather than snatching it.
  const changing = state.folds !== wantedFolds;
  let mirrorMixTarget = state.folds > 0 && !changing && musicFolds > 0 ? 1 : 0;
  // A scream's own figure, which is a fraction of a kaleidoscope rather than
  // the whole thing. Never while the count is moving: that is the one state in
  // which the mix has to be going *down*.
  if (!changing) mirrorMixTarget = Math.max(mirrorMixTarget, effect.mirrorMix);
  if (reducedMotion) mirrorMixTarget = 0;
  // Through a climax the smoke has to stay readable *under* the symmetry: at a
  // full mix the kaleidoscope is the picture and the drop is a pattern. Capped
  // unless the music is so hypnotic that the figure is what it is about. The
  // fold axis keeps rotating either way — that is `MirrorPass`'s own business.
  if (section === 'drop_climax' && hypnotic < CLIMAX_MIRROR_FREE) {
    mirrorMixTarget = Math.min(mirrorMixTarget, CLIMAX_MIRROR_MAX);
  }
  mirrorMixTarget = Math.min(mirrorMixTarget, 1 - safety);
  state.mirrorMix += (mirrorMixTarget - state.mirrorMix) * kMirror;
  // Off is off: see `MIRROR_OFF`. Only on the way down — on the way up the mix
  // starts at zero, and snapping it back would hold the figure out forever.
  if (mirrorMixTarget === 0 && state.mirrorMix < MIRROR_OFF) state.mirrorMix = 0;
  if (state.mirrorMix < MIRROR_SWITCH) state.folds = wantedFolds;
  const mirrorMix = state.mirrorMix;
  const mirrorFolds = state.folds;

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

  // Strands: how far the current bends the silk, how fat each ribbon is, and
  // — since v2 — the traveling wave that runs down it. `bands[3]` is the
  // low-mid, which is where a kick's body and a bassline both live: the silk
  // billows on the part of the spectrum that has weight in it.
  const strandBendTarget = lerp(0.2, 1.4, tension);
  const strandWave = strandWaveFor(fast.bands[3] ?? 0, tension, arousal);

  // Relief: how far the terrain is displaced, and how hard the light falls off
  // across it. Grief and anger both raise the ridges — one reads as a slow
  // swell and the other as a jagged one, which is the noise's business, not
  // the height's — and tension is what turns a lit surface into charcoal.
  const reliefHeightTarget = lerp(0.3, 1.2, clamp01(aggression * 0.5 + melancholy * 0.5));
  const reliefContrastTarget = lerp(1.0, 3.0, tension);

  if (reducedMotion) {
    flowAmtTarget *= 0.5;
    pushKick *= 0.5;
    pushOut *= 0.5;
    chroma *= 0.5;
    particleSpeed *= 0.5;
    particleImpulse *= 0.5;
    // Not halved: a camera that lunges at the viewer is exactly what reduced
    // motion is asking us not to do.
    dollySnap = 0;
  }

  // Safety, applied to the *targets* rather than to the results. Over a talking
  // voice nothing that can flash a screen survives — no fringing, no banding, a
  // bloom that cannot bloom, an exposure pinned flat and a kaleidoscope faded
  // out — but every one of those leaves through the slew or the limiter that
  // owns it. An assignment after the limiter would be a cut with a safety
  // label on it, which is the failure mode this whole pass is about.
  chroma *= 1 - safety;
  // The one clamp that is a switch rather than a mix, so it is the one clamp
  // that needs a hand on it: engaged at 0.6, released at 0.4, and holding
  // whatever it was doing in between.
  if (prev === null) state.posterizeClamped = safety > POSTERIZE_CLAMP_ON;
  else if (safety > POSTERIZE_CLAMP_ON) state.posterizeClamped = true;
  else if (safety < POSTERIZE_CLAMP_OFF) state.posterizeClamped = false;
  if (state.posterizeClamped) posterize = 0;

  // The bloom's slewed base is held aside for the same reason chroma's is: the
  // climax flare is a multiplier on top, and a flared `prev.bloomStrength` fed
  // back into the slew would ratchet the bloom up and never come down.
  const bloomTarget = lerp(bloomStrengthTarget, Math.min(bloomStrengthTarget, BREATH_MAX_BLOOM), safety);
  if (prev === null) state.heldBloomBase = bloomTarget;
  else state.heldBloomBase += (bloomTarget - state.heldBloomBase) * k;
  if (section === 'drop_climax' && impact >= CLIMAX_IMPACT_GATE) state.lastClimaxAt = state.clock;
  const flaring =
    section === 'drop_climax' && state.clock - state.lastClimaxAt < climaxBloomSec(fast.barSec);
  // The flare is a multiplier on the slewed base, so the ceiling has to be
  // applied again after it — mixed in by the safety rather than switched, so a
  // climax that turns into speech dims out instead of being snapped down.
  const flared = state.heldBloomBase * (flaring ? CLIMAX_BLOOM : 1) * effect.bloomMul;
  const bloomStrength = lerp(flared, Math.min(flared, BREATH_MAX_BLOOM), safety);

  // Exposure is instant (it is impact-driven), flattened by the safety, capped,
  // and only then rate-limited in *direction* so it can never strobe. Nothing
  // touches it after the limiter.
  //
  // The arousal-driven lift is gone. `1 + 0.25·impact + 0.1·pulse·arousal` put
  // a standing +0.1 under every loud section on top of a bloom that was already
  // flaring, and the colour stage's knee saturates: measured at a drop, large
  // flat regions of the frame clipped to beige-white with nothing graded in
  // them. What is left is what a *hit* does, plus whatever the flourish asks
  // for, capped so a slam can whiten the frame for two frames and not three.
  let exposure = Math.min(EXPOSURE_MAX, 1 + 0.25 * impact + effect.exposureAdd);
  exposure = lerp(exposure, 1, safety);
  if (reducedMotion) exposure = Math.min(exposure, REDUCED_MAX_EXPOSURE);
  exposure = prev === null ? exposure : limitStrobe(state, exposure, prev.exposure);

  return {
    weights,
    palette: paletteFor(mood),

    flowAmt: slew(flowAmtTarget, prev?.flowAmt ?? flowAmtTarget),
    decay: slew(decayTarget, prev?.decay ?? decayTarget),
    turbulence: slew(turbulenceTarget, prev?.turbulence ?? turbulenceTarget),
    injectGain: slew(injectGainTarget, prev?.injectGain ?? injectGainTarget),
    pushKick,
    // Not slewed. The spin is its own integrator and the push is impact-driven;
    // a burst that arrives 0.8 s after the drop is not a burst.
    spin: state.spin.angle,
    spinRate: state.spin.rate,
    pushOut,
    striate: slew(striate, prev?.striate ?? striate),

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
    // as rain rather than as silk. Widened again by 1.8 after the real-music
    // pass: at 1440×900 with a 0.5 scene scale, 0.012 of a 4-unit field is
    // under two device pixels, which is a scratch however many of them there
    // are.
    strandThickness: lerp(0.022, 0.06, clamp01(fast.sub)),
    // The traveling wave. Not slewed either — the amplitude *is* the low-mid
    // band and silk that swells a second after the note is silk that is not
    // listening — and the frequency and speed are read straight off tension and
    // arousal, which the mood layer has already slewed on their way in.
    strandWaveAmp: strandWave.amp,
    strandWaveFreq: strandWave.freq,
    strandWaveSpeed: strandWave.speed,
    strandGlow: effect.strandGlow,

    reliefHeight: slew(reliefHeightTarget, prev?.reliefHeight ?? reliefHeightTarget),
    reliefContrast: slew(reliefContrastTarget, prev?.reliefContrast ?? reliefContrastTarget),
    reliefAggression: slew(aggression, prev?.reliefAggression ?? aggression),
    particleDolly: slew(particleDollyTarget, prev?.particleDolly ?? particleDollyTarget),

    bloomStrength,
    bloomThreshold: slew(bloomThresholdTarget, prev?.bloomThreshold ?? bloomThresholdTarget),
    chroma,
    posterize,
    mirrorFolds,
    mirrorMix,
    grain: slew(grainTarget, prev?.grain ?? grainTarget),
    vignette: slew(vignetteTarget, prev?.vignette ?? vignetteTarget),
    exposure,
    afterimage: afterimageDamp(hypnotic, motion === 'shatter', reducedMotion),

    flowStyle: mood.motion,
    warmGrains: clamp01(mood.warmth) >= WARM_GRAINS_AT && !COOL_GRAIN_GENRES.has(mood.genre),
  };
}

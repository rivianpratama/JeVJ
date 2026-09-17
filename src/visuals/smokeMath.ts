/**
 * The arithmetic of the smoke, in closed form.
 *
 * `inkMath.ts` answers "what does the feedback loop settle at". This file
 * answers the four questions v2 adds, and it answers them here rather than in
 * the director or in a shader because each of them is a *mechanism* — a thing
 * with a state, a rule and an edge case — rather than a mapping from one mood
 * number to one uniform:
 *
 *  - **where the smoke turns.** The whole field rotates about the screen
 *    centre, and the rotation has to survive a beat kick, a decay and a
 *    reversal that takes a second and a half without ever cutting. That is an
 *    integrator with three inputs, and an integrator belongs in a test.
 *  - **where the smoke is born.** Not the middle any more but an annulus
 *    around the card, which means a DOM rectangle in CSS pixels turned into a
 *    centre and two radii in the aspect-corrected space the inject shader
 *    works in — with a virtual square standing in when there is no card.
 *  - **when a flourish fires.** One-shots read off the timeline, each with its
 *    own length and its own cooldown, and a newer one taking over from an
 *    older rather than queueing behind it.
 *  - **how the silk moves.** The traveling wave and the wrapped drift, so a
 *    test can assert the one property the look depends on: that there is no
 *    setting of the mood at which the strands are a still picture.
 *
 * Pure: no three.js, no DOM, no GLSL. Everything that has state takes it as an
 * argument, so two renderers on one page cannot tread on each other and the
 * render loop can hold one of each for the life of the page and allocate
 * nothing.
 */

import { TRANSITION_KINDS } from '../shared/types';
import type { TransitionKind } from '../shared/types';

// ───────────────────────────────────────────────────────────── rotation

/**
 * What the loudest, tightest, most confidently-metred music buys, in rad/s,
 * and the drift under everything.
 *
 * v2.1 made the rotation a *reaction* rather than a rate. The old
 * `0.18·(0.4 + arousal)` turned a podcast at 0.072 rad/s — a full revolution
 * every minute and a half under a person talking, which is motion the music
 * never asked for. Now the base is the product of four things that all have to
 * be true before the field turns at all: the music is energetic, there is a
 * beat, the beat is regular, and nobody is talking. Speech, beatless ambient
 * and an unmetred rubato passage all land at essentially zero.
 *
 * `SPIN_DRIFT` is what is left when they are all zero, and it is deliberately
 * barely perceptible: 0.004 rad/s is one revolution in twenty-six minutes. A
 * field that is exactly still reads as a frozen screenshot rather than as
 * smoke; a field turning this slowly reads as alive and cannot be watched
 * turning.
 */
export const SPIN_BASE = 0.22;
export const SPIN_DRIFT = 0.004;
/** What a build multiplies the base by at full anticipation, and what a fall does. */
export const SPIN_BUILD_GAIN = 1;
export const SPIN_QUIET_GAIN = 0.3;
/** How hard a beat shoves the rotation, what a downbeat adds, and how fast both fade. */
export const SPIN_KICK = 0.9;
export const SPIN_DOWNBEAT_KICK = 0.6;
export const SPIN_KICK_TAU = 0.4;
/** What the two motions that are supposed to glide keep of a kick. */
export const SPIN_GLIDE_KICK = 0.5;
/** How high the downbeat pulse has to climb to count as a new bar. */
const DOWNBEAT_EDGE = 0.9;
/**
 * The most the beat kicks may add to the rate, in rad/s.
 *
 * `onset` is a level, not an event: the analyser reports a novelty reading
 * every frame, and a sustained transient — a cymbal roll, a distorted guitar
 * held through a bar — reads high for a hundred frames in a row. Each of those
 * frames adds its own kick against a τ of 0.4 s, so the sum runs to
 * `0.9 / (1 − e^(−1/24))` ≈ 22 rad/s, which is three and a half turns a second.
 * Measured in the harness at a held onset: 6.8 rad/s within a quarter of a
 * second. At 1.8 — twice one full kick — a run of transients still shoves the
 * field hard and cannot spin the frame into a blur.
 */
export const SPIN_KICK_MAX = 1.8;
/** How long a reversal takes. It is long on purpose: a flip is not a cut. */
export const SPIN_REVERSE_SEC = 1.5;
/** What reduced motion leaves of the base rate. The kicks it takes entirely. */
const SPIN_REDUCED = 0.5;

/** What the base rate is asked about: is this energetic, metred, sung music? */
export interface SpinDrive {
  arousal: number;
  /** The beat grid's own confidence, 0..1. */
  beatConf: number;
  /** How even the onsets are, 0..1 — the rhythm tracker's `regular`. */
  regular: number;
  /** How much of this is someone talking, 0..1. */
  spoken: number;
  /** The anticipation ramp, 0..1; only a `build` section uses it. */
  build?: number;
  section?: 'build' | 'breakdown' | 'quiet' | 'other';
}

/**
 * The base angular rate, before direction and before the beat.
 *
 * `0.22·arousal²·beatConf·regular·(1 − spoken)`, plus `SPIN_DRIFT`.
 *
 * The square on arousal is what keeps a merely-present rhythm from turning the
 * whole frame: at arousal 0.3 the square is 0.09, so a calm piece with a
 * middling grid reads under 0.01 rad/s and the picture is, to the eye, still.
 * At 0.75 with a locked grid it is 0.11 — a revolution a minute, which is the
 * "slow majestic rolling" of the reference — and a climax at 1 is 0.22.
 *
 * The section scaling is a multiplier on the product rather than on the drift:
 * the drift is the floor that exists so that nothing is ever frozen, and a
 * breakdown is not supposed to freeze the picture, it is supposed to let it
 * settle.
 */
export function spinBaseRate(d: SpinDrive): number {
  const a = clamp01(d.arousal);
  const conf = clamp01(d.beatConf);
  const reg = clamp01(d.regular);
  const voiced = 1 - clamp01(d.spoken);
  let base = SPIN_BASE * a * a * conf * reg * voiced;
  if (d.section === 'build') base *= 1 + SPIN_BUILD_GAIN * clamp01(d.build ?? 0);
  else if (d.section === 'breakdown' || d.section === 'quiet') base *= SPIN_QUIET_GAIN;
  return base + SPIN_DRIFT;
}

/** Everything the rotation has to remember between frames. */
export interface SpinState {
  /** The angle handed to the shader, wrapped into [0, 2π). */
  angle: number;
  /** The signed rate the angle is moving at this frame, rad/s. */
  rate: number;
  /** The decaying beat shove, rad/s, signed with the direction. */
  kick: number;
  /** Where the reversal is heading: +1 or −1. */
  dir: number;
  /** Where it is coming from, and how much of the 1.5 s is left. */
  from: number;
  reverseLeft: number;
  /**
   * How many downbeats have gone by, and the last pulse level seen.
   *
   * The bar count is what lets a `pulse` track *rock*: the kick's sign
   * alternates bar by bar, so the field is shoved one way through one bar and
   * the other way through the next instead of being wound up in one direction.
   * The pulse is a decaying level rather than an event, so the count moves on
   * its rising edge — see `DOWNBEAT_EDGE`.
   */
  bar: number;
  lastPulse: number;
}

export function createSpin(): SpinState {
  return { angle: 0, rate: 0, kick: 0, dir: 1, from: 1, reverseLeft: 0, bar: 0, lastPulse: 0 };
}

export interface SpinStep extends SpinDrive {
  dt: number;
  /** This frame's onset, 0..1. */
  onset: number;
  /** The downbeat pulse, 0..1; its rising edge is a bar line. */
  downbeatPulse?: number;
  /** Which motion the director picked; `pulse` rocks, `flow`/`drift` glide. */
  motion?: string;
  /** A `drop` or `breakdown` transition just went by. */
  reverse: boolean;
  reducedMotion: boolean;
}

/**
 * Advance the rotation one frame, and return the angle.
 *
 * The direction is a *number*, not a sign: during a reversal it slides from
 * the old direction to the new one over `SPIN_REVERSE_SEC`, so the field slows
 * to a standstill halfway through and comes back the other way. Flipping the
 * sign between two frames would be the most visible cut in the app — every
 * pixel of a rotating field changes velocity at once.
 *
 * The kick is signed with the direction rather than with the onset, so a beat
 * always pushes the smoke the way it is already visibly turning.
 */
export function stepSpin(s: SpinState, o: SpinStep): number {
  const dt = Number.isFinite(o.dt) ? Math.max(0, Math.min(0.1, o.dt)) : 0;
  const onset = Number.isFinite(o.onset) ? clamp01(o.onset) : 0;
  const conf = Number.isFinite(o.beatConf) ? clamp01(o.beatConf) : 0;
  const pulse = Number.isFinite(o.downbeatPulse ?? 0) ? clamp01(o.downbeatPulse ?? 0) : 0;
  // A bar line is the rising edge of the pulse, not its level: the level is an
  // exponential that spends most of a bar somewhere in the middle.
  const bar = pulse >= DOWNBEAT_EDGE && s.lastPulse < DOWNBEAT_EDGE;
  s.lastPulse = pulse;

  if (o.reverse) {
    // From wherever the last flip had got to, so two cues close together do
    // not snap the field back to full speed on the way through.
    s.from = direction(s);
    s.dir = -Math.sign(s.from === 0 ? s.dir : s.from);
    s.reverseLeft = SPIN_REVERSE_SEC;
  } else if (s.reverseLeft > 0) {
    s.reverseLeft = Math.max(0, s.reverseLeft - dt);
  }

  const dir = direction(s);
  s.kick *= Math.exp(-dt / SPIN_KICK_TAU);
  // Every kick is scaled by the grid's confidence: a shove on a beat nobody
  // found is a shove at a random instant, and a field that lurches on nothing
  // reads as a bug rather than as rhythm.
  //
  // `pulse` rocks — the sign alternates bar by bar, so the smoke swings rather
  // than winding up — and the two motions that are supposed to glide keep half
  // a kick. Everything else is shoved the way it is already turning.
  const rock = o.motion === 'pulse' && s.bar % 2 === 1 ? -1 : 1;
  const glide = o.motion === 'flow' || o.motion === 'drift' ? SPIN_GLIDE_KICK : 1;
  const sign = (dir >= 0 ? 1 : -1) * rock;
  if (!o.reducedMotion) {
    if (onset > 0) s.kick += SPIN_KICK * onset * conf * glide * sign;
    if (bar) s.kick += SPIN_DOWNBEAT_KICK * conf * glide * sign;
  }
  // Counted after the kick, so the *first* bar of a track shoves forward and
  // the second shoves back rather than the other way round.
  if (bar) s.bar += 1;
  if (o.reducedMotion) s.kick = 0;
  else s.kick = Math.max(-SPIN_KICK_MAX, Math.min(SPIN_KICK_MAX, s.kick));

  const base = spinBaseRate(o) * (o.reducedMotion ? SPIN_REDUCED : 1);
  s.rate = base * dir + s.kick;
  s.angle = wrapAngle(s.angle + s.rate * dt);
  return s.angle;
}

/** Where between `from` and `dir` the reversal has got to, in [−1, 1]. */
function direction(s: SpinState): number {
  if (s.reverseLeft <= 0) return s.dir;
  const t = 1 - s.reverseLeft / SPIN_REVERSE_SEC;
  return s.from + (s.dir - s.from) * t;
}

function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const TAU = Math.PI * 2;
  const x = a % TAU;
  return x < 0 ? x + TAU : x;
}

// ───────────────────────────────────────────────────────────── the annulus

/** How far past the card's own corner the birth ring reaches, in uv. */
export const ANNULUS_BAND = 0.18;
/** The virtual card, when there is no real one: `min(30vw, 440px)`, as the sheet. */
export const VIRTUAL_CARD_VW = 0.3;
export const VIRTUAL_CARD_MAX_PX = 440;
/** No ring wider than this; a card bigger than the frame is a bug, not a look. */
const MAX_INNER = 1.5;

/** As much of a `DOMRect` as the annulus needs. */
export interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the smoke is born: a centre in uv and two radii.
 *
 * The radii are in the *aspect-corrected* space the inject shader works in —
 * `(uv − 0.5)·vec2(aspect, 1)`, where the frame is `aspect` wide and 1 tall and
 * a square on screen is still a square. That is the only space in which "the
 * card's half-diagonal" is one number: in raw uv a centred square is an
 * ellipse, and a ring built on it would be born closer to the card at the top
 * than at the side.
 *
 * The centre stays in uv, because that is what the shader interpolates. Note
 * the y flip: a `DOMRect` counts down from the top of the page and uv counts up
 * from the bottom of the frame.
 */
export interface Annulus {
  cx: number;
  cy: number;
  inner: number;
  outer: number;
}

export function annulusFor(rect: CardRect | null, vw: number, vh: number): Annulus {
  const width = Math.max(1, vw);
  const height = Math.max(1, vh);

  const usable =
    rect !== null &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 1 &&
    rect.height > 1;

  if (!usable) {
    const side = Math.min(VIRTUAL_CARD_VW * width, VIRTUAL_CARD_MAX_PX);
    const half = side / 2 / height;
    return ring(0.5, 0.5, Math.hypot(half, half));
  }

  const cx = (rect.x + rect.width / 2) / width;
  const cy = 1 - (rect.y + rect.height / 2) / height;
  // Both half-extents divided by the *height*: x is scaled by the aspect on
  // the way into the shader's space, and `aspect / width` is `1 / height`.
  const halfX = rect.width / 2 / height;
  const halfY = rect.height / 2 / height;
  return ring(cx, cy, Math.hypot(halfX, halfY));
}

function ring(cx: number, cy: number, inner: number): Annulus {
  const r = Math.min(MAX_INNER, Math.max(0, inner));
  return { cx, cy, inner: r, outer: r + ANNULUS_BAND };
}

// ───────────────────────────────────────────────────────────── flourishes

/**
 * How long a drop's burst runs: `0.6 + 0.8·intensity`.
 *
 * A fixed 0.6 s was the "the hit is too short" complaint at the other end from
 * the impact decay. The burst is the largest gesture a single moment makes —
 * six times the outward push, a third of a stop of exposure, a chroma split —
 * and squeezing an overwhelming slam and a polite one into the same six tenths
 * of a second says the two are the same event. They are not, and the model has
 * already said by how much: 0.6 s at the bottom, 1.4 s at the top. The shape is
 * unchanged — `(1 − t)²` over whatever the window is — so a bigger hit does not
 * punch harder, it lets go more slowly, which is what a big room does.
 */
const DROP_BURST_BASE = 0.6;
const DROP_BURST_SPAN = 0.8;

export function dropBurstSec(intensity: number): number {
  const i = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  return DROP_BURST_BASE + DROP_BURST_SPAN * i;
}

/**
 * How long each one-shot runs.
 *
 * Five kinds do something and the rest do not. `build_start` is a section
 * boundary rather than a moment — the director already leans the whole picture
 * on `section === 'build'` — and a tempo or key change is a fact about the
 * music that nobody sees happen.
 *
 * `scream_peak` is 1 s rather than the flare's 0.4: the mirror it opens is
 * specified to hold for a second, and the flare is gated inside it by
 * `applyFlourish`. A flourish's window is the longest thing it does.
 *
 * `drop`'s entry is its *floor*: the real window is `dropBurstSec` of the hit's
 * own intensity, decided when it fires and kept on the state. This table is
 * what a drop is worth when nobody said how hard it was.
 */
export const FLOURISH_SEC: Record<TransitionKind, number> = {
  drop: DROP_BURST_BASE,
  build_start: 0,
  breakdown: 0,
  break_silence: 1.5,
  vocal_entry: 1.2,
  scream_peak: 1,
  quiet_fall: 3,
  tempo_change: 0,
  key_change: 0,
  none: 0,
};

/**
 * How long before the same kind may fire again.
 *
 * Not a smoothing: the timeline can legitimately carry two drops eight seconds
 * apart, and both should land. What this stops is the *same moment* firing
 * twice — a re-anchored prediction and the detector's confirmation of it are
 * two cues about one instant, and a cue read at the boundary of two frames can
 * be seen by both. Every cooldown is at least the flourish's own length, so
 * one can never restart on top of itself.
 *
 * The long ones are judgments about the music rather than about the mechanism:
 * a track has one vocal entry a section and a quiet fall is the end of
 * something, so re-firing either inside ten seconds is the timeline arguing
 * with itself, not a second event.
 */
export const FLOURISH_COOLDOWN: Record<TransitionKind, number> = {
  drop: 4,
  build_start: 0,
  breakdown: 0,
  break_silence: 6,
  vocal_entry: 8,
  scream_peak: 2,
  quiet_fall: 10,
  tempo_change: 0,
  key_change: 0,
  none: 0,
};

export interface FlourishState {
  /** When each kind last fired, on the director's clock. */
  firedAt: Record<TransitionKind, number>;
  /** What is running now, if anything. */
  kind: TransitionKind | null;
  startedAt: number;
  /**
   * How long the one that is running runs for.
   *
   * Kept on the state rather than looked up, because a drop's window depends on
   * how hard *that* drop hit and the answer has to be the same for every frame
   * of it — reading the intensity again each frame would shorten the window as
   * the impact decayed underneath it.
   */
  seconds: number;
  /**
   * Where `activeFlourish` writes its answer.
   *
   * It is asked once per frame for the life of the page, and a fresh
   * `{kind, t}` sixty times a second is sixty objects a second for the garbage
   * collector to find — in the one loop in the app that is supposed to
   * allocate nothing at all. One object, overwritten. Read it and do not keep
   * it, like every other per-frame object here.
   */
  active: { kind: TransitionKind; t: number };
}

export function createFlourishes(): FlourishState {
  const firedAt = {} as Record<TransitionKind, number>;
  for (const k of TRANSITION_KINDS) firedAt[k] = Number.NEGATIVE_INFINITY;
  return {
    firedAt,
    kind: null,
    startedAt: Number.NEGATIVE_INFINITY,
    seconds: 0,
    active: { kind: TRANSITION_KINDS[0]!, t: 0 },
  };
}

/**
 * Try to fire `kind` at `now`. Returns whether it took.
 *
 * A clock that has gone *backwards* — the director restarts its own on
 * `prev === null`, and a new track restarts the director — clears the
 * cooldowns rather than locking the new page out for as long as the old one
 * had been running.
 */
export function fireFlourish(
  s: FlourishState,
  kind: TransitionKind,
  now: number,
  intensity = 0,
): boolean {
  if (FLOURISH_SEC[kind] <= 0) return false;
  const last = s.firedAt[kind];
  if (now < last) resetFlourishes(s);
  else if (now - last < FLOURISH_COOLDOWN[kind]) return false;
  s.firedAt[kind] = now;
  // The newest wins outright. Two flourishes at once is two sets of
  // multipliers on the same exposure, which is exactly what the strobe
  // limiter exists to never see.
  s.kind = kind;
  s.startedAt = now;
  // A drop's window is the hit's; everything else runs for its table entry.
  s.seconds = kind === 'drop' ? dropBurstSec(intensity) : FLOURISH_SEC[kind];
  return true;
}

export function resetFlourishes(s: FlourishState): void {
  for (const k of TRANSITION_KINDS) s.firedAt[k] = Number.NEGATIVE_INFINITY;
  s.kind = null;
  s.startedAt = Number.NEGATIVE_INFINITY;
  s.seconds = 0;
}

/**
 * What is firing at `now`, as a kind and a 0..1 progress through its window,
 * or `null`. The object is fresh; the director reads the two fields and drops
 * it, and V8 does not allocate for that.
 */
export function activeFlourish(
  s: FlourishState,
  now: number,
): { kind: TransitionKind; t: number } | null {
  const kind = s.kind;
  if (kind === null) return null;
  const sec = s.seconds > 0 ? s.seconds : FLOURISH_SEC[kind];
  const age = now - s.startedAt;
  if (!(age >= 0) || age >= sec) return null;
  // The state's own scratch object, overwritten; see `FlourishState.active`.
  s.active.kind = kind;
  s.active.t = sec > 0 ? age / sec : 1;
  return s.active;
}

/** Everything a flourish is allowed to touch, as one frame's worth of numbers. */
export interface FlourishEffect {
  /** Multiplies `pushOut`: 6 at the top of a drop's burst. */
  pushOutMul: number;
  /** Added to exposure, before the strobe limiter. */
  exposureAdd: number;
  chromaAdd: number;
  /** An absolute override, or `null` to leave the director's own number. */
  flowAmt: number | null;
  decay: number | null;
  injectGainMul: number;
  grainMul: number;
  /** A *floor* under the kaleidoscope's mix, not a replacement. */
  mirrorMix: number;
  bloomMul: number;
  /** How much brighter the silk burns, 0..1. */
  strandGlow: number;
}

export function neutralFlourish(): FlourishEffect {
  return {
    pushOutMul: 1,
    exposureAdd: 0,
    chromaAdd: 0,
    flowAmt: null,
    decay: null,
    injectGainMul: 1,
    grainMul: 1,
    mirrorMix: 0,
    bloomMul: 1,
    strandGlow: 0,
  };
}

/**
 * Fill `out` with what `kind` is doing at progress `t`.
 *
 * It *overwrites* every field rather than adjusting them, because the director
 * owns one of these for the life of the page: a multiplier left standing from
 * the last flourish would ratchet the picture up over a track.
 *
 * Everything that can be let go of is let go of over the window — `1 − t`,
 * squared for the drop, whose burst is meant to be a punch and not a swell.
 * The two `null`-able overrides are the exception: a decay is a rate and
 * crossfading it against the director's own is not a decay, so they hold for
 * the window and end.
 */
export function applyFlourish(out: FlourishEffect, kind: TransitionKind | null, t: number): void {
  out.pushOutMul = 1;
  out.exposureAdd = 0;
  out.chromaAdd = 0;
  out.flowAmt = null;
  out.decay = null;
  out.injectGainMul = 1;
  out.grainMul = 1;
  out.mirrorMix = 0;
  out.bloomMul = 1;
  out.strandGlow = 0;
  if (kind === null) return;

  const p = clamp01(t);
  const fall = 1 - p;

  switch (kind) {
    case 'drop': {
      const burst = fall * fall;
      out.pushOutMul = 1 + 5 * burst;
      out.exposureAdd = 0.35 * burst;
      out.chromaAdd = 0.02 * burst;
      return;
    }
    case 'break_silence': {
      // The hole: the smoke stops being carried anywhere and falls away in
      // about a second. Held flat across the window — a decay that ramps back
      // is the field coming *back*, which is the next section's job.
      out.flowAmt = 0.05;
      out.decay = 0.9;
      return;
    }
    case 'scream_peak': {
      // 0.4 s of flare inside a 1 s mirror, per the direction.
      const flare = clamp01(1 - p / (0.4 / FLOURISH_SEC['scream_peak']));
      out.exposureAdd = 0.5 * flare;
      out.grainMul = 1 + 1 * flare;
      // Held at full for the second it is specified to hold, and released over
      // the last of it so the figure leaves rather than being switched off.
      out.mirrorMix = 0.6 * clamp01(fall / 0.25);
      return;
    }
    case 'vocal_entry': {
      // A swell rather than a hit: in over the first third, out over the rest.
      const swell = p < 1 / 3 ? p * 3 : 1 - (p - 1 / 3) * 1.5;
      const s = clamp01(swell);
      out.bloomMul = 1 + 0.4 * s;
      out.strandGlow = s;
      return;
    }
    case 'quiet_fall': {
      out.decay = 0.985;
      out.injectGainMul = 0.4 + 0.6 * p;
      return;
    }
    default:
      return;
  }
}

/**
 * Pull a flourish back toward doing nothing at all.
 *
 * `keep` is how much of it survives: 0 leaves the picture exactly as the
 * director had it. Reduced motion and the breath safety both pull this lever
 * rather than switching flourishes off, so a flourish that fires over a
 * talking voice fades out of the frame instead of being cancelled halfway
 * through — the same rule every other clamp in the director follows.
 *
 * The two `null`-able overrides are the exception that proves it: a decay is a
 * rate, and a rate half way between 0.9 and the director's 0.96 is a third
 * behaviour rather than a blend of two. They are dropped outright below 0.5.
 */
export function temperFlourish(e: FlourishEffect, keep: number): void {
  const k = clamp01(keep);
  e.pushOutMul = 1 + (e.pushOutMul - 1) * k;
  e.exposureAdd *= k;
  e.chromaAdd *= k;
  e.injectGainMul = 1 + (e.injectGainMul - 1) * k;
  e.grainMul = 1 + (e.grainMul - 1) * k;
  e.mirrorMix *= k;
  e.bloomMul = 1 + (e.bloomMul - 1) * k;
  e.strandGlow *= k;
  if (k < 0.5) {
    e.flowAmt = null;
    e.decay = null;
  }
}

// ───────────────────────────────────────────────────────────── the rest

/**
 * How fast the smoke is carried out of the annulus, in uv per second.
 *
 * `0.012 + 0.02·arousal + 0.1·impact`: a standing outward creep that fills the
 * frame outside the card in a few seconds and does not stop, plus a hit that
 * throws it. The shader scales it by `PUSH_SCALE` and by `dt`, so it is a
 * velocity and not a per-frame shove.
 */
export function pushOutFor(arousal: number, impact: number): number {
  return 0.012 + 0.02 * clamp01(arousal) + 0.1 * clamp01(impact);
}

/**
 * The spatial frequency of the striations across the flow, in radians per unit
 * of uv. 380 is about sixty stripes across a frame; 600 is nearly a hundred,
 * which at a half-resolution scene buffer is as fine as the sheets can carry
 * before the blur eats them.
 */
export function striateFor(synthetic: number): number {
  return 380 + 220 * clamp01(synthetic);
}

/**
 * How much of the last frame the afterimage keeps.
 *
 * `0.85 + 0.1·hypnotic`, except that a shattering motion is the one thing a
 * smear must not have: the whole character of `shatter` is that the field
 * changes direction in eight discrete steps, and smearing across those turns
 * it into mud. Reduced motion is the other way round again — a persistent
 * after-image of a moving picture is precisely the complaint — so it is off.
 */
export function afterimageDamp(
  hypnotic: number,
  shatter: boolean,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return 0;
  if (shatter) return 0.6;
  return 0.85 + 0.1 * clamp01(hypnotic);
}

/** The traveling wave one frame of mood asks the silk for. */
export interface StrandWave {
  /** How far the wave throws a strand sideways, in world units. */
  amp: number;
  /** Wavelengths down the 4-unit length of a ribbon. */
  freq: number;
  /** How fast the wave travels along it, rad/s. */
  speed: number;
}

export function strandWaveFor(bass: number, tension: number, arousal: number): StrandWave {
  return {
    amp: 0.12 + 0.35 * clamp01(bass),
    freq: 2.5 + 3 * clamp01(tension),
    speed: 1.2 + 4 * clamp01(arousal),
  };
}

/** How far the drift runs before it comes back, in world units either side. */
const DRIFT_WRAP = 3;
/** How fast a strand at the far end of the hash drifts, units per second. */
const DRIFT_RATE = 0.05;

/** `x` folded into [−3, 3]; the GLSL does the same arithmetic. */
export function wrapDrift(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const span = 2 * DRIFT_WRAP;
  return ((((x + DRIFT_WRAP) % span) + span) % span) - DRIFT_WRAP;
}

/**
 * How far sideways a strand is at height `y`, time `t`.
 *
 * Two terms, and the test that matters is about both at once: the wave is what
 * makes a strand *move* and the drift is what stops four hundred of them
 * moving together. Neither is ever still — `amp·speed > 0` for every mood the
 * director can produce, and the drift only stops for a strand whose hash is
 * exactly at the centre, which the wave is still shaking.
 *
 * `h` is the strand's own hash, 0..1, so `h − 0.5` sends half of them one way
 * and half the other.
 */
export function strandOffsetX(
  y: number,
  t: number,
  phase: number,
  h: number,
  w: StrandWave,
): number {
  const wave = w.amp * Math.sin(y * w.freq + t * w.speed + phase);
  return wave + wrapDrift(DRIFT_RATE * t * (h - 0.5));
}

function clamp01(x: number): number {
  return !(x > 0) ? 0 : x > 1 ? 1 : x;
}

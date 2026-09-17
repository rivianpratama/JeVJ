/**
 * How many particles this machine can afford, decided by watching it.
 *
 * The first version of this chose between 262 144 and 589 824 points from
 * `maxTextureSize` and the device pixel ratio — and the pixel-ratio half of
 * that guard could never fire, because the renderer caps the ratio at 1.5
 * before anything reads it. Every GPU got the large cloud and the frame budget
 * rested on a condition that was always true.
 *
 * So it is measured instead. The cloud starts small, and it is promoted only
 * after the machine has actually held a comfortable frame time for three
 * seconds *with music playing* — an idle page is not a measurement of what a
 * track will cost. It is demoted after two seconds it cannot afford.
 *
 * Three things keep that from becoming a flicker:
 *
 *  - the frame time is smoothed with a half-second time constant, so a single
 *    long frame is not a verdict;
 *  - the two thresholds are far apart (9 ms to promote, 14 ms to demote), so
 *    there is no boundary for the reading to sit on;
 *  - a promotion is held back for thirty seconds after the last change.
 *
 * A *demotion* is deliberately not held back. It is the safety valve, and a
 * machine that cannot afford the large cloud should not have to carry it for
 * half a minute because it was promoted twenty-nine seconds ago. The cooldown
 * on promotion is enough to bound the worst case: a machine that keeps failing
 * spends a few seconds large and thirty small, over and over, rather than
 * oscillating freely.
 *
 * Pure: no three.js, no DOM, no clock of its own. The caller owns the state.
 */

/** The two clouds: 512² is 262 144 points, 768² is 589 824. */
export const TIER_SMALL = 512;
export const TIER_LARGE = 768;

/** Below this smoothed frame time the machine is comfortable. */
export const PROMOTE_MS = 9;
/** Above this it is not. */
export const DEMOTE_MS = 14;
/** How long each reading has to hold before it counts. */
export const PROMOTE_HOLD_SEC = 3;
export const DEMOTE_HOLD_SEC = 2;
/** How long after a change the next promotion may happen. */
export const CHANGE_COOLDOWN_SEC = 30;
/** A GPU that can hold a texture this big can address the large cloud. */
export const LARGE_TEXTURE_SIZE = 8192;
/** The frame time's smoothing constant, in seconds. */
export const FRAME_MS_TAU = 0.5;
/** The longest step the decision will take; a backgrounded tab returns huge dt. */
const MAX_DT = 0.25;

export interface TierState {
  /** The tier in use: `TIER_SMALL` or `TIER_LARGE`. */
  size: number;
  /** The smoothed frame time, in ms. */
  frameMs: number;
  /** Whether `frameMs` has had a real sample yet. */
  seeded: boolean;
  /** How long the reading has been comfortable, and how long it has not. */
  fastFor: number;
  slowFor: number;
  /** Seconds since the tier last changed. */
  sinceChange: number;
}

export interface TierInput {
  /** Seconds since the last call. */
  dt: number;
  /** What the last frame cost, in ms, unsmoothed. */
  frameMs: number;
  maxTextureSize: number;
  /** Whether there is audio. An idle page does not earn a promotion. */
  playing: boolean;
  reducedMotion: boolean;
}

export function createTierState(): TierState {
  return {
    size: TIER_SMALL,
    frameMs: 0,
    seeded: false,
    fastFor: 0,
    slowFor: 0,
    // Nothing has changed yet, so the first promotion is not held back.
    sinceChange: Number.POSITIVE_INFINITY,
  };
}

/** How many points a tier holds — what the HUD prints. */
export function tierLabel(size: number): string {
  return `${Math.round((size * size) / 1000)}k`;
}

/**
 * Advance the decision one frame and return the tier to run at. The caller
 * rebuilds only when the answer differs from what it is running.
 */
export function stepTier(s: TierState, i: TierInput): number {
  const dt = Math.max(0, Math.min(MAX_DT, i.dt));

  // A missing or nonsense reading holds the average rather than poisoning it.
  const sample = Number.isFinite(i.frameMs) && i.frameMs >= 0 ? i.frameMs : s.frameMs;
  if (!s.seeded) {
    // Seeded, not eased into from zero: an average climbing out of 0 ms reads
    // as a comfortably fast machine for the first second on every machine.
    s.frameMs = sample;
    s.seeded = true;
  } else {
    s.frameMs += (sample - s.frameMs) * (1 - Math.exp(-dt / FRAME_MS_TAU));
  }

  s.sinceChange += dt;
  s.fastFor = s.frameMs < PROMOTE_MS ? s.fastFor + dt : 0;
  s.slowFor = s.frameMs > DEMOTE_MS ? s.slowFor + dt : 0;
  // Silence costs nothing to draw; time spent in it proves nothing.
  if (!i.playing) s.fastFor = 0;

  const canPromote =
    i.maxTextureSize >= LARGE_TEXTURE_SIZE &&
    !i.reducedMotion &&
    s.fastFor >= PROMOTE_HOLD_SEC &&
    s.sinceChange >= CHANGE_COOLDOWN_SEC;

  if (s.size === TIER_SMALL) {
    if (canPromote) change(s, TIER_LARGE);
  } else if (s.slowFor >= DEMOTE_HOLD_SEC) {
    change(s, TIER_SMALL);
  }
  return s.size;
}

function change(s: TierState, size: number): void {
  s.size = size;
  s.sinceChange = 0;
  s.fastFor = 0;
  s.slowFor = 0;
}

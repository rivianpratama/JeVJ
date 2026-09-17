/**
 * How many pixels this machine can afford, decided by watching it.
 *
 * The renderer caps the device pixel ratio at 1.5 because the ink is a
 * per-pixel feedback loop, and at 1440×900 on the machine this was built on a
 * frame costs about 17 ms there — over the 16.7 ms a 60 Hz display gives you,
 * so every frame is presented late and the picture judders on exactly the
 * material it should be smoothest on. Dropping to 1.25 is 31% fewer pixels for
 * every pass in the chain, and on a field of ink and dust with no hard edges in
 * it, that is close to invisible.
 *
 * So the cap is measured rather than chosen: 1.5 → 1.25 → 1.0 when the frame
 * time will not fit, one step at a time, and back up when it will. The same
 * three things that keep `particleTier` from flickering apply here, for the
 * same reasons: the reading is smoothed over half a second, the two thresholds
 * are far enough apart (11 ms and 16 ms) that no reading can sit on the
 * boundary, and no two changes may happen within ten seconds of each other.
 * Resizing every buffer in the chain is not free, and a governor that did it
 * twice a second would cost more than it saved.
 *
 * Evidence only counts while there is audio. An idle page draws almost nothing,
 * and a cap restored on the strength of an idle frame would be given back the
 * moment a track started.
 *
 * Pure: no three.js, no DOM, no clock of its own. The caller owns the state.
 */

/** The caps, smallest first. 1.5 is where the renderer starts. */
export const DPR_STEPS = [1, 1.25, 1.5] as const;

/** Above this smoothed frame time the machine is not keeping up. */
export const SLOW_MS = 16;
/** Below this it has room to spare. */
export const FAST_MS = 11;
/** How long each reading has to hold before it counts. */
export const SLOW_HOLD_SEC = 3;
export const FAST_HOLD_SEC = 10;
/** How long after a change the next one may happen. */
export const STEP_COOLDOWN_SEC = 10;
/** The frame time's smoothing constant, in seconds. */
export const FRAME_MS_TAU = 0.5;
/** The longest step the decision will take; a hidden page returns huge dt. */
const MAX_DT = 0.25;

export interface DprState {
  /** The pixel-ratio cap in use: one of `DPR_STEPS`. */
  cap: number;
  /** The smoothed frame time, in ms. */
  frameMs: number;
  /** Whether `frameMs` has had a real sample yet. */
  seeded: boolean;
  /** How long the reading has been slow, and how long it has had room. */
  slowFor: number;
  fastFor: number;
  /** Seconds since the cap last changed. */
  sinceChange: number;
}

export interface DprInput {
  /** Seconds since the last call. */
  dt: number;
  /** What the last frame cost on the GPU, in ms, unsmoothed; NaN if unknown. */
  frameMs: number;
  /** Whether there is audio. An idle page is not a measurement. */
  playing: boolean;
}

/** The cap the renderer starts at: the top of the ladder. */
export const DPR_MAX = DPR_STEPS[DPR_STEPS.length - 1]!;

export function createDprState(cap: number = DPR_MAX): DprState {
  return {
    cap,
    frameMs: 0,
    seeded: false,
    slowFor: 0,
    fastFor: 0,
    // Nothing has changed yet, so the first decision is not held back.
    sinceChange: Number.POSITIVE_INFINITY,
  };
}

/**
 * Advance the decision one frame and return the cap to draw at. The caller
 * resizes only when the answer differs from what it is drawing at.
 */
export function stepDpr(s: DprState, i: DprInput): number {
  const dt = Math.max(0, Math.min(MAX_DT, i.dt));
  s.sinceChange += dt;

  // A missing reading holds the average rather than poisoning it: the probe
  // reports NaN before it has measured anything, and there is no number that
  // stands in for "unknown" without being a claim about the machine.
  const sample = Number.isFinite(i.frameMs) && i.frameMs >= 0 ? i.frameMs : null;
  if (sample !== null) {
    if (!s.seeded) {
      s.frameMs = sample;
      s.seeded = true;
    } else {
      s.frameMs += (sample - s.frameMs) * (1 - Math.exp(-dt / FRAME_MS_TAU));
    }
  }
  if (!s.seeded) {
    s.slowFor = 0;
    s.fastFor = 0;
    return s.cap;
  }

  const counts = i.playing;
  s.slowFor = counts && s.frameMs > SLOW_MS ? s.slowFor + dt : 0;
  s.fastFor = counts && s.frameMs < FAST_MS ? s.fastFor + dt : 0;

  if (s.sinceChange < STEP_COOLDOWN_SEC) return s.cap;

  const step = DPR_STEPS.indexOf(s.cap as (typeof DPR_STEPS)[number]);
  // A cap nobody recognises — a caller's own number — is left alone rather than
  // snapped onto the ladder underneath the picture.
  if (step < 0) return s.cap;

  if (s.slowFor >= SLOW_HOLD_SEC && step > 0) return change(s, DPR_STEPS[step - 1]!);
  if (s.fastFor >= FAST_HOLD_SEC && step < DPR_STEPS.length - 1) return change(s, DPR_STEPS[step + 1]!);
  return s.cap;
}

function change(s: DprState, cap: number): number {
  s.cap = cap;
  s.sinceChange = 0;
  s.slowFor = 0;
  s.fastFor = 0;
  return cap;
}

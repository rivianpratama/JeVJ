/**
 * The Breath scene's two scalars, kept out of the scene so they can be tested
 * without a GPU.
 *
 * Breath is the layer that runs over a talking voice, and the one rule it has
 * that no other layer has is that it *must never flash*. Speech is spiky —
 * plosives, sibilants, a laugh — and anything that follows an RMS envelope
 * frame by frame will strobe on it. Two mechanisms, in series:
 *
 *  - **`smoothRms`**: a 0.15 s first-order lag on the loudness, which is what
 *    the ridges' height follows. Fast enough that the band still visibly
 *    answers the voice, slow enough that a single consonant is a swell rather
 *    than a spike.
 *  - **`slewLevel`**: a hard cap on how far the scene's overall brightness may
 *    move in one *frame* — 0.08 of full scale, so the widest possible swing
 *    takes about thirteen frames rather than one. This is a rate limit, not a
 *    lag: a lag still moves a long way on the first frame of a big step, which
 *    is exactly the case a flash comes from. It is per frame rather than per
 *    second on purpose, because what must not flash is the *sequence of frames
 *    the eye sees*, and a dropped frame does not earn a bigger jump.
 *
 * Pure: no three.js, no DOM.
 */

/** The most the scene's level may move between two frames. */
export const MAX_LEVEL_STEP = 0.08;
/** The loudness lag, in seconds. */
export const RMS_TAU = 0.15;

/** Brightness at silence, and how much loudness adds on top. */
const LEVEL_FLOOR = 0.5;
const LEVEL_GAIN = 1.2;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** One frame of the 0.15 s lag on the loudness. */
export function smoothRms(current: number, rms: number, dt: number): number {
  const step = Math.max(0, Math.min(0.1, dt));
  const k = 1 - Math.exp(-step / RMS_TAU);
  const target = Number.isFinite(rms) ? rms : current;
  return current + (target - current) * k;
}

/** How bright the scene wants to be at this smoothed loudness. */
export function levelFor(smoothedRms: number): number {
  if (!Number.isFinite(smoothedRms)) return LEVEL_FLOOR;
  return clamp01(LEVEL_FLOOR + LEVEL_GAIN * smoothedRms);
}

/**
 * `current` moved toward `target` by at most one step. A target inside a step
 * is taken outright, so the level settles rather than dithering around it.
 */
export function slewLevel(current: number, target: number): number {
  if (Number.isNaN(target)) return current;
  const delta = target - current;
  if (delta > MAX_LEVEL_STEP) return current + MAX_LEVEL_STEP;
  if (delta < -MAX_LEVEL_STEP) return current - MAX_LEVEL_STEP;
  return target;
}

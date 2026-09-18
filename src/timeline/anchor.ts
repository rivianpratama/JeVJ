/**
 * Where, in the frames, the music actually stepped.
 *
 * Everything the summarizer finds — a section boundary, a novelty candidate —
 * is stamped at the sample the smoothing finally crossed a threshold on, which
 * is one to two seconds after the listener heard the change. The detector's
 * slams are exact but rare on a compressed master (one to three a track), so
 * most moments have nothing to snap to. The frames are the fallback: a 200 ms
 * loudness mean either side of each frame in the window, and the frame with
 * the biggest step between them is where the energy arrived or left.
 *
 * Pure, and shared by the offline sweep (segment boundaries) and the
 * transition writer (hits and falls found by something other than a slam).
 */

import type { FrameFeatures } from '../shared/types';

/** How far back and forward of the summarizer's time the true step may lie. */
export const ANCHOR_BEFORE_SEC = 2.5;
export const ANCHOR_AFTER_SEC = 0.6;
/** Loudness is averaged over this much on each side of a frame. */
const SPAN_SEC = 0.2;
/** A step smaller than this is the music breathing, not turning. */
const MIN_STEP_DB = 3;
/** Digital silence is -100 dBFS; a step is measured against the music, not that. */
const FLOOR_DB = -70;

export type StepDirection = 'rise' | 'fall' | 'either';

/**
 * The frame time of the steepest loudness step around `at`, or undefined when
 * nothing in the window steps by `MIN_STEP_DB`.
 */
export function steepestStep(
  frames: readonly FrameFeatures[],
  at: number,
  direction: StepDirection,
): number | undefined {
  const lo = at - ANCHOR_BEFORE_SEC;
  const hi = at + ANCHOR_AFTER_SEC;
  let best = 0;
  let bestT: number | undefined;
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i]!.t;
    if (t < lo) continue;
    if (t > hi) break;
    const step = meanDb(frames, i, SPAN_SEC) - meanDb(frames, i, -SPAN_SEC);
    const signed = direction === 'rise' ? step : direction === 'fall' ? -step : Math.abs(step);
    if (signed > best) {
      best = signed;
      bestT = t;
    }
  }
  return best >= MIN_STEP_DB ? bestT : undefined;
}

/** Mean dB over the frames within `span` seconds after (or before, negative) frame `i`. */
function meanDb(frames: readonly FrameFeatures[], i: number, span: number): number {
  const t0 = frames[i]!.t;
  let sum = 0;
  let n = 0;
  if (span > 0) {
    for (let j = i; j < frames.length && frames[j]!.t < t0 + span; j++) {
      sum += Math.max(FLOOR_DB, frames[j]!.db);
      n++;
    }
  } else {
    for (let j = i - 1; j >= 0 && frames[j]!.t >= t0 + span; j--) {
      sum += Math.max(FLOOR_DB, frames[j]!.db);
      n++;
    }
  }
  return n === 0 ? FLOOR_DB : sum / n;
}

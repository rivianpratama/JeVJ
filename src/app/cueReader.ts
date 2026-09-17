/**
 * The one place the timeline's clock and the listener's clock meet.
 *
 * Everything on the `CueTimeline` is stamped in *track* time as the analysis
 * reads it, then shifted onto the audio clock in one piece when the element
 * starts (`trackFlow.place`). No writer compensates for anything, because
 * correcting in a writer would shift one source out from under the others and
 * break the comparisons that matter — like "is this measured slam the one the
 * model named".
 *
 * So the correction happens exactly once, here, at the far end: to know what
 * the visuals should be doing at audio time `now`, ask the timeline about
 * `now + latencySec()`. The number is read afresh on every call because the
 * HUD's trim slider moves under the user's hand.
 *
 * **It is negative now.** v1's was positive: the timeline was read *ahead*,
 * because every cue on it was stamped at the end of the analyser window it was
 * found in and was therefore late by up to one window. The offline sweep no
 * longer leaves them there — an impact is refined against the PCM envelope to
 * the instant the attack happened — so what is left to correct is the other
 * delay, the output buffer between `ctx.currentTime` and the speaker, which
 * means reading slightly *behind* the scheduling clock. See `main.latencySec`.
 *
 * Pure: no DOM, no Web Audio. The caller supplies the number.
 */

import type { Cue, TransitionKind } from '../shared/types';
import type { CueReading, CueTimeline } from '../timeline/timeline';

export interface CueReader {
  /** What the visuals should be doing at audio time `now`. */
  at(now: number): CueReading;
  /** The cues due in the next `horizon` seconds of audio. */
  upcoming(now: number, horizon: number): Cue[];
  /** Audio time `now` as the timeline stamps it — for "how far off is this". */
  readTime(now: number): number;
  /**
   * The transition kinds of the cues whose instant fell between two audio
   * times, appended to `out`. Both ends are moved onto the timeline's clock,
   * so a seam fires when the listener hears it rather than when the analyser
   * reaches it.
   */
  passed(from: number, to: number, out: TransitionKind[]): void;
}

/**
 * `latencySec` is the whole offset between the timeline's clock and the
 * listener's, signed so that it is simply added: `−outputLatency + trim`. A
 * positive trim reads further ahead, which is what a bluetooth speaker wants.
 */
export function createCueReader(tl: CueTimeline, latencySec: () => number): CueReader {
  const readTime = (now: number): number => {
    const latency = latencySec();
    return Number.isFinite(latency) ? now + latency : now;
  };

  return {
    readTime,
    at: (now) => tl.at(readTime(now)),
    upcoming: (now, horizon) => tl.upcoming(readTime(now), horizon),
    // Both ends through the same `readTime`, so a trim slider moved between
    // two frames cannot open a gap that swallows a cue or a window that fires
    // one twice.
    passed: (from, to, out) => tl.transitionsIn(readTime(from), readTime(to), out),
  };
}

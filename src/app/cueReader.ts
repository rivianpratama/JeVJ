/**
 * The one place the analysis clock and the listener's clock meet.
 *
 * Everything on the `CueTimeline` is stamped in *analysis time*: the clock the
 * frames come off, which runs late relative to what is coming out of the
 * speakers. The detector reports a transient one analyser window after it
 * sounded, and everything else on the timeline — the beat grid, the drop
 * detector, the offline pass's own cues — is derived from those same frames,
 * so all of it is late by the same amount. Which is why no writer corrects for
 * it: correcting in a writer would shift one source out from under the others
 * and break the comparisons that matter, like "is this measured slam the one
 * the model named".
 *
 * So the correction happens exactly once, here, at the far end: to know what
 * the visuals should be doing at audio time `now`, ask the timeline about
 * `now + latencySec`. The latency is read afresh on every call because the
 * HUD's trim slider moves under the user's hand.
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
 * `latencySec` is how far the analysis runs behind the sound. v2 has one
 * source — a file off our own disk — so it is `ONSET_REPORT_LAG_SEC + trim`,
 * with no capture pipeline in front of it. v1 added a captured tab's own
 * latency here as well; there is no longer a tab to capture.
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

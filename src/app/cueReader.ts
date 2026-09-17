/**
 * The one place the analysis clock and the listener's clock meet.
 *
 * Everything on the `CueTimeline` is stamped in *analysis time*: the clock the
 * frames come off, which runs late relative to what is coming out of the
 * speakers. The detector reports a transient one analyser window after it
 * sounded, and with a captured tab the sound had already been through the
 * capture and output pipeline before that. The beat grid, the drop detector
 * and Jev's own predictions are all derived from those frames, so they are all
 * late by the same amount — which is why no writer corrects for it. Correcting
 * in a writer would shift one source out from under the others and break the
 * comparisons that matter, like "is this measured slam the one that was
 * predicted".
 *
 * So the correction happens exactly once, here, at the far end: to know what
 * the visuals should be doing at audio time `now`, ask the timeline about
 * `now + latencySec`. The latency is read afresh on every call because the
 * HUD's trim slider moves under the user's hand.
 *
 * Pure: no DOM, no Web Audio. The caller supplies the number.
 */

import type { Cue } from '../shared/types';
import type { CueReading, CueTimeline } from '../timeline/timeline';

export interface CueReader {
  /** What the visuals should be doing at audio time `now`. */
  at(now: number): CueReading;
  /** The cues due in the next `horizon` seconds of audio. */
  upcoming(now: number, horizon: number): Cue[];
  /** Audio time `now` as the timeline stamps it — for "how far off is this". */
  readTime(now: number): number;
}

/**
 * `latencySec` is how far the analysis runs behind the sound:
 * `ONSET_REPORT_LAG_SEC + captureLatency + trim` for a captured tab, and
 * `ONSET_REPORT_LAG_SEC + trim` for a local file, whose samples never went
 * through a capture pipeline.
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
  };
}

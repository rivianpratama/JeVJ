/**
 * The page the mood layer builds each tick, and the one thing left that reads it.
 *
 * The analysis loop already knows everything a `MoodInput` is made of, so this
 * is not another analysis: it is the thing that keeps *last time*, which is what
 * a section boundary is measured against.
 *
 * **v1 kept two references and this keeps one.** The other was `lastSent` — the
 * payload that actually went out — against which a novelty score accumulated
 * until it was worth spending a call. v2 spends its whole model budget before a
 * track plays and sends nothing while one does, so there is no "last sent" and
 * novelty has nothing to be a gate on. The reference that remains is a payload
 * from about four seconds ago, which is what "the trend flipped" is judged
 * against; it ages on its own and re-takes itself at a boundary, because what
 * came before a boundary is not what the next one should be judged against.
 *
 * Wiring, not analysis: it lives here rather than in `src/analysis` because it
 * keeps state about the session rather than about the sound. Whoever owns the
 * grid hears about boundaries through `onSectionChange`, so the caller driving
 * this is not also the thing deciding what a boundary is for.
 */

import { Summarizer } from '../analysis/summarizer';
import type { AnalysisSnapshot } from './analysisLoop';
import type { MoodInput } from '../shared/types';

/** How stale the section reference may get before it is re-taken, in seconds. */
const SECTION_REFERENCE_SEC = 4;
/**
 * The shortest gap between two reported boundaries. A section change restarts
 * the phrase count in the grid, and the rules can hold over several frames of
 * the same sweep; without this the count would restart on each of them.
 */
const SECTION_COOLDOWN_SEC = 2;

export interface MoodReading {
  input: MoodInput;
  /** True on the frame a boundary is called, at most once per cooldown. */
  sectionChanged: boolean;
}

export interface MoodFeedOptions {
  /**
   * Told about each boundary once, with the audio time it was heard at. The
   * grid's phrase count is restarted from here.
   */
  onSectionChange?: (now: number) => void;
}

export class MoodFeed {
  /** A payload from about `SECTION_REFERENCE_SEC` ago; boundaries only. */
  private sectionRef: MoodInput | null = null;
  private sectionRefAt = -Infinity;
  private lastSectionAt = -Infinity;
  private current: MoodInput | null = null;
  private readonly onSectionChange: ((now: number) => void) | undefined;

  constructor(options: MoodFeedOptions = {}) {
    this.onSectionChange = options.onSectionChange;
  }

  /**
   * Fold one snapshot in. `positionSec`/`durationSec` come from the player;
   * a null duration is a stream of unknown length.
   */
  update(snap: AnalysisSnapshot, positionSec: number, durationSec: number | null): MoodReading {
    const now = snap.features.t;
    const input = Summarizer.fromSnapshot(snap, positionSec, durationSec);
    this.current = input;

    let sectionChanged = Summarizer.sectionChanged(this.sectionRef, input);
    if (sectionChanged && now - this.lastSectionAt < SECTION_COOLDOWN_SEC) sectionChanged = false;
    if (sectionChanged) {
      this.lastSectionAt = now;
      this.onSectionChange?.(now);
    }

    if (
      this.sectionRef === null ||
      sectionChanged ||
      now - this.sectionRefAt >= SECTION_REFERENCE_SEC
    ) {
      this.sectionRef = input;
      this.sectionRefAt = now;
    }
    return { input, sectionChanged };
  }

  /** The most recent payload built. */
  latest(): MoodInput | null {
    return this.current;
  }
}

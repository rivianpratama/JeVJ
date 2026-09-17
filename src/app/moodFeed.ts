/**
 * The page we would send Jev, and the two numbers that decide whether to.
 *
 * The analysis loop already knows everything a `MoodInput` is made of, so this
 * is not another analysis: it is the thing that keeps *last time* — the
 * payload novelty and section changes are measured against — and nothing else.
 * Task 7's client asks it for those numbers; the HUD prints them meanwhile.
 *
 * Two references, because the two questions ask about different pasts:
 *
 * - `lastSent` is the payload that actually went out, and *only* `markSent`
 *   moves it. Novelty is "how much has changed since we last said anything",
 *   so it has to accumulate across a slow drift until something is said; a
 *   reference that re-took itself on a timer would keep zeroing the very
 *   number that is supposed to be growing. Before the first send there is
 *   nothing on record anywhere, so novelty is 1: everything is news.
 * - the section reference is a payload from about four seconds ago, which is
 *   what the plan's "trend flips vs 4 s ago" is measured against. It ages on
 *   its own and re-takes itself at a boundary — what came before a boundary is
 *   not what the next one should be judged against — and it never touches
 *   `lastSent`.
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
  /** 0..1 against the payload last sent; 1 until one has been. */
  novelty: number;
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
  /** What actually went out. Only `markSent` writes this. */
  private sent: MoodInput | null = null;
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

    const novelty = this.sent === null ? 1 : Summarizer.novelty(this.sent, input);

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
    return { input, novelty, sectionChanged };
  }

  /** The payload that was last sent, which novelty is measured against. */
  lastSent(): MoodInput | null {
    return this.sent;
  }

  /** The most recent payload built, sent or not. */
  latest(): MoodInput | null {
    return this.current;
  }

  /** Task 7 calls this with the payload a request actually carried. */
  markSent(input: MoodInput): void {
    this.sent = input;
  }
}

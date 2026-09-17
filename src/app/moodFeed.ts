/**
 * The page we would send Jev, and the two numbers that decide whether to.
 *
 * The analysis loop already knows everything a `MoodInput` is made of, so this
 * is not another analysis: it is the thing that keeps *last time* — the
 * payload novelty and section changes are measured against — and nothing else.
 * Task 7's client asks it for those numbers; the HUD prints them meanwhile.
 *
 * The reference re-latches when the payload is sent, and otherwise every four
 * seconds. That is what makes the readings mean something: novelty is "how
 * much has changed since we last said anything, or in the last four seconds",
 * and a boundary is judged against a payload from about four seconds ago,
 * which is what the plan's "vs 4 s ago" asks for. A reference that never aged
 * would make novelty a measure of the whole track, and one that aged every
 * frame would make it zero forever.
 *
 * Wiring, not analysis: it lives here rather than in `src/analysis` because it
 * keeps state about the session rather than about the sound.
 */

import { Summarizer } from '../analysis/summarizer';
import type { AnalysisSnapshot } from './analysisLoop';
import type { MoodInput } from '../shared/types';

/** How stale the reference may get before it is re-taken, in audio seconds. */
const REFERENCE_SEC = 4;
/**
 * The shortest gap between two reported boundaries. A section change restarts
 * the phrase count in the grid, and the rules can hold over several frames of
 * the same sweep; without this the count would restart on each of them.
 */
const SECTION_COOLDOWN_SEC = 2;

export interface MoodReading {
  input: MoodInput;
  /** 0..1 against the reference payload; 0 until there is one. */
  novelty: number;
  /** True on the frame a boundary is called, at most once per cooldown. */
  sectionChanged: boolean;
}

export class MoodFeed {
  /** What novelty and boundaries are measured against. */
  private reference: MoodInput | null = null;
  private referenceAt = -Infinity;
  private lastSectionAt = -Infinity;
  private current: MoodInput | null = null;

  /**
   * Fold one snapshot in. `positionSec`/`durationSec` come from the player;
   * a null duration is a stream of unknown length.
   */
  update(snap: AnalysisSnapshot, positionSec: number, durationSec: number | null): MoodReading {
    const now = snap.features.t;
    const input = Summarizer.fromSnapshot(snap, positionSec, durationSec);
    this.current = input;

    const novelty = this.reference === null ? 0 : Summarizer.novelty(this.reference, input);

    let sectionChanged = Summarizer.sectionChanged(this.reference, input);
    if (sectionChanged && now - this.lastSectionAt < SECTION_COOLDOWN_SEC) sectionChanged = false;
    if (sectionChanged) this.lastSectionAt = now;

    // A boundary re-takes the reference too: what came before it is no longer
    // the thing the next reading should be compared against.
    if (this.reference === null || sectionChanged || now - this.referenceAt >= REFERENCE_SEC) {
      this.latch(input, now);
    }
    return { input, novelty, sectionChanged };
  }

  /** The payload novelty is currently measured against. */
  lastSent(): MoodInput | null {
    return this.reference;
  }

  /** The most recent payload built, sent or not. */
  latest(): MoodInput | null {
    return this.current;
  }

  /** Task 7 calls this once a request actually goes out. */
  markSent(now: number): void {
    if (this.current !== null) this.latch(this.current, now);
  }

  private latch(input: MoodInput, now: number): void {
    this.reference = input;
    this.referenceAt = now;
  }
}

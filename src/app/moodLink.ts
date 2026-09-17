/**
 * The mood layer as one object: feed in, state, mood out.
 *
 * `main.ts` should not have to know that a payload is summarised before it is
 * anything else, or that an answer is aimed at rather than assigned. It has one
 * tick and gets back the mood to draw with.
 *
 * **v2 does not ask anything while a track plays, and this is what is left of
 * the layer that used to.** The whole track is judged before a sample of it
 * sounds: `trackAnalysis` runs two passes over the decoded audio, the answers
 * go on the timeline as cues, and `effectiveMood` lets those cues win wherever
 * they exist. A live call could only ever contradict a better-informed one, on
 * a page whose model budget has already been spent — so v1's `MoodClient`, its
 * cadence, its novelty gate, its backoff and the phrase look-ahead that fed it
 * are gone rather than switched off.
 *
 * What still has to happen every tick is the feed: the HUD reads its payload
 * and its novelty, and the beat grid counts phrases from the section boundaries
 * only the feed hears. And the state still slews, because the timeline's own
 * answers arrive as steps and a picture that snaps on one is a cut.
 */

import type { AnalysisSnapshot } from './analysisLoop';
import type { MoodFeed, MoodReading } from './moodFeed';
import { MoodState } from '../mood/moodState';
import type { MoodVector } from '../shared/types';

export interface MoodLinkOptions {
  feed: MoodFeed;
  state?: MoodState;
}

export interface MoodTick {
  reading: MoodReading;
  mood: MoodVector;
}

export class MoodLink {
  private readonly feed: MoodFeed;
  private readonly state: MoodState;

  constructor(o: MoodLinkOptions) {
    this.feed = o.feed;
    this.state = o.state ?? new MoodState();
  }

  /** One HUD-rate frame: build the payload, advance the mood. */
  update(snap: AnalysisSnapshot, positionSec: number, durationSec: number | null): MoodTick {
    const now = snap.features.t;
    const reading = this.feed.update(snap, positionSec, durationSec);
    return { reading, mood: this.state.tick(now) };
  }

  /** The mood as of the last tick. */
  mood(): MoodVector {
    return this.state.current();
  }
}

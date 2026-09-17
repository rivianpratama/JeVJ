/**
 * The mood pipeline as one object: feed in, client, state, HUD out.
 *
 * `main.ts` should not have to know that a payload is built before a cadence
 * is decided, that the payload only counts as *sent* once a request actually
 * starts, or that an answer is aimed at rather than assigned. It has one tick
 * and gets back the mood to draw with. Everything the tick needs is on the
 * snapshot or is a fact about the page (playing, visible), and every instant
 * is the audio clock, so a backgrounded tab neither ages the cadence nor
 * fast-forwards the slew.
 *
 * The phrase look-ahead is the one piece of arithmetic here, and it is why
 * this file exists rather than three lines in `main`: the client wants to know
 * how long until the next 16-bar boundary, and only the grid can say.
 */

import type { AnalysisSnapshot } from './analysisLoop';
import type { MoodFeed, MoodReading } from './moodFeed';
import { MoodClient, type MoodStats } from '../mood/moodClient';
import { MoodState } from '../mood/moodState';
import type { GridState } from '../analysis/grid';
import type { MoodVector } from '../shared/types';

/** Bars in the phrase the grid counts, matching `GridState.barInPhrase`. */
const PHRASE_BARS = 16;

export interface MoodLinkOptions {
  feed: MoodFeed;
  client?: MoodClient;
  state?: MoodState;
}

export interface MoodTick {
  reading: MoodReading;
  mood: MoodVector;
  stats: MoodStats;
  /** Seconds until the client may ask again; 0 when it already may. */
  nextIn: number;
}

export class MoodLink {
  private readonly feed: MoodFeed;
  private readonly client: MoodClient;
  private readonly state: MoodState;
  /** The most recent audio time, which a late answer is applied at. */
  private now = 0;

  constructor(o: MoodLinkOptions) {
    this.feed = o.feed;
    this.client = o.client ?? new MoodClient();
    this.state = o.state ?? new MoodState();
  }

  /** One HUD-rate frame: build the payload, maybe ask, advance the mood. */
  update(
    snap: AnalysisSnapshot,
    positionSec: number,
    durationSec: number | null,
    playing: boolean,
    visible: boolean,
  ): MoodTick {
    const now = snap.features.t;
    this.now = now;
    const reading = this.feed.update(snap, positionSec, durationSec);

    const pending = this.client.maybeRequest(
      now,
      reading.input,
      reading.novelty,
      reading.sectionChanged,
      playing,
      visible,
      // Before a tempo has been measured the grid is free-running on its
      // default, and a "boundary" off it would be a boundary in nothing.
      snap.tempo === null ? null : phraseBoundaryIn(snap.grid, now),
    );

    if (pending !== null) {
      // Only now is this payload the one novelty is measured against.
      this.feed.markSent(reading.input);
      void pending.then((res) => {
        if (res !== null) this.state.setTarget(res.mood, this.now);
      });
    }

    return {
      reading,
      mood: this.state.tick(now),
      stats: this.client.stats(),
      nextIn: Math.max(0, this.client.nextAllowedAt() - now),
    };
  }

  /** The mood as of the last tick. */
  mood(): MoodVector {
    return this.state.current();
  }
}

/**
 * Seconds until the downbeat that starts the next 16-bar phrase, or null when
 * the grid is not running well enough to say.
 *
 * `barInPhrase` is the bar we are in, so the bars left to play include this
 * one: the boundary is the next downbeat plus the remaining whole bars after
 * the one that downbeat starts.
 */
export function phraseBoundaryIn(grid: GridState, now: number): number | null {
  if (!(grid.period > 0) || !Number.isFinite(grid.nextBeat)) return null;

  // `nextBeat` carries index `beatIndex`; walk forward to the first index that
  // is a downbeat.
  const toDownbeat = (((grid.downbeatOffset - grid.beatIndex) % grid.barLength) + grid.barLength) % grid.barLength;
  const downbeatAt = grid.nextBeat + toDownbeat * grid.period;

  const barsRemaining = Math.max(1, PHRASE_BARS - grid.barInPhrase);
  const secs = downbeatAt - now + (barsRemaining - 1) * grid.barLength * grid.period;
  return secs >= 0 ? secs : null;
}

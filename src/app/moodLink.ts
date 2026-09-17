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
  /**
   * Told about each answer as it is applied, with the audio time the question
   * it answers was *sent* at — not the time it came back. Task 8's Jev writer
   * hangs off this: an answer is both a mood to slew toward and a set of cues
   * to schedule, the cues are counted in beats from the moment Jev was looking
   * at, and only this file knows when that was.
   */
  onMood?: (mood: MoodVector, askedAt: number) => void;
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
  private readonly onMood: ((mood: MoodVector, askedAt: number) => void) | undefined;
  /** The most recent audio time, which a late answer is applied at. */
  private now = 0;

  constructor(o: MoodLinkOptions) {
    this.feed = o.feed;
    this.client = o.client ?? new MoodClient();
    this.state = o.state ?? new MoodState();
    this.onMood = o.onMood;
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
      // The instant the question went out. The answer describes the music as
      // it was then — "a drop in eight beats" counts from the frame Jev was
      // shown, not from whenever the reply got back — so the cues are written
      // against `askedAt`. The mood *slew*, on the other hand, starts moving
      // when the answer lands, because that is when the app learned anything.
      const askedAt = now;
      void pending.then((res) => {
        if (res === null) return;
        this.state.setTarget(res.mood, this.now);
        this.onMood?.(res.mood, askedAt);
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

  /**
   * Aim at `m` without asking anyone.
   *
   * There is one caller: the sound has gone away — the user stopped sharing the
   * tab — and nothing is going to replace it. The last judgment is about music
   * that is no longer playing, so after a decent interval the caller points this
   * at the idle mood and lets the ordinary slew take it there. It is a *target*
   * rather than an assignment for that reason: a picture that snaps to idle is
   * a cut, and the thing that just happened was not a cut, it was a silence.
   */
  fadeTo(m: MoodVector): void {
    this.state.setTarget(m, this.now);
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

/**
 * The beat grid's share of the timeline: where the beats are going to be.
 *
 * The grid already predicts; this only decides how far ahead to write and
 * hands the answer to the timeline as that source's whole future. Rewriting
 * rather than appending is what keeps the prediction honest — the grid drifts
 * with the music between calls, and a beat written eight seconds ago against
 * an older phase is worse than no beat at all.
 *
 * Pure: a timeline, a grid and a clock in, nothing else touched.
 */

import type { BeatGrid } from '../analysis/grid';
import type { Cue } from '../shared/types';
import type { CueTimeline } from './timeline';

/** How far ahead the live window looks, in seconds. */
export const GRID_HORIZON_SEC = 8;
/** Floating point slack, so a beat landing exactly on the horizon is kept. */
const EPS = 1e-9;

/** What this writer needs of a grid — a stub satisfies it in tests. */
export type GridSource = Pick<BeatGrid, 'state' | 'predict'>;

export function writeGridCues(
  tl: CueTimeline,
  grid: GridSource,
  now: number,
  horizon: number = GRID_HORIZON_SEC,
): void {
  const { period } = grid.state();
  if (!(period > 0) || !Number.isFinite(period)) return;

  // Two spare: `predict` counts from the next beat, which may sit just after
  // `now`, and the last one is dropped by the horizon filter anyway.
  const count = Math.ceil(horizon / period) + 2;
  const cues: Cue[] = [];
  for (const beat of grid.predict(count, now)) {
    if (beat.t > now + horizon + EPS) break;
    cues.push({ t: beat.t, source: 'grid', beat: true, downbeat: beat.downbeat });
  }
  tl.replaceSource('grid', now, cues);
}

/**
 * Jev's judgment, turned into instructions with timestamps.
 *
 * Two different things arrive in one `MoodVector` and they belong on the
 * timeline in two different ways. The mood itself is a description of *now* —
 * it goes down at `now` and the timeline interpolates from there. The
 * prediction ("a drop lands in eight beats, and it will hit this hard") is a
 * statement about a moment that has not happened yet, and a model that answers
 * in a few hundred milliseconds cannot be trusted with the moment — only with
 * roughly which one. So the beats count is resolved against the *grid*: the
 * predicted downbeat nearest to it, and if the downbeat that starts the next
 * phrase is within two bars of that, that one instead, because that is where
 * EDM and pop actually put the drop.
 *
 * Then the anticipation: a `build` ramp on the timeline's own 0.2 s step from
 * now to the target, released one step after it, so the visuals tighten into
 * the hit and then let go rather than staying wound up for the rest of the
 * track. The hit itself is one exact cue, which the detector will re-anchor
 * when the transient really arrives (`detectorWriter`) and which decays on its
 * own afterwards if it never does.
 *
 * Pure: no clock of its own, no DOM. `now` is the audio time the *question*
 * was asked at, not the time the answer came back — a model that takes half a
 * second to reply is describing the music it was shown, and "eight beats from
 * now" counts from then. `MoodLink` keeps that time for us.
 */

import type { BeatGrid } from '../analysis/grid';
import type { Cue, MoodVector } from '../shared/types';
import type { CueTimeline } from './timeline';

/** How sure Jev has to be that something is landing before we schedule it. */
const DROP_CONFIDENCE = 0.6;
/** How sure it has to be about a breakdown before we write one down. */
const SECTION_CONFIDENCE = 0.6;
/** Bars in a phrase, matching the count `GridState.barInPhrase` keeps. */
const PHRASE_BARS = 16;
/** How far from the beats-count target a phrase boundary may be and still win. */
const SNAP_BARS = 2;
/** Floating point slack on the bar comparisons. */
const EPS = 1e-9;

/** What this writer needs of a grid — a stub satisfies it in tests. */
export type GridLike = Pick<BeatGrid, 'state' | 'predict'>;

export function writeJevCues(tl: CueTimeline, mood: MoodVector, grid: GridLike, now: number): void {
  const state = grid.state();

  // What Jev thinks is happening, as of the moment it was asked.
  tl.add({ t: now, source: 'jev', mood });
  if (mood.section === 'breakdown' && (mood.sectionP.breakdown ?? 0) >= SECTION_CONFIDENCE) {
    tl.add({ t: now, source: 'jev', section: 'breakdown' });
  }

  if (mood.dropImminent < DROP_CONFIDENCE || mood.beatsToChange === 'none') return;
  const beats = Number(mood.beatsToChange);
  if (!Number.isFinite(beats) || beats <= 0) return;
  if (!(state.period > 0) || !Number.isFinite(state.period)) return;

  const barSec = state.period * state.barLength;
  const wanted = now + beats * state.period;
  // Far enough ahead to see the snap window past the target, whichever
  // downbeat the beats count lands nearest.
  const horizon = wanted - now + (SNAP_BARS + 1) * barSec;
  const downbeats = predictedDownbeats(grid, now, horizon, state.barsSinceChange);
  if (downbeats.length === 0) return;

  let target = nearest(downbeats.map((d) => d.t), wanted);
  const boundary = downbeats.filter((d) => d.phrase).map((d) => d.t);
  if (boundary.length > 0) {
    const candidate = nearest(boundary, target);
    if (Math.abs(candidate - target) <= SNAP_BARS * barSec + EPS) target = candidate;
  }
  if (!(target > now)) return;

  // The last prediction is superseded, not added to: its ramp was drawn
  // against a target this one has just moved. The impact cue goes with it —
  // one hit is being predicted here, not two — but only the *predicted* one:
  // anything the detector has already measured is a different source.
  tl.remove(
    (c) => c.source === 'jev' && c.t >= now && (c.build !== undefined || c.impact !== undefined),
  );

  const span = target - now;
  for (let i = 0; now + i * tl.step < target; i++) {
    const t = now + i * tl.step;
    tl.add({ t, source: 'jev', build: (t - now) / span });
  }
  tl.add({ t: target, source: 'jev', impact: mood.impact, build: 1, section: 'drop_climax' });
  // And the ramp is closed one step after the hit. Without this the build
  // stays at 1 for as long as nobody writes another one — the anticipation was
  // for the drop, and the drop has happened.
  tl.add({ t: target + tl.step, source: 'jev', build: 0 });
}

/**
 * The downbeats the grid expects in the next `horizon` seconds, each marked
 * with whether it starts a phrase.
 *
 * The grid counts bars since the last section change, and increments that
 * count on each downbeat it emits, so the k-th downbeat from here starts bar
 * `barsSinceChange + k` — a phrase boundary when that is a multiple of 16.
 */
function predictedDownbeats(
  grid: GridLike,
  now: number,
  horizon: number,
  barsSinceChange: number,
): Array<{ t: number; phrase: boolean }> {
  const { period } = grid.state();
  const count = Math.ceil(horizon / period) + 2;

  const out: Array<{ t: number; phrase: boolean }> = [];
  let bar = 0;
  for (const beat of grid.predict(count, now)) {
    if (beat.t > now + horizon + EPS) break;
    if (!beat.downbeat) continue;
    bar += 1;
    out.push({ t: beat.t, phrase: (barsSinceChange + bar) % PHRASE_BARS === 0 });
  }
  return out;
}

/** The value in `xs` closest to `to`; ties go to the earlier one. */
function nearest(xs: number[], to: number): number {
  let best = xs[0]!;
  for (const x of xs) if (Math.abs(x - to) < Math.abs(best - to)) best = x;
  return best;
}

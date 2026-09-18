/**
 * The local detector's share of the timeline: the moment it actually happened.
 *
 * The offline pass says a drop is *here*, from a sweep of the whole file; this
 * says *now*, from the frames as they arrive. When the two agree — a measured
 * slam within a beat of a named one — the named cue is not replaced but moved
 * onto the measurement (`reanchor`), so the ramp that has been building for two
 * bars still lands on the hit. The grid moves with
 * it, but only until the next HUD tick: `writeGridCues` rewrites the grid's
 * whole horizon from the grid's own phase at 15 Hz, so the shift is a stopgap
 * that keeps one frame's reading honest, not a correction to the beat grid.
 * (The grid itself learns the same transient through `onOnset`.)
 *
 * When nothing on the timeline named the hit, it is written on its own: less
 * anticipation, same exact instant. When a named hit is never confirmed this
 * writer does nothing, and it still fires at its own time — the timeline only
 * decays it *afterwards*. That is deliberate: a scheduled hit is what the
 * anticipation was drawn for. The `source` tag is what tells them apart, so a
 * director that would rather not flash on an unconfirmed prediction can gate
 * on `jev` versus `detector` itself.
 *
 * One clock: the event's own timestamp goes on the timeline untouched. It is
 * the frame the detector was *called* on, one analyser window after the
 * transient sounded, and that is the same late clock the grid, the frames and
 * Jev's cues are on — comparing a measurement with a named moment only works
 * because neither has been shifted. `src/app/cueReader.ts` takes the lag off
 * once, when the timeline is read.
 *
 * Pure: no DOM, no Web Audio.
 */

import type { DropEvent } from '../analysis/drop';
import type { Cue } from '../shared/types';
import type { CueTimeline } from './timeline';

/**
 * How far from a prediction a measurement still counts as the same hit, and
 * the shortest a hole's release may be: half a second is one beat at 120 BPM,
 * which is the assumption to make when there is no grid to ask.
 */
const DEFAULT_BEAT_SEC = 0.5;
/**
 * How old an event may be and still be worth writing down. The live timeline
 * keeps two seconds of history; a cue older than that is about a moment the
 * renderer has already drawn.
 */
const STALE_SEC = 2;

export interface DetectorWriterOptions {
  /** One beat, in seconds — the window a prediction may be off by. */
  beatSec?: number;
}

export function applyDetectorEvent(
  tl: CueTimeline,
  ev: DropEvent,
  now: number,
  o: DetectorWriterOptions = {},
): void {
  const beat = o.beatSec !== undefined && o.beatSec > 0 ? o.beatSec : DEFAULT_BEAT_SEC;
  const t = ev.t;
  if (now - t > STALE_SEC) return;

  if (ev.kind === 'gap') {
    // A hole is the far end of an anticipation, not a hit: the visuals should
    // be at full tension when the floor drops out — and then let go again. A
    // hole that nothing follows up on is a quiet passage, not a held breath,
    // so the ramp is closed a beat later rather than left standing.
    tl.add({ t, source: 'detector', build: 1 });
    tl.add({ t: t + Math.max(beat, DEFAULT_BEAT_SEC), source: 'detector', build: 0 });
    return;
  }

  const predicted = nearestPrediction(tl.cues(), t, beat);
  if (predicted === null) {
    tl.add({ t, source: 'detector', impact: ev.strength });
    return;
  }

  // Move the prediction — and everything scheduled against it — onto the
  // instant, then write the measured strength onto it. The timeline merges
  // the two (same source, same instant) and keeps the louder reading.
  tl.reanchor(predicted.t, t);
  tl.add({ t, source: 'jev', impact: ev.strength });
}

/** The predicted impact nearest `t` within `beat` seconds, or null. */
function nearestPrediction(cues: readonly Cue[], t: number, beat: number): Cue | null {
  let best: Cue | null = null;
  for (const c of cues) {
    if (c.source !== 'jev' || c.impact === undefined) continue;
    const away = Math.abs(c.t - t);
    if (away > beat) continue;
    if (best === null || away < Math.abs(best.t - t)) best = c;
  }
  return best;
}

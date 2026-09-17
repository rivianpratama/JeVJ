/**
 * The local detector's share of the timeline: the moment it actually happened.
 *
 * Jev says a drop is coming and roughly where; this says *now*. When the two
 * agree — a measured slam within a beat of a predicted one — the prediction is
 * not replaced but moved onto the measurement (`reanchor`), so everything that
 * was scheduled against it, the grid included, slides with it and the
 * anticipation that has been building for two bars still lands on the hit.
 * When nothing predicted it, the hit is written on its own: less anticipation,
 * same exact instant. When a prediction is never confirmed, this writer does
 * nothing at all and the timeline's decay takes care of it — a drop that did
 * not happen must not be shown.
 *
 * Two clocks are reconciled here. The detector stamps an event with the frame
 * it was *called* on, which is one analyser window after the transient
 * sounded (`ONSET_REPORT_LAG_SEC`), and the sound itself reached the ears a
 * capture-and-output latency before that. Both come off before the cue time,
 * so what goes on the timeline is when the listener heard it.
 *
 * Pure: no DOM, no Web Audio.
 */

import { ONSET_REPORT_LAG_SEC } from '../analysis/onset';
import type { DropEvent } from '../analysis/drop';
import type { Cue } from '../shared/types';
import type { CueTimeline } from './timeline';

/** How far from a prediction a measurement still counts as the same hit. */
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
  /** Measured capture + output latency, plus the user's trim, in seconds. */
  latencySec?: number;
}

export function applyDetectorEvent(
  tl: CueTimeline,
  ev: DropEvent,
  now: number,
  o: DetectorWriterOptions = {},
): void {
  const beat = o.beatSec !== undefined && o.beatSec > 0 ? o.beatSec : DEFAULT_BEAT_SEC;
  const t = ev.t - ONSET_REPORT_LAG_SEC - (o.latencySec ?? 0);
  if (now - t > STALE_SEC) return;

  if (ev.kind === 'gap') {
    // A hole is the far end of an anticipation, not a hit: the visuals should
    // be at full tension when the floor drops out.
    tl.add({ t, source: 'detector', build: 1 });
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

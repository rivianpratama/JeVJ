/**
 * An analysis snapshot as the handful of strings the HUD prints.
 *
 * Presentation, deliberately kept out of both sides: the HUD should not have
 * to know what a beat grid is, and the analysis should not have to know that
 * anything is watching. Pure — it formats, it does not touch the document.
 */

import type { AnalysisSnapshot } from './analysisLoop';
import type { HudData } from '../ui/hud';

/** Width of the beat-position bar. */
const PHASE_CELLS = 10;
/** Height of a band meter, in blocks. */
const BAND_BLOCKS = 8;
/** What a field reads before there is anything to read. */
const UNMEASURED = '—';
/**
 * How long a drop stays on the HUD. The snapshot's event is sticky so that a
 * consumer reading at its own rate cannot miss one; printed as-is that makes
 * the row announce a drop from minutes ago for the rest of the track.
 */
const DROP_HOLD_SEC = 2;

/** What the mood feed knows and the snapshot does not. */
export interface MoodRows {
  /** 0..1 against the payload last sent. */
  novelty: number;
  /** Estimated token cost of that payload serialized. */
  tokens: number;
}

export function hudRows(snap: AnalysisSnapshot, feed: MoodRows | null = null): HudData {
  const { features: f, grid, key, rhythm, dynamics, timbre } = snap;

  const mood: Record<string, string | number> = {
    rms: f.rms.toFixed(3),
    centroid: `${Math.round(f.centroid)} Hz`,
    phase: phaseBar(snap.phase),
    bar: `${grid.barInPhrase + 1}/16`,
    modal: key.modal,
    modeConf: key.modeConf.toFixed(2),
    fit: key.fit.toFixed(2),
    consonance: timbre.consonance.toFixed(2),
    bright: timbre.bright.toFixed(2),
    noise: timbre.noise.toFixed(2),
    attack: timbre.attack,
    meter: rhythm.meter,
    sync: rhythm.sync.toFixed(2),
    regular: rhythm.regular.toFixed(2),
    range: dynamics.range.toFixed(2),
    trend: dynamics.trend,
    crest: dynamics.crest.toFixed(2),
    novelty: feed ? feed.novelty.toFixed(2) : UNMEASURED,
    tokens: feed ? feed.tokens : UNMEASURED,
    drop:
      snap.drop && f.t - snap.drop.t <= DROP_HOLD_SEC
        ? `${snap.drop.kind} ${snap.drop.strength.toFixed(2)}`
        : UNMEASURED,
  };
  for (let i = 0; i < f.bands.length; i++) {
    mood[`b${i}`] = '█'.repeat(Math.round((f.bands[i] ?? 0) * BAND_BLOCKS));
  }

  // Before the first measurement the grid still holds its default 120 BPM at
  // zero confidence. Printed, that reads as a reading; a dash says the truth,
  // which is that nothing has been measured yet.
  const measured = snap.tempo !== null;

  return {
    bpm: measured ? grid.bpm : UNMEASURED,
    beatConf: measured ? grid.confidence : UNMEASURED,
    tempo: snap.tempo?.marking,
    key: key.key,
    mode: key.mode,
    loud: dynamics.loud,
    speech: snap.speech,
    mood,
  };
}

/** Where we are in the beat, as a mark sliding along a ten-cell track. */
export function phaseBar(phase: number): string {
  const at = Math.min(PHASE_CELLS - 1, Math.max(0, Math.floor(phase * PHASE_CELLS)));
  return `${'·'.repeat(at)}|${'·'.repeat(PHASE_CELLS - 1 - at)}`;
}

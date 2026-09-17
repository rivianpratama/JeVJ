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

export function hudRows(snap: AnalysisSnapshot): HudData {
  const { features: f, grid } = snap;

  const mood: Record<string, string | number> = {
    rms: f.rms.toFixed(3),
    centroid: `${Math.round(f.centroid)} Hz`,
    phase: phaseBar(snap.phase),
    bar: `${grid.barInPhrase + 1}/16`,
  };
  for (let i = 0; i < f.bands.length; i++) {
    mood[`b${i}`] = '█'.repeat(Math.round((f.bands[i] ?? 0) * BAND_BLOCKS));
  }

  return { bpm: grid.bpm, beatConf: grid.confidence, tempo: snap.tempo?.marking, mood };
}

/** Where we are in the beat, as a mark sliding along a ten-cell track. */
export function phaseBar(phase: number): string {
  const at = Math.min(PHASE_CELLS - 1, Math.max(0, Math.floor(phase * PHASE_CELLS)));
  return `${'·'.repeat(at)}|${'·'.repeat(PHASE_CELLS - 1 - at)}`;
}

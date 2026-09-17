/**
 * The mood the director actually consumes, and where it came from.
 *
 * There are two mood layers and they do not always agree. `MoodLink` holds the
 * live one — Jev's last answer, slewed — and the cue timeline holds its own,
 * which wins wherever it exists: its cues are latency-compensated, and for a
 * dropped file they come from a pass over the whole track that knew what was
 * coming. Where the timeline says nothing, the live mood stands.
 *
 * This is a seam rather than three lines inline in `visualLink` because the
 * HUD has to print the *same* answer the renderer is drawing with. A HUD that
 * shows the live mood while the screen is being driven by the timeline's is
 * worse than no HUD: it is a diagnostic that lies.
 *
 * Pure: no DOM, no three.js.
 */

import type { MoodVector } from '../shared/types';

/** Which layer the mood on screen came from. */
export type MoodSource = 'live' | 'timeline' | 'idle';

/**
 * `base` with `over` on top, written into `out` — one object for the life of
 * the page, because this runs on every rendered frame. Returns which layer had
 * the last word.
 */
export function mergeMood(
  out: MoodVector,
  base: MoodVector,
  over: Partial<MoodVector>,
): MoodSource {
  Object.assign(out, base);
  let overridden = false;
  for (const key of Object.keys(over) as (keyof MoodVector)[]) {
    const v = over[key];
    // An explicit `undefined` is a key the timeline happens to carry, not an
    // answer it is giving.
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[key] = v;
    overridden = true;
  }
  return overridden ? 'timeline' : 'live';
}

/**
 * The listener's own correction to the analysis clock, remembered per browser.
 *
 * A cue derived from frame `t` belongs a little earlier than `t` on the visual
 * clock, and `ONSET_REPORT_LAG_SEC` is the part of that we can compute. The
 * rest is the user's own output path — a bluetooth speaker is a tenth of a
 * second all by itself — which nothing in the browser will tell us, so the
 * HUD has a slider and this remembers where they left it.
 */

const TRIM_KEY = 'jevj.latencyTrimMs';

/** Milliseconds; 0 when nothing is stored or storage is unavailable. */
export function loadTrim(): number {
  try {
    const raw = localStorage.getItem(TRIM_KEY);
    if (raw === null) return 0;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return 0;
  }
}

export function saveTrim(ms: number): void {
  try {
    localStorage.setItem(TRIM_KEY, String(ms));
  } catch {
    // Private mode or blocked storage: the trim still works, it just won't
    // survive a reload. Not worth telling the user about.
  }
}

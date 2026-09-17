/**
 * How far behind the sound is by the time we measure it.
 *
 * Analysis happens after the audio has already gone through the capture
 * pipeline and the output device, so a cue derived from frame `t` belongs a
 * little earlier than `t` on the visual clock. The estimate below is the
 * browser's own two numbers plus a constant for the capture hop, and the HUD's
 * trim slider is the escape hatch for whatever the estimate misses — a
 * bluetooth speaker, say. The trim is remembered per browser.
 */

const TRIM_KEY = 'jevj.latencyTrimMs';
/** The capture and analysis hop itself: roughly one 2048-sample frame. */
const PIPELINE_S = 0.02;

/** Seconds. */
export function estimateCaptureLatency(ctx: AudioContext): number {
  return (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0) + PIPELINE_S;
}

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

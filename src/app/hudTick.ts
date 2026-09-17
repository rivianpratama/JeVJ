/**
 * The 15 Hz tick: the HUD, the mood layer and the live timeline, all driven
 * off one snapshot.
 *
 * They share a tick because they have to share a *now*. The HUD describes a
 * snapshot, Jev is asked about the same snapshot, and the grid's prediction is
 * written from the same instant — three readings of one moment rather than
 * three moments, which is what makes the overlay something you can debug
 * against. It is also cheap enough to be free: the horizon is eight seconds
 * and the beat phase moves in milliseconds, and the two writers where timing
 * actually matters — the detector and Jev — are event-driven and land on their
 * own exact instants regardless.
 */

import { Summarizer } from '../analysis/summarizer';
import { estimateTokens } from '../shared/tokens';
import { hudRows } from './hudRows';
import { writeGridCues } from '../timeline/gridWriter';
import { applyDetectorEvent } from '../timeline/detectorWriter';
import type { AnalysisLoop } from './analysisLoop';
import type { CueReader } from './cueReader';
import type { Cue } from '../shared/types';
import type { CueTimeline } from '../timeline/timeline';
import type { Hud } from '../ui/hud';
import type { MoodLink } from './moodLink';
import type { Transport } from './transport';
import type { VisualLink } from './visualLink';

/** The HUD is a diagnostic, not an instrument: 15 Hz is plenty and cheap. */
export const HUD_INTERVAL_MS = 66;
/** How far ahead the live timeline is written, and read. */
const CUE_HORIZON_SEC = 8;
/** How much of the played past the timeline keeps, for cues still ringing. */
const CUE_HISTORY_SEC = 2;
/** How many upcoming cues the HUD lists. */
const UPCOMING_ROWS = 8;

export interface HudTickOptions {
  loop: AnalysisLoop;
  timeline: CueTimeline;
  cues: CueReader;
  moodLink: MoodLink;
  visuals: VisualLink;
  transport: Transport;
  hud: Hud;
}

/** One tick. Put it on an interval; it does nothing until there are frames. */
export function createHudTick(o: HudTickOptions): () => void {
  /** The last detector event written down, so a sticky one is written once. */
  let lastDropAt = Number.NaN;

  return function tick(): void {
    const snap = o.loop.latest();
    if (!snap) return;

    const t = o.moodLink.update(
      snap,
      o.transport.positionSec(),
      o.transport.durationSec(),
      o.transport.playing(),
      !document.hidden,
    );

    const now = snap.features.t;
    writeGridCues(o.timeline, o.loop.beatGrid(), now, CUE_HORIZON_SEC);

    const drop = snap.drop;
    if (drop !== null && drop.t !== lastDropAt) {
      lastDropAt = drop.t;
      applyDetectorEvent(o.timeline, drop, now, { beatSec: snap.grid.period });
    }

    o.timeline.prune(now - CUE_HISTORY_SEC);

    o.hud.update({
      ...hudRows(snap, {
        novelty: t.reading.novelty,
        tokens: estimateTokens(Summarizer.serialize(t.reading.input)),
        // The mood the renderer is drawing with, not Jev's raw last answer.
        mood: o.visuals.mood(),
        moodSrc: o.visuals.moodSource(),
        jev: {
          calls: t.stats.calls,
          tokens: t.stats.tokens,
          lastLatencyMs: t.stats.lastLatencyMs,
          nextIn: t.nextIn,
        },
      }),
      upcoming: upcomingRows(o.cues, now),
      // Wall-clock, and the only wall-clock number on the overlay: whether the
      // loop above is being given frames at all. A hidden tab runs it at one
      // or two a second, and every reading below is then taken off a twentieth
      // of the music.
      fps: o.loop.stepsPerSec(),
      // Which particle tier the renderer settled on for this machine.
      particles: o.visuals.particleTier(),
    });
  };
}

/**
 * What is coming, as the HUD prints it.
 *
 * Beats would fill the list on their own — sixteen of them in the horizon —
 * so they only show when there is nothing more interesting to say.
 */
function upcomingRows(cues: CueReader, now: number): Array<{ dt: number; label: string }> {
  // From the compensated instant, so a cue's countdown is how long until the
  // listener hears it rather than how long until the analysis reaches it.
  const from = cues.readTime(now);
  const due = cues.upcoming(now, CUE_HORIZON_SEC);
  const notable = due.filter(
    (c) =>
      c.impact !== undefined ||
      c.section !== undefined ||
      c.mood !== undefined ||
      c.downbeat === true,
  );
  return (notable.length > 0 ? notable : due)
    .slice(0, UPCOMING_ROWS)
    .map((c) => ({ dt: c.t - from, label: cueLabel(c) }));
}

function cueLabel(c: Cue): string {
  if (c.impact !== undefined) return `impact ${c.impact.toFixed(2)}`;
  if (c.section !== undefined) return c.section;
  if (c.mood !== undefined) return `mood ${c.source}`;
  if (c.downbeat === true) return 'downbeat';
  if (c.beat === true) return 'beat';
  if (c.build !== undefined) return `build ${c.build.toFixed(2)}`;
  return c.source;
}

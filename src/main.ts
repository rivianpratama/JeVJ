/**
 * Wiring only: the UI pieces, the transport, the analysis loop and the visuals
 * know nothing about each other, so this file is the one place where "paste a
 * link" becomes "a track is on the timeline" and "press play" becomes "frames
 * of features".
 *
 * Nothing here decides anything. Anything that had to make a judgment moved
 * out — the whole download-decode-analyze pipeline to `trackFlow`, the state
 * and the screen it paints to `transport`, the diagnostics tick to `hudTick` —
 * and what is left is the order the pieces are built in and which of them
 * holds whose callback.
 *
 * One thing worth knowing about v2: the mood layer does not ask anything while
 * a track plays. It cannot say anything the timeline does not already know,
 * because the timeline was written by a pass over the whole track before a
 * sample of it played, and `effectiveMood` lets those cues win anyway. So the
 * feed still runs — the HUD reads it, and the grid needs its section
 * boundaries — and the asking is switched off.
 */

import './ui/styles.css';
import './ui/columns.css';

import { AnalysisLoop } from './app/analysisLoop';
import { createColumnsLink } from './app/columnsLink';
import { createCueReader } from './app/cueReader';
import { HUD_INTERVAL_MS, createHudTick } from './app/hudTick';
import { MoodFeed } from './app/moodFeed';
import { MoodLink } from './app/moodLink';
import { createTransport } from './app/transport';
import { createVisualLink } from './app/visualLink';
import { loadTrim, saveTrim } from './source/latency';
import { CueTimeline } from './timeline/timeline';
import { createCaption } from './ui/caption';
import { createCard } from './ui/card';
import { createHud } from './ui/hud';
import type { AudioGraph } from './source/audioGraph';
import type { TokenUsage } from './shared/types';

const root = document.querySelector<HTMLElement>('#ui');
if (!root) throw new Error('JeVJ: #ui is missing from the document');
const bg = document.querySelector<HTMLCanvasElement>('#bg');
if (!bg) throw new Error('JeVJ: #bg is missing from the document');

/** The user's own correction on top of the measured latency, in ms. */
let latencyTrimMs = loadTrim();
/** The graph, once there is one; the only thing that knows the output latency. */
let graph: AudioGraph | null = null;

/**
 * What a browser that will not say is assumed to be holding, in seconds.
 *
 * Every Chrome this app has run on reports `outputLatency`. Where it is
 * missing, `baseLatency` is the render quantum alone — a fraction of a
 * millisecond, which is an honest number about the wrong thing — and where both
 * are missing, 20 ms is about what a laptop's own DAC holds and is much nearer
 * the truth than zero.
 */
const ASSUMED_OUTPUT_LATENCY_SEC = 0.02;

/**
 * How far ahead of the speaker the audio clock runs.
 *
 * `ctx.currentTime` is the *scheduling* clock: it is where the graph is
 * writing, not where the listener is hearing. The difference is the driver's
 * buffer, which is tens of milliseconds and machine-specific, and it is the
 * last unaccounted delay in the chain now that the cue times themselves are
 * refined to the sample.
 */
function outputLatencySec(): number {
  const ctx = graph?.ctx as (AudioContext & { outputLatency?: number }) | undefined;
  const reported = ctx?.outputLatency;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return reported;
  const base = ctx?.baseLatency;
  if (typeof base === 'number' && Number.isFinite(base) && base > 0) return base;
  return ASSUMED_OUTPUT_LATENCY_SEC;
}

/**
 * How far to read the timeline ahead of the audio clock, in seconds.
 *
 * It is *negative* now, which is the whole of the v2 correction. v1 read ahead
 * by the detector's own reporting lag, because every cue on the timeline was
 * stamped at the end of the analyser window it was found in and therefore late.
 * The offline sweep no longer leaves them there: an impact is refined against
 * the PCM envelope to the instant the attack actually happened
 * (`refineOnsetTime`), and the ramps and the named moments hang off that. What
 * is left to correct is in the other direction — the audio clock runs *ahead*
 * of the speaker by the output buffer — so the timeline is read slightly
 * *behind* now, and the frame that shows a cue coincides with the audible
 * instant rather than with the scheduling one.
 *
 * The trim slider is on top of it, and is still the answer for a bluetooth
 * speaker, which no API reports. This is the only latency number in the app and
 * it is applied in exactly one place: reading the timeline.
 */
function latencySec(): number {
  return -outputLatencySec() + latencyTrimMs / 1000;
}

const card = createCard(root);
const caption = createCaption(root);
const loop = new AnalysisLoop();
// What the visuals will read: the whole track goes here before it plays, and
// the reader is the one place that analysis time is turned back into the
// listener's — see `cueReader`.
const timeline = new CueTimeline();
const cues = createCueReader(timeline, latencySec);

// The HUD is built before the controls so it sits behind them in the
// document, which is the stacking the stylesheet expects.
const hud = createHud(root, (ms) => {
  latencyTrimMs = ms;
  saveTrim(latencyTrimMs);
});
hud.update({ latencyTrimMs });

/**
 * The transcript on the walls. It is built before the transport so that the
 * transport can hand it the analysis the moment there is one, and it reads the
 * element's own clock rather than the audio context's: the columns are paced to
 * the *track*, so a seek is a jump and a pause is a hold, which is exactly what
 * `el.currentTime` already does.
 */
let position = (): number => 0;
const columns = createColumnsLink({ root, position: () => position() });
columns.start();
/** What this track's two passes cost, for the HUD's Jev row. */
let usage: TokenUsage | null = null;

const transport = createTransport({
  root,
  card,
  caption,
  timeline,
  onGraph: (g) => {
    graph = g;
    loop.start(g);
  },
  // A new track is taking over. What the last one left on the walls is about
  // music that is no longer playing, and its token count is about an analysis
  // that is no longer the one on screen — so both go before the new track's
  // first byte arrives, rather than staying up through the download and the
  // two passes and then being replaced.
  onTrackChange: () => {
    usage = null;
    columns.setAnalysis(null);
  },
  onAnalysis: (a) => {
    usage = a.usage ?? null;
    columns.setAnalysis(a);
  },
});
position = () => transport.positionSec();

// Nothing else tells the grid a section ended, and the phrase count it keeps
// is counted from there. The feed is what hears boundaries, so it is what says
// so — the tick below only passes frames through.
const feed = new MoodFeed({ onSectionChange: (now) => loop.markSectionChange(now) });
// The mood layer, listening but not asking: the timeline already holds one
// judgment per section of this track, written before it started playing.
const moodLink = new MoodLink({ feed });

// And the visuals, on their own rAF but the same audio clock. Started here and
// never stopped: before there is any audio it runs its idle mode, so the page
// is never a dead black rectangle. Everything it needs to assemble a frame —
// the fast features, the timeline's impact and build, the effective mood — it
// reads from the pieces above.
const visuals = createVisualLink({
  canvas: bg,
  loop,
  cues,
  mood: () => moodLink.mood(),
  card: () => card.frame,
});
visuals.start();

// The diagnostics tick: one interval for the life of the page, started here
// rather than when a graph appears, so the overlay can describe an idle page —
// which frame rate, which particle tier, which pixel ratio — before any audio
// exists to describe.
const tick = createHudTick({
  loop,
  timeline,
  cues,
  moodLink,
  visuals,
  transport,
  hud,
  latencySec,
  usage: () => usage,
});
setInterval(tick, HUD_INTERVAL_MS);

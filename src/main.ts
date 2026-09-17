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

import { ONSET_REPORT_LAG_SEC } from './analysis/onset';
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
import type { TokenUsage } from './shared/types';

const root = document.querySelector<HTMLElement>('#ui');
if (!root) throw new Error('JeVJ: #ui is missing from the document');
const bg = document.querySelector<HTMLCanvasElement>('#bg');
if (!bg) throw new Error('JeVJ: #bg is missing from the document');

/** The user's own correction on top of the measured latency, in ms. */
let latencyTrimMs = loadTrim();

/**
 * How far the analysis runs behind what the listener hears.
 *
 * The detector reports a transient one analyser window late, and everything
 * else on the timeline is derived from the same frames. Nothing is captured in
 * v2 — every track is a local file decoded off our own disk — so there is no
 * capture pipeline to add, and the trim slider covers whatever is left: a
 * bluetooth speaker, mostly. This is the only latency number in the app, and
 * it is applied in exactly one place: reading the timeline.
 */
function latencySec(): number {
  return ONSET_REPORT_LAG_SEC + latencyTrimMs / 1000;
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
  onGraph: (g) => loop.start(g),
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

/**
 * Wiring only: the UI pieces, the player, the source switch and the analysis
 * loop know nothing about each other, so this file is the one place where
 * "paste a link" becomes "a video is cued" and "press play" becomes "frames of
 * features". Everything it knows about the music it reads from
 * `AnalysisLoop.latest()`; everything it knows about plumbing it asks
 * `Transport` to do.
 *
 * Nothing here decides anything. Anything that had to make a judgment moved
 * out — the file sweep to `fileFlow`, the two sources to `transport`, the
 * diagnostics tick to `hudTick` — and what is left is the order the pieces are
 * built in and which of them holds whose callback.
 */

import './ui/styles.css';

import { ONSET_REPORT_LAG_SEC } from './analysis/onset';
import { AnalysisLoop } from './app/analysisLoop';
import { createCueReader } from './app/cueReader';
import { createFileFlow } from './app/fileFlow';
import { HUD_INTERVAL_MS, createHudTick } from './app/hudTick';
import { MoodFeed } from './app/moodFeed';
import { MoodLink } from './app/moodLink';
import { createTransport } from './app/transport';
import { createVisualLink } from './app/visualLink';
import { MoodClient } from './mood/moodClient';
import { estimateCaptureLatency, loadTrim, saveTrim } from './source/latency';
import { createYouTubePlayer } from './source/youtubePlayer';
import { writeJevCues } from './timeline/jevWriter';
import { CueTimeline } from './timeline/timeline';
import { createCard } from './ui/card';
import { createHud } from './ui/hud';
import { IDLE_MOOD } from './visuals/director';
import type { AudioGraph } from './source/audioGraph';

/**
 * How long the last judgment stands after the sound goes away.
 *
 * Stopping a tab share is often a fumble — the wrong button in the browser's
 * own bar — and a picture that fell to idle the instant it happened would
 * punish it. Ten seconds is long enough to press play again and keep the mood
 * that was on screen, and short enough that a page left alone does not sit
 * there pretending to hear something.
 */
const IDLE_FADE_MS = 10_000;

const root = document.querySelector<HTMLElement>('#ui');
if (!root) throw new Error('JeVJ: #ui is missing from the document');
const bg = document.querySelector<HTMLCanvasElement>('#bg');
if (!bg) throw new Error('JeVJ: #bg is missing from the document');

/** The graph, once one exists: the audio clock every cue time is on. */
let graph: AudioGraph | null = null;
/** How far behind the sound the analysis is, in seconds. */
let captureLatencySec = 0;
/** The user's own correction on top of the measured latency, in ms. */
let latencyTrimMs = loadTrim();

/**
 * How far the analysis runs behind what the listener hears.
 *
 * The detector reports a transient one analyser window late, and everything
 * else on the timeline is derived from the same frames. A captured tab adds
 * the browser's capture and output latency on top; a local file is decoded
 * straight off disk, so it has none of that. The trim slider covers whatever
 * the estimate misses. This is the only latency number in the app, and it is
 * applied in exactly one place: reading the timeline.
 */
function latencySec(): number {
  const capture = transport.mode() === 'file' ? 0 : captureLatencySec;
  return ONSET_REPORT_LAG_SEC + capture + latencyTrimMs / 1000;
}

const card = createCard(root);
const player = createYouTubePlayer(card.playerMount);
const loop = new AnalysisLoop();
// What the visuals will read: every writer puts its cues here, in analysis
// time, and the reader is the one place that time is turned back into the
// listener's — see `cueReader`.
const timeline = new CueTimeline();
const cues = createCueReader(timeline, latencySec);
const moodClient = new MoodClient();

const fileFlow = createFileFlow({
  timeline,
  client: moodClient,
  ctx: () => graph?.ctx ?? null,
});

// The HUD is built before the controls so it sits behind them in the
// document, which is the stacking the stylesheet expects.
const hud = createHud(root, (ms) => {
  latencyTrimMs = ms;
  saveTrim(latencyTrimMs);
});
hud.update({ latencyTrimMs });

/** The pending fade to idle after a tab share ended, if one is pending. */
let idleFade: ReturnType<typeof setTimeout> | undefined;

const transport = createTransport({
  root,
  card,
  player,
  preAnalyse: fileFlow.preAnalyse,
  onTrackChange: () => {
    clearTimeout(idleFade);
    fileFlow.cancel();
  },
  onCaptureEnded: () => {
    clearTimeout(idleFade);
    idleFade = setTimeout(() => moodLink.fadeTo(IDLE_MOOD), IDLE_FADE_MS);
  },
  onGraph: (g) => {
    graph = g;
    captureLatencySec = estimateCaptureLatency(g.ctx);
    loop.start(g);
  },
});

// Nothing else tells the grid a section ended, and the phrase count it keeps
// is counted from there. The feed is what hears boundaries, so it is what says
// so — the tick below only passes frames through.
const feed = new MoodFeed({ onSectionChange: (now) => loop.markSectionChange(now) });
// Everything Jev: when to ask, what the answer means, and how the mood moves
// between answers. Driven from the tick below, on the audio clock. Each answer
// is also a set of cues — the mood now, and the drop it says is coming.
const moodLink = new MoodLink({
  feed,
  client: moodClient,
  onMood: (mood, now) => writeJevCues(timeline, mood, loop.beatGrid(), now),
});

// And the visuals, on their own rAF but the same audio clock. Started here and
// never stopped: before there is any audio it runs its idle mode, so the page
// is never a dead black rectangle. Everything it needs to assemble a frame —
// the fast features, the timeline's impact and build, the effective mood — it
// reads from the pieces above.
const visuals = createVisualLink({ canvas: bg, loop, cues, mood: () => moodLink.mood() });
visuals.start();

// The diagnostics tick: one interval for the life of the page, started here
// rather than when a graph appears, so the overlay can describe an idle page —
// which frame rate, which particle tier, which pixel ratio — before any audio
// exists to describe.
const tick = createHudTick({ loop, timeline, cues, moodLink, visuals, transport, hud, latencySec });
setInterval(tick, HUD_INTERVAL_MS);

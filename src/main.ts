/**
 * Wiring only: the UI pieces, the player, the source switch and the analysis
 * loop know nothing about each other, so this file is the one place where
 * "paste a link" becomes "a video is cued" and "press play" becomes "frames of
 * features". Everything it knows about the music it reads from
 * `AnalysisLoop.latest()`; everything it knows about plumbing it asks
 * `SourceSwitch` to do.
 */

import './ui/styles.css';

import { Summarizer } from './analysis/summarizer';
import { AnalysisLoop } from './app/analysisLoop';
import { hudRows } from './app/hudRows';
import { MoodFeed } from './app/moodFeed';
import { MoodLink } from './app/moodLink';
import { createSourceSwitch, type DecodedFile } from './app/sources';
import { MoodClient } from './mood/moodClient';
import { NEUTRAL_MOOD } from './shared/moodSchema';
import { estimateCaptureLatency, loadTrim, saveTrim } from './source/latency';
import { applyDetectorEvent } from './timeline/detectorWriter';
import { writeGridCues } from './timeline/gridWriter';
import { writeJevCues } from './timeline/jevWriter';
import { analyzeOffline } from './timeline/offlineAnalyzer';
import { CueTimeline } from './timeline/timeline';
import type { AudioGraph } from './source/audioGraph';
import type { Cue, MoodInput, MoodVector } from './shared/types';
import { isTabCaptureSupported } from './source/tabCapture';
import { parseYouTubeUrl } from './source/urlParse';
import { createYouTubePlayer } from './source/youtubePlayer';
import { createCard } from './ui/card';
import { createControls } from './ui/controls';
import { createHud } from './ui/hud';
import { estimateTokens } from './shared/tokens';
import { showBanner } from './ui/banner';
import { toast } from './ui/toast';

const NO_CAPTURE =
  'this browser cannot share tab audio — youtube analysis needs chrome or edge. dropping an audio file works everywhere.';
/** The HUD is a diagnostic, not an instrument: 15 Hz is plenty and cheap. */
const HUD_INTERVAL_MS = 66;
/** How far ahead the live timeline is written, and read. */
const CUE_HORIZON_SEC = 8;
/** How much of the played past the timeline keeps, for cues still ringing. */
const CUE_HISTORY_SEC = 2;
/** How many upcoming cues the HUD lists. */
const UPCOMING_ROWS = 8;
/**
 * Consecutive failed calls before the offline pass stops asking. A server that
 * is down will be down for the next thirty segments too, and a track that
 * plays without judgments is better than forty wasted requests.
 */
const OFFLINE_GIVE_UP = 3;

const root = document.querySelector<HTMLElement>('#ui');
if (!root) throw new Error('JeVJ: #ui is missing from the document');

const card = createCard(root);
const player = createYouTubePlayer(card.playerMount);
const loop = new AnalysisLoop();
// What the visuals will read: every writer puts its cues here, on the audio
// clock, and the HUD lists what is coming.
const timeline = new CueTimeline();
const moodClient = new MoodClient();
// Nothing else tells the grid a section ended, and the phrase count it keeps
// is counted from there. The feed is what hears boundaries, so it is what says
// so — the HUD tick below only passes frames through.
const feed = new MoodFeed({ onSectionChange: (now) => loop.markSectionChange(now) });
// Everything Jev: when to ask, what the answer means, and how the mood moves
// between answers. Driven from the HUD tick below, on the audio clock. Each
// answer is also a set of cues — the mood now, and the drop it says is coming.
const moodLink = new MoodLink({
  feed,
  client: moodClient,
  onMood: (mood, now) => writeJevCues(timeline, mood, loop.beatGrid(), now),
});

/** Whether audio is actually running — the mood layer stays quiet if not. */
let playing = false;

/** The graph, once one exists: the audio clock every cue time is on. */
let graph: AudioGraph | null = null;
/** How far behind the sound the analysis is, in seconds. */
let captureLatencySec = 0;
/** The whole track's cues in *track* time, until a play offset maps them. */
let offlineCues: Cue[] = [];
/** The last detector event written down, so a sticky one is written once. */
let lastDropAt = Number.NaN;
/** Consecutive failures in the offline pass; see `OFFLINE_GIVE_UP`. */
let offlineFailures = 0;

/** Offset applied when analyser time is converted to cue time. */
let latencyTrimMs = loadTrim();
const hud = createHud(root, (ms) => {
  latencyTrimMs = ms;
  saveTrim(latencyTrimMs);
});
hud.update({ latencyTrimMs });

let mode: 'video' | 'file' = 'video';
let videoLoaded = false;

const sources = createSourceSwitch({
  onGraph: (g) => {
    graph = g;
    captureLatencySec = estimateCaptureLatency(g.ctx);
    loop.start(g);
    setInterval(renderHud, HUD_INTERVAL_MS);
  },
  onTransport: (running) => {
    playing = running;
    controls.setPlaying(running);
  },
  onCaptureEnded: () => toast('tab sharing stopped', 'info'),
});

const controls = createControls(root, {
  onSubmitUrl: (url) => void submitUrl(url),
  onPlay: () => {
    if (mode === 'file') {
      sources.ensureGraph();
      void sources.fileEl()?.play();
      return;
    }
    player.play();
    if (videoLoaded) void startCapture();
  },
  onPause: () => {
    if (mode === 'file') sources.fileEl()?.pause();
    else player.pause();
  },
  onFile: (f) => void openFile(f),
});

function renderHud(): void {
  const snap = loop.latest();
  if (!snap) return;

  // The HUD tick is also the mood tick: the payload that goes to Jev is built
  // here, against the same snapshot the overlay is describing. A hidden tab
  // gets no calls — nobody is watching the visuals they would steer.
  const tick = moodLink.update(snap, positionSec(), durationSec(), playing, !document.hidden);

  // And the timeline tick. The grid's prediction is rewritten from here rather
  // than from the analysis loop's own frame because it costs nothing at this
  // rate — the horizon is eight seconds and the phase moves in milliseconds —
  // and because the two writers that matter for timing, the detector and Jev,
  // are event-driven and land on their exact instants regardless.
  const now = snap.features.t;
  writeGridCues(timeline, loop.beatGrid(), now, CUE_HORIZON_SEC);

  const drop = snap.drop;
  if (drop !== null && drop.t !== lastDropAt) {
    lastDropAt = drop.t;
    applyDetectorEvent(timeline, drop, now, {
      beatSec: snap.grid.period,
      latencySec: captureLatencySec + latencyTrimMs / 1000,
    });
  }

  timeline.prune(now - CUE_HISTORY_SEC);

  hud.update({
    ...hudRows(snap, {
      novelty: tick.reading.novelty,
      tokens: estimateTokens(Summarizer.serialize(tick.reading.input)),
      mood: tick.mood,
      jev: {
        calls: tick.stats.calls,
        tokens: tick.stats.tokens,
        lastLatencyMs: tick.stats.lastLatencyMs,
        nextIn: tick.nextIn,
      },
    }),
    upcoming: upcomingRows(now),
  });
}

/**
 * What is coming, as the HUD prints it.
 *
 * Beats would fill the list on their own — sixteen of them in the horizon —
 * so they only show when there is nothing more interesting to say.
 */
function upcomingRows(now: number): Array<{ dt: number; label: string }> {
  const cues = timeline.upcoming(now, CUE_HORIZON_SEC);
  const notable = cues.filter(
    (c) =>
      c.impact !== undefined ||
      c.section !== undefined ||
      c.mood !== undefined ||
      c.downbeat === true,
  );
  return (notable.length > 0 ? notable : cues)
    .slice(0, UPCOMING_ROWS)
    .map((c) => ({ dt: c.t - now, label: cueLabel(c) }));
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

/** Where the transport is, in seconds — whichever transport is playing. */
function positionSec(): number {
  const at = (mode === 'file' ? sources.fileEl()?.currentTime : player.currentTime()) ?? 0;
  return Number.isFinite(at) ? at : 0;
}

/** How long the track is, or null for a stream of unknown length. */
function durationSec(): number | null {
  const d = (mode === 'file' ? sources.fileEl()?.duration : player.duration()) ?? 0;
  return Number.isFinite(d) && d > 0 ? d : null;
}

// ---- sources -------------------------------------------------------------

async function startCapture(): Promise<void> {
  if (!isTabCaptureSupported()) {
    showBanner(NO_CAPTURE);
    return;
  }
  try {
    await sources.captureTab();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'could not capture tab audio', 'error');
  }
}

async function submitUrl(url: string): Promise<void> {
  const parsed = parseYouTubeUrl(url);
  if (!parsed) {
    toast('that does not look like a youtube link', 'error');
    return;
  }

  // The video is the source now; a file left playing would keep the transport
  // lit and keep feeding the analyser underneath it.
  sources.dropFile();
  mode = 'video';
  controls.setBusy(true);
  card.setMode('video');
  card.setLabel('loading…');

  try {
    await player.load(parsed.videoId, parsed.startSeconds);
    videoLoaded = true;
    card.setLabel(player.title() || parsed.videoId);
  } catch (err) {
    videoLoaded = false;
    card.setLabel('');
    toast(err instanceof Error ? err.message : 'could not load that video', 'error');
  } finally {
    controls.setBusy(false);
  }
}

async function openFile(f: File): Promise<void> {
  mode = 'file';
  card.setMode('file');
  card.setLabel(f.name);
  player.pause();
  controls.setBusy(true);

  try {
    await sources.playFile(f, preAnalyse);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'could not play that file', 'error');
  } finally {
    controls.setBusy(false);
  }
}

/**
 * A dropped file, swept end to end before a sample of it plays.
 *
 * This is the one thing a local file can do that a captured tab cannot: know
 * the whole track in advance. Every drop, every section and every beat goes on
 * the timeline before playback starts, so the anticipation leading into a hit
 * is exact rather than predicted. It costs a few seconds and a handful of
 * model calls; a track whose pre-analysis fails still plays, just live.
 */
async function preAnalyse({ el, buffer }: DecodedFile): Promise<void> {
  offlineCues = [];
  offlineFailures = 0;
  timeline.replaceSource('offline', 0, []);

  let shown = 0;
  try {
    const result = await analyzeOffline(downmix(buffer), buffer.sampleRate, askJevOnce, (p) => {
      const step = Math.floor(p * 10) * 10;
      if (step <= shown) return;
      shown = step;
      toast(`analysing the track… ${step}%`);
    });
    offlineCues = result.timeline;
    toast(`timeline ready — ${result.segments.length} sections`);
  } catch {
    toast('could not pre-analyse that file; playing it live', 'error');
  }

  // Cue times come out of the sweep in *track* time. Only the transport knows
  // where that sits on the audio clock, and only once it is running — and it
  // moves every time the user seeks.
  const place = (): void => writeOfflineCues(el);
  el.addEventListener('play', place);
  el.addEventListener('seeked', place);
}

/** The offline timeline, moved onto the audio clock the renderer reads. */
function writeOfflineCues(el: HTMLAudioElement): void {
  const ctx = graph?.ctx;
  if (!ctx || offlineCues.length === 0) return;
  const offset = ctx.currentTime - el.currentTime;
  timeline.replaceSource(
    'offline',
    0,
    offlineCues.map((c) => ({ ...c, t: c.t + offset })),
  );
}

/**
 * One Jev call for the offline pass.
 *
 * The neutral mood on failure is not a fallback so much as an admission: the
 * segment still exists and still has to have a cue, it just has nothing
 * interesting to say about itself.
 */
async function askJevOnce(input: MoodInput): Promise<MoodVector> {
  if (offlineFailures >= OFFLINE_GIVE_UP) return NEUTRAL_MOOD;
  const res = await moodClient.ask(input, graph?.ctx.currentTime ?? 0);
  if (res === null) {
    offlineFailures += 1;
    return NEUTRAL_MOOD;
  }
  offlineFailures = 0;
  return res.mood;
}

/** Every channel into one, which is what the analysis chain reads. */
function downmix(buffer: AudioBuffer): Float32Array {
  const first = buffer.getChannelData(0);
  if (buffer.numberOfChannels < 2) return first;

  const out = new Float32Array(first.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + channel[i]! / buffer.numberOfChannels;
  }
  return out;
}

// ---- player events -------------------------------------------------------

player.onState((state) => {
  if (mode !== 'video') return;
  playing = state === 'playing';
  controls.setPlaying(playing);
  // The title only exists once the player has metadata, which is after load().
  const title = player.title();
  if (title !== '') card.setLabel(title);
});

player.onError((_code, message) => {
  controls.setBusy(false);
  videoLoaded = false;
  // The toast carries the explanation; a stale title under the card would lie.
  if (mode === 'video') card.setLabel('');
  toast(message, 'error');
});

// Tab audio capture is Chromium-only; say so before the user tries.
if (!isTabCaptureSupported()) showBanner(NO_CAPTURE);

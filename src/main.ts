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
import { createSourceSwitch } from './app/sources';
import { loadTrim, saveTrim } from './source/latency';
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

const root = document.querySelector<HTMLElement>('#ui');
if (!root) throw new Error('JeVJ: #ui is missing from the document');

const card = createCard(root);
const player = createYouTubePlayer(card.playerMount);
const loop = new AnalysisLoop();
const feed = new MoodFeed();

/** Offset applied when analyser time is converted to cue time (task 5b). */
let latencyTrimMs = loadTrim();
const hud = createHud(root, (ms) => {
  latencyTrimMs = ms;
  saveTrim(latencyTrimMs);
});
hud.update({ latencyTrimMs });

let mode: 'video' | 'file' = 'video';
let videoLoaded = false;

const sources = createSourceSwitch({
  onGraph: (graph) => {
    loop.start(graph);
    setInterval(renderHud, HUD_INTERVAL_MS);
  },
  onTransport: (playing) => controls.setPlaying(playing),
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

  // The HUD tick is also the mood tick: the payload Task 7 will send is built
  // here, against the same snapshot the overlay is describing.
  const reading = feed.update(snap, positionSec(), durationSec());
  // Nothing else tells the grid a section ended, and the phrase count it keeps
  // is counted from there.
  if (reading.sectionChanged) loop.markSectionChange(snap.features.t);

  hud.update(
    hudRows(snap, {
      novelty: reading.novelty,
      tokens: estimateTokens(Summarizer.serialize(reading.input)),
    }),
  );
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
    await sources.playFile(f);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'could not play that file', 'error');
  } finally {
    controls.setBusy(false);
  }
}

// ---- player events -------------------------------------------------------

player.onState((state) => {
  if (mode !== 'video') return;
  controls.setPlaying(state === 'playing');
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

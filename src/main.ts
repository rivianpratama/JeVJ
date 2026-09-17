/**
 * Wiring only: the UI pieces, the player and the audio graph know nothing
 * about each other, so this file is the one place where "paste a link" becomes
 * "a video is cued" and "press play" becomes "frames of features".
 */

import './ui/styles.css';

import { FeatureExtractor } from './analysis/features';
import { createAudioGraph, type AudioGraph } from './source/audioGraph';
import { createFileSource } from './source/fileSource';
import { loadTrim, saveTrim } from './source/latency';
import { captureTabAudio, isTabCaptureSupported } from './source/tabCapture';
import { parseYouTubeUrl } from './source/urlParse';
import { createYouTubePlayer } from './source/youtubePlayer';
import type { FrameFeatures } from './shared/types';
import { createCard } from './ui/card';
import { createControls } from './ui/controls';
import { createHud } from './ui/hud';
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

/** Offset applied when analyser time is converted to cue time (task 5b). */
let latencyTrimMs = loadTrim();
const hud = createHud(root, (ms) => {
  latencyTrimMs = ms;
  saveTrim(latencyTrimMs);
});
hud.update({ latencyTrimMs });

let mode: 'video' | 'file' = 'video';
let videoLoaded = false;
let graph: AudioGraph | null = null;
let extractor: FeatureExtractor | null = null;
let capture: { stop(): void } | null = null;
let fileEl: HTMLAudioElement | null = null;

const controls = createControls(root, {
  onSubmitUrl: (url) => void submitUrl(url),
  onPlay: () => {
    if (mode === 'file') {
      ensureGraph();
      void fileEl?.play();
      return;
    }
    player.play();
    if (videoLoaded) void startCapture();
  },
  onPause: () => {
    if (mode === 'file') fileEl?.pause();
    else player.pause();
  },
  onFile: (file) => void openFile(file),
});

// ---- audio graph ---------------------------------------------------------

/**
 * Built on first use, which is always inside a click: a context created at
 * load time starts suspended and its analyser would only ever see silence.
 */
function ensureGraph(): AudioGraph {
  if (!graph) {
    graph = createAudioGraph();
    extractor = new FeatureExtractor({ sampleRate: graph.ctx.sampleRate, fftSize: graph.analyser.fftSize });
    requestAnimationFrame(tick);
  }
  void graph.ctx.resume();
  return graph;
}

async function startCapture(): Promise<void> {
  if (capture) return;
  if (!isTabCaptureSupported()) {
    showBanner(NO_CAPTURE);
    return;
  }

  const g = ensureGraph();
  try {
    const tab = await captureTabAudio(g.ctx);
    // Analyser only: the iframe is already playing this to the speakers.
    g.connectSource(tab.node, false);
    tab.onEnded(() => {
      capture = null;
      g.disconnectSource();
      toast('tab sharing stopped', 'info');
    });
    capture = tab;
  } catch (err) {
    toast(err instanceof Error ? err.message : 'could not capture tab audio', 'error');
  }
}

let lastHudAt = 0;

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (!graph || !extractor) return;

  // Every frame, even when the HUD is throttled: flux and the band levels are
  // sequential, so a skipped frame is a hole in the analysis.
  const frame = graph.readFrame();
  const features = extractor.extract(frame.mags, frame.time, frame.t);

  if (now - lastHudAt < HUD_INTERVAL_MS) return;
  lastHudAt = now;
  hud.update({ mood: hudRows(features) });
}

/** rms, centroid and eight little bar graphs, as strings so the HUD prints them verbatim. */
function hudRows(f: FrameFeatures): Record<string, string> {
  const rows: Record<string, string> = {
    rms: f.rms.toFixed(3),
    centroid: `${Math.round(f.centroid)} Hz`,
  };
  for (let i = 0; i < f.bands.length; i++) {
    rows[`b${i}`] = '█'.repeat(Math.round((f.bands[i] ?? 0) * 8));
  }
  return rows;
}

// ---- sources -------------------------------------------------------------

async function submitUrl(url: string): Promise<void> {
  const parsed = parseYouTubeUrl(url);
  if (!parsed) {
    toast('that does not look like a youtube link', 'error');
    return;
  }

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

async function openFile(file: File): Promise<void> {
  mode = 'file';
  card.setMode('file');
  card.setLabel(file.name);
  player.pause();
  controls.setBusy(true);

  const g = ensureGraph();
  capture?.stop();
  capture = null;

  try {
    const source = await createFileSource(g.ctx, file);
    if (fileEl) {
      fileEl.pause();
      URL.revokeObjectURL(fileEl.src);
    }
    fileEl = source.el;
    for (const event of ['play', 'pause', 'ended']) {
      source.el.addEventListener(event, () => controls.setPlaying(!source.el.paused));
    }
    // Both: nothing else is playing this file.
    g.connectSource(source.node, true);
    await source.el.play();
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

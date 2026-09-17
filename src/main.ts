/**
 * Wiring only: the UI pieces and the player know nothing about each other, so
 * this file is the one place where "paste a link" becomes "a video is cued".
 */

import './ui/styles.css';

import { parseYouTubeUrl } from './source/urlParse';
import { createYouTubePlayer } from './source/youtubePlayer';
import { createCard } from './ui/card';
import { createControls } from './ui/controls';
import { createHud } from './ui/hud';
import { showBanner } from './ui/banner';
import { toast } from './ui/toast';

const root = document.querySelector<HTMLElement>('#ui');
if (!root) throw new Error('JeVJ: #ui is missing from the document');

const card = createCard(root);
const player = createYouTubePlayer(card.playerMount);

/** Offset applied when analyser time is converted to cue time (task 5b). */
let latencyTrimMs = 0;
const hud = createHud(root, (ms) => {
  latencyTrimMs = ms;
  console.debug(`[jevj] latency trim ${latencyTrimMs} ms`);
});
hud.update({ latencyTrimMs });

let mode: 'video' | 'file' = 'video';

const controls = createControls(root, {
  onSubmitUrl: (url) => void submitUrl(url),
  onPlay: () => player.play(),
  onPause: () => player.pause(),
  onFile: (file) => {
    mode = 'file';
    card.setMode('file');
    card.setLabel(file.name);
    toast('local file playback arrives with the analysis engine', 'info');
  },
});

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
    card.setLabel(player.title() || parsed.videoId);
  } catch (err) {
    card.setLabel('');
    toast(err instanceof Error ? err.message : 'could not load that video', 'error');
  } finally {
    controls.setBusy(false);
  }
}

player.onState((state) => {
  controls.setPlaying(state === 'playing');
  if (mode !== 'video') return;
  // The title only exists once the player has metadata, which is after load().
  const title = player.title();
  if (title !== '') card.setLabel(title);
});

player.onError((_code, message) => {
  controls.setBusy(false);
  // The toast carries the explanation; a stale title under the card would lie.
  if (mode === 'video') card.setLabel('');
  toast(message, 'error');
});

// Tab audio capture (task 3) is Chromium-only; say so before the user tries.
if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
  showBanner(
    'this browser cannot share tab audio — youtube analysis needs chrome or edge. dropping an audio file works everywhere.',
  );
}

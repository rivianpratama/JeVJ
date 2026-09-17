/**
 * The two ways sound gets in, behind one switch.
 *
 * A YouTube video analysed through tab capture and a local file decoded off
 * disk are nothing alike — one needs a permission prompt and carries the
 * browser's capture latency, the other can be swept end to end before it plays
 * — but everything above them only ever needs three things: which of them is
 * running, whether it is playing, and where it is. So this owns the player
 * events, the controls, the source switch and the mode flag, and publishes
 * exactly those three.
 *
 * It owns the *user's* side of a track change too: dropping the file when a
 * link is submitted, clearing the card's label when a video fails to load,
 * telling the caller that whatever sweep is running is now about the wrong
 * track.
 */

import { createSourceSwitch, type DecodedFile } from './sources';
import { isTabCaptureSupported } from '../source/tabCapture';
import { parseYouTubeUrl } from '../source/urlParse';
import { showBanner } from '../ui/banner';
import { createControls } from '../ui/controls';
import { toast } from '../ui/toast';
import type { AudioGraph } from '../source/audioGraph';
import type { Card } from '../ui/card';
import type { YouTubePlayer } from '../source/youtubePlayer';

const NO_CAPTURE =
  'this browser cannot share tab audio — youtube analysis needs chrome or edge. dropping an audio file works everywhere.';

export type SourceMode = 'video' | 'file';

export interface TransportOptions {
  root: HTMLElement;
  card: Card;
  player: YouTubePlayer;
  /** A decoded file, swept between the decode and its first sample. */
  preAnalyse: (f: DecodedFile) => Promise<void>;
  /** A new track is taking over: whatever is being pre-analysed is stale. */
  onTrackChange: () => void;
  /** The audio graph, the first time there is one. */
  onGraph: (g: AudioGraph) => void;
}

export interface Transport {
  mode(): SourceMode;
  /** Whether audio is actually running — the mood layer stays quiet if not. */
  playing(): boolean;
  /** Where the transport is, in seconds — whichever transport is playing. */
  positionSec(): number;
  /** How long the track is, or null for a stream of unknown length. */
  durationSec(): number | null;
}

export function createTransport(o: TransportOptions): Transport {
  let mode: SourceMode = 'video';
  let videoLoaded = false;
  let playing = false;

  const sources = createSourceSwitch({
    onGraph: o.onGraph,
    onTransport: (running) => {
      playing = running;
      controls.setPlaying(running);
    },
    onCaptureEnded: () => toast('tab sharing stopped', 'info'),
  });

  const controls = createControls(o.root, {
    onSubmitUrl: (url) => void submitUrl(url),
    onPlay: () => {
      if (mode === 'file') {
        sources.ensureGraph();
        void sources.fileEl()?.play();
        return;
      }
      o.player.play();
      if (videoLoaded) void startCapture();
    },
    onPause: () => {
      if (mode === 'file') sources.fileEl()?.pause();
      else o.player.pause();
    },
    onFile: (f) => void openFile(f),
  });

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

    // The video is the source now; a file left playing would keep the
    // transport lit and keep feeding the analyser underneath it.
    sources.dropFile();
    o.onTrackChange();
    mode = 'video';
    controls.setBusy(true);
    o.card.setMode('video');
    o.card.setLabel('loading…');

    try {
      await o.player.load(parsed.videoId, parsed.startSeconds);
      videoLoaded = true;
      o.card.setLabel(o.player.title() || parsed.videoId);
    } catch (err) {
      videoLoaded = false;
      o.card.setLabel('');
      toast(err instanceof Error ? err.message : 'could not load that video', 'error');
    } finally {
      controls.setBusy(false);
    }
  }

  async function openFile(f: File): Promise<void> {
    // Before the decode, not after: the sweep already running is about the
    // file this one is replacing, whatever happens to this one.
    o.onTrackChange();
    mode = 'file';
    o.card.setMode('file');
    o.card.setLabel(f.name);
    o.player.pause();
    controls.setBusy(true);

    try {
      await sources.playFile(f, o.preAnalyse);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'could not play that file', 'error');
    } finally {
      controls.setBusy(false);
    }
  }

  o.player.onState((state) => {
    if (mode !== 'video') return;
    playing = state === 'playing';
    controls.setPlaying(playing);
    // The title only exists once the player has metadata, which is after
    // load().
    const title = o.player.title();
    if (title !== '') o.card.setLabel(title);
  });

  o.player.onError((_code, message) => {
    controls.setBusy(false);
    videoLoaded = false;
    // The toast carries the explanation; a stale title under the card would
    // lie.
    if (mode === 'video') o.card.setLabel('');
    toast(message, 'error');
  });

  // Tab audio capture is Chromium-only; say so before the user tries.
  if (!isTabCaptureSupported()) showBanner(NO_CAPTURE);

  return {
    mode: () => mode,
    playing: () => playing,

    positionSec(): number {
      const at = (mode === 'file' ? sources.fileEl()?.currentTime : o.player.currentTime()) ?? 0;
      return Number.isFinite(at) ? at : 0;
    },

    durationSec(): number | null {
      const d = (mode === 'file' ? sources.fileEl()?.duration : o.player.duration()) ?? 0;
      return Number.isFinite(d) && d > 0 ? d : null;
    },
  };
}

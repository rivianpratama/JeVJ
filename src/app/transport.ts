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

import { createAppMachine, type AppState } from './state';
import { createSourceSwitch, type DecodedFile } from './sources';
import { isTabCaptureSupported } from '../source/tabCapture';
import { parseYouTubeUrl } from '../source/urlParse';
import { showBanner } from '../ui/banner';
import { createControls } from '../ui/controls';
import { toast } from '../ui/toast';
import type { AudioGraph } from '../source/audioGraph';
import type { Card } from '../ui/card';
import type { YouTubePlayer } from '../source/youtubePlayer';

/**
 * What a browser without `getDisplayMedia` is told, once, before it tries.
 *
 * Lower case because everything the app says is: the banner sits beside a HUD
 * and a row of toasts written the same way.
 */
const NO_CAPTURE =
  'live youtube analysis needs chrome or edge. you can still drop an audio file.';

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
  /**
   * The user ended the tab share from the browser's own bar. The sound is gone
   * and nothing is going to replace it, so whatever is still being drawn from
   * the last judgment is now about music nobody can hear.
   */
  onCaptureEnded?: () => void;
}

export interface Transport {
  mode(): SourceMode;
  /** Which of the six things the app is doing; see `app/state.ts`. */
  state(): AppState;
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

  // The one place the app's state is kept. Everything that could change it
  // happens in this file — the player's events, the file element's, the share
  // picker's — so nothing else has to be told to keep a flag in step.
  const app = createAppMachine();

  /**
   * Play and pause mean nothing before there is anything to play, and the
   * machine says so by throwing. The two events arrive from the *browser*
   * rather than from our own code — a file element emits `pause` when it is
   * torn down, and the YouTube player reports itself paused as it cues — so
   * they are filtered here rather than made legal there.
   */
  function setRunning(running: boolean): void {
    playing = running;
    controls.setPlaying(running);
    if (app.state() !== 'idle') app.send(running ? 'play' : 'pause');
  }

  const sources = createSourceSwitch({
    onGraph: o.onGraph,
    onTransport: setRunning,
    onCaptureEnded: () => {
      app.send('capture:ended');
      toast('tab sharing stopped', 'info');
      o.onCaptureEnded?.();
    },
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
      app.send('capture:started');
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
      app.send('url:cued');
      o.card.setLabel(o.player.title() || parsed.videoId);
    } catch (err) {
      videoLoaded = false;
      app.send('url:failed');
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
    // Before the decode and before the sweep: from here on the app is about
    // this file, whatever it was about a moment ago.
    app.send('file:drop');
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
    setRunning(state === 'playing');
    // The title only exists once the player has metadata, which is after
    // load().
    const title = o.player.title();
    if (title !== '') o.card.setLabel(title);
  });

  o.player.onError((_code, message) => {
    controls.setBusy(false);
    videoLoaded = false;
    // The toast carries the explanation; a stale title under the card would
    // lie. A video that fails mid-playback leaves the app with nothing loaded,
    // which is what `url:failed` says — `submitUrl` may send it too, and a
    // machine already in `idle` treats the second one as the no-op it is.
    if (mode === 'video') {
      app.send('url:failed');
      o.card.setLabel('');
    }
    toast(message, 'error');
  });

  // Tab audio capture is Chromium-only; say so before the user tries.
  if (!isTabCaptureSupported()) showBanner(NO_CAPTURE);

  return {
    mode: () => mode,
    state: () => app.state(),
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

/**
 * What the user did, and what the screen does about it.
 *
 * v2 has one source — a media element playing a file off our own disk — so
 * there is no switch here any more. What is left is the part that was always
 * the hard bit: one state, kept in one place, with the screen painted from it.
 * `state.ts` owns the moves; this owns the consequences, and there is exactly
 * one function (`paint`) that turns a state into what is visible. A state the
 * machine can reach is a screen the app can draw, which is the property the
 * five booleans in v1 could not offer.
 *
 * It also owns the audio graph, because the graph must be built inside a user
 * gesture — a context created any other way starts suspended and its analyser
 * returns silence forever — and the two gestures that start a track (a
 * submitted link, a dropped file) both arrive here.
 */

import { createAppMachine, type AppState } from './state';
import { createTrackFlow, type OpenedTrack } from './trackFlow';
import { createAudioGraph, type AudioGraph } from '../source/audioGraph';
import { createControls } from '../ui/controls';
import { toast } from '../ui/toast';
import type { Caption } from '../ui/caption';
import type { Card } from '../ui/card';
import type { CueTimeline } from '../timeline/timeline';
import type { TrackAnalysis } from '../shared/types';

export interface TransportOptions {
  root: HTMLElement;
  card: Card;
  caption: Caption;
  timeline: CueTimeline;
  /** The audio graph, the first time there is one. */
  onGraph: (g: AudioGraph) => void;
  /** A new track is taking over: whatever the last one left behind is stale. */
  onTrackChange?: () => void;
  /** The finished analysis record; the scrolling columns read it. */
  onAnalysis?: (a: TrackAnalysis) => void;
}

export interface Transport {
  /** Which of the seven things the app is doing; see `app/state.ts`. */
  state(): AppState;
  /** Whether audio is actually running — the mood layer stays quiet if not. */
  playing(): boolean;
  /** Where the track is, in seconds. */
  positionSec(): number;
  /** How long the track is, or null before the element knows. */
  durationSec(): number | null;
}

export function createTransport(o: TransportOptions): Transport {
  const el = o.card.video;
  let graph: AudioGraph | null = null;
  /** Whether the track that is loaded has a picture to show. */
  let hasVideo = false;

  const app = createAppMachine((to) => paint(to));

  /**
   * The graph, built on first use. That use is always inside a click or a
   * drop, which is what keeps the context from starting suspended; the element
   * is wired into it once and for all, since `createMediaElementSource` may
   * only ever be called on an element once.
   */
  function ensureGraph(): AudioGraph {
    if (!graph) {
      graph = createAudioGraph();
      // Both: nothing else is playing this element.
      graph.connectSource(graph.ctx.createMediaElementSource(el), true);
      o.onGraph(graph);
    }
    void graph.ctx.resume();
    return graph;
  }

  const flow = createTrackFlow({
    timeline: o.timeline,
    el,
    ctx: () => ensureGraph().ctx,
    onProgress: (percent) => o.caption.progress(percent),
    onResolved: () => app.send('resolved'),
    onAnalysis: (a) => o.onAnalysis?.(a),
  });

  const controls = createControls(o.root, {
    onSubmitUrl: (url) => void start(() => flow.open(url), 'url:submit'),
    onFile: (file) => void start(() => flow.openFile(file), 'file:drop'),
    onPlay: () => {
      ensureGraph();
      void el.play().catch((err: unknown) => {
        toast(err instanceof Error ? err.message : 'this track would not play', 'error');
      });
    },
    onPause: () => el.pause(),
  });

  /**
   * One track, start to finish.
   *
   * The machine is asked first and its answer is the permission: a link
   * submitted while a track is already loaded, or a file dropped into the
   * middle of an analysis, changes nothing and does nothing (see `state.ts`).
   * Everything after that is the pipeline, and anything it throws lands the
   * page back on the empty screen with a toast, which is the only failure this
   * app has.
   */
  async function start(open: () => Promise<OpenedTrack | null>, event: 'url:submit' | 'file:drop'): Promise<void> {
    if (!app.send(event).changed) return;
    o.onTrackChange?.();
    // Inside the gesture that started this, and before anything is awaited.
    ensureGraph();
    o.caption.progress(0);

    try {
      const opened = await open();
      // Null means another track took this one's place while it ran; that
      // track's own `start` owns the screen now.
      if (opened === null) return;
      hasVideo = opened.video;
      app.send('analyzed');
      o.caption.ready();
    } catch (err) {
      flow.cancel();
      app.send('failed');
      o.caption.hide();
      toast(err instanceof Error ? err.message : 'that track could not be loaded', 'error');
    }
  }

  /** The whole screen, as a function of the one state. */
  function paint(state: AppState): void {
    const loaded = state === 'ready' || state === 'playing' || state === 'paused' || state === 'ended';
    controls.setInputVisible(state === 'empty');
    controls.setButtonVisible(loaded);
    controls.setPlaying(state === 'playing');
    o.card.setVisible(loaded && hasVideo);
    if (state === 'empty') {
      hasVideo = false;
      el.removeAttribute('src');
    }
  }

  // The element is the only thing that knows whether it is actually playing:
  // a `play()` that was refused, a track that reached its end, a pause from
  // the system's own media keys all arrive here and nowhere else.
  el.addEventListener('play', () => app.send('play'));
  el.addEventListener('pause', () => app.send('pause'));
  el.addEventListener('ended', () => app.send('ended'));

  paint(app.state());

  return {
    state: () => app.state(),
    playing: () => app.state() === 'playing',

    positionSec(): number {
      return Number.isFinite(el.currentTime) ? el.currentTime : 0;
    },

    durationSec(): number | null {
      const d = el.duration;
      return Number.isFinite(d) && d > 0 ? d : null;
    },
  };
}

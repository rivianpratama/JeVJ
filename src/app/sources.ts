/**
 * Which sound is being analysed, and the one graph it flows through.
 *
 * Only one thing feeds the analyser at a time, and switching is where the bugs
 * live: a file element left playing under a newly loaded video keeps the
 * transport lit and keeps pushing its own audio into the analysis. So every
 * way in goes through here, each one drops whatever held the graph before it,
 * and a dropped file is really let go — paused, unsubscribed, and its object
 * URL revoked.
 *
 * The audio graph is built on first use rather than at load, because that use
 * is always inside a click: a context created any other way starts suspended
 * and its analyser returns silence forever.
 *
 * Failures are thrown, not toasted — this module has no opinion about how the
 * app tells the user.
 */

import { createAudioGraph, type AudioGraph } from '../source/audioGraph';
import { createFileSource } from '../source/fileSource';
import { captureTabAudio } from '../source/tabCapture';

/** Element events that mean "the transport changed". */
const TRANSPORT_EVENTS = ['play', 'pause', 'ended'] as const;

/** A decoded file, before a sample of it has played. */
export interface DecodedFile {
  el: HTMLAudioElement;
  /** The whole file in memory, for the offline pass.  */
  buffer: AudioBuffer;
  ctx: AudioContext;
}

export interface SourceHandlers {
  /** The graph has just been built: whatever wants to read it, start now. */
  onGraph(graph: AudioGraph): void;
  /** A local file started or stopped playing. */
  onTransport(playing: boolean): void;
  /** The user ended the tab share from the browser's own bar. */
  onCaptureEnded(): void;
}

export interface SourceSwitch {
  ensureGraph(): AudioGraph;
  /** Analyse the tab the user picks. Does nothing if already sharing. */
  captureTab(): Promise<void>;
  /**
   * Play a local file through the graph, replacing whatever was playing.
   *
   * `beforePlay` is awaited between the decode and the first sample: file mode
   * analyses the whole track before it starts (Task 8), and a track that is
   * already playing while its timeline is being built would play its first
   * seconds blind.
   */
  playFile(f: File, beforePlay?: (source: DecodedFile) => Promise<void> | void): Promise<void>;
  /** The element playing a local file, if one is. */
  fileEl(): HTMLAudioElement | null;
  /** Let the local file go: another source is taking over. */
  dropFile(): void;
}

export function createSourceSwitch(h: SourceHandlers): SourceSwitch {
  let graph: AudioGraph | null = null;
  let capture: { stop(): void } | null = null;
  let file: { el: HTMLAudioElement; stop(): void } | null = null;

  function ensureGraph(): AudioGraph {
    if (!graph) {
      graph = createAudioGraph();
      h.onGraph(graph);
    }
    void graph.ctx.resume();
    return graph;
  }

  function dropFile(): void {
    file?.stop();
    file = null;
  }

  return {
    ensureGraph,
    dropFile,
    fileEl: () => file?.el ?? null,

    async captureTab(): Promise<void> {
      if (capture) return;
      const g = ensureGraph();
      const tab = await captureTabAudio(g.ctx);
      // Only after the user has actually picked a tab: a cancelled picker
      // throws above, and silencing their file for a share that never
      // happened would be a worse bug than the one this prevents.
      dropFile();
      // Analyser only: the captured tab is already playing to the speakers.
      g.connectSource(tab.node, false);
      tab.onEnded(() => {
        capture = null;
        g.disconnectSource();
        h.onCaptureEnded();
      });
      capture = tab;
    },

    async playFile(
      f: File,
      beforePlay?: (source: DecodedFile) => Promise<void> | void,
    ): Promise<void> {
      const g = ensureGraph();
      capture?.stop();
      capture = null;
      dropFile();

      const source = await createFileSource(g.ctx, f);
      const el = source.el;
      const onTransport = (): void => h.onTransport(!el.paused);
      for (const event of TRANSPORT_EVENTS) el.addEventListener(event, onTransport);

      file = {
        el,
        stop(): void {
          el.pause();
          for (const event of TRANSPORT_EVENTS) el.removeEventListener(event, onTransport);
          // The element is finished with; without this the decoded file stays
          // in memory for the life of the document.
          URL.revokeObjectURL(el.src);
          h.onTransport(false);
        },
      };
      // Both: nothing else is playing this file.
      g.connectSource(source.node, true);
      await beforePlay?.({ el, buffer: source.buffer, ctx: g.ctx });
      // The file may have been dropped while the pre-analysis ran — the user
      // pasted a link, or dropped another file. Playing it now would put two
      // sources through one graph.
      if (file?.el !== el) return;
      await el.play();
    },
  };
}

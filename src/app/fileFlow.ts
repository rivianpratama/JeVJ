/**
 * A dropped file, swept end to end before a sample of it plays.
 *
 * This is the one thing a local file can do that a captured tab cannot: know
 * the whole track in advance. Every drop, every section and every beat goes on
 * the timeline before playback starts, so the anticipation leading into a hit
 * is exact rather than predicted. It costs a few seconds and a handful of
 * model calls; a track whose pre-analysis fails still plays, just live.
 *
 * Two things make this its own module rather than three functions in `main`.
 * A sweep takes seconds and the user can drop a second file into the middle of
 * one, so there is a *pass* to keep track of and a rule about who may write.
 * And the sweep's answers come out in **track** time while everything else in
 * the app is on the audio clock, so there is a mapping to hold — one that
 * moves every time the transport seeks.
 */

import { analyzeOffline } from '../timeline/offlineAnalyzer';
import { NEUTRAL_MOOD } from '../shared/moodSchema';
import { toast } from '../ui/toast';
import type { DecodedFile } from './sources';
import type { MoodClient } from '../mood/moodClient';
import type { Cue, MoodInput, MoodVector } from '../shared/types';
import type { CueTimeline } from '../timeline/timeline';

/**
 * Consecutive failed calls before the offline pass stops asking. A server that
 * is down will be down for the next thirty segments too, and a track that
 * plays without judgments is better than forty wasted requests.
 */
const OFFLINE_GIVE_UP = 3;

export interface FileFlowOptions {
  timeline: CueTimeline;
  client: MoodClient;
  /** The audio clock the cues end up on, once there is a graph. */
  ctx: () => AudioContext | null;
}

export interface FileFlow {
  /**
   * Whatever pre-analysis is running is about a track that is being replaced.
   * Bumping the pass counter is all it takes: the pass itself checks before it
   * writes, toasts or asks.
   */
  cancel(): void;
  /** Sweep a decoded file, and arrange for its cues to be placed on play. */
  preAnalyse(file: DecodedFile): Promise<void>;
}

export function createFileFlow(o: FileFlowOptions): FileFlow {
  /** The whole track's cues in *track* time, until a play offset maps them. */
  let offlineCues: Cue[] = [];
  /** Consecutive failures in the offline pass; see `OFFLINE_GIVE_UP`. */
  let offlineFailures = 0;
  /** Which pre-analysis pass is the current one; a late one is ignored. */
  let pass = 0;

  /** The offline timeline, moved onto the audio clock the renderer reads. */
  function place(el: HTMLAudioElement): void {
    const ctx = o.ctx();
    if (!ctx || offlineCues.length === 0) return;
    const offset = ctx.currentTime - el.currentTime;
    o.timeline.replaceSource(
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
   * interesting to say about itself. A sweep whose file has been replaced
   * stops asking for the same reason, except that it is not even an admission
   * — the answers are about to be thrown away.
   */
  async function askJevOnce(input: MoodInput, current: () => boolean): Promise<MoodVector> {
    if (!current() || offlineFailures >= OFFLINE_GIVE_UP) return NEUTRAL_MOOD;
    const res = await o.client.ask(input, o.ctx()?.currentTime ?? 0);
    if (res === null) {
      offlineFailures += 1;
      return NEUTRAL_MOOD;
    }
    offlineFailures = 0;
    return res.mood;
  }

  return {
    cancel(): void {
      pass += 1;
    },

    async preAnalyse({ el, buffer }: DecodedFile): Promise<void> {
      const mine = ++pass;
      const current = (): boolean => mine === pass;

      offlineCues = [];
      offlineFailures = 0;
      o.timeline.replaceSource('offline', 0, []);

      let shown = 0;
      try {
        const result = await analyzeOffline(
          downmix(buffer),
          buffer.sampleRate,
          (input) => askJevOnce(input, current),
          (p) => {
            const step = Math.floor(p * 10) * 10;
            if (step <= shown || !current()) return;
            shown = step;
            toast(`analysing the track… ${step}%`);
          },
        );
        if (!current()) return;
        offlineCues = result.timeline;
        toast(`timeline ready — ${result.segments.length} sections`);
      } catch {
        if (!current()) return;
        toast('could not pre-analyse that file; playing it live', 'error');
      }
      if (!current()) return;

      // Cue times come out of the sweep in *track* time. Only the transport
      // knows where that sits on the audio clock, and only once it is running
      // — and it moves every time the user seeks.
      const onPlay = (): void => {
        if (current()) place(el);
      };
      el.addEventListener('play', onPlay);
      el.addEventListener('seeked', onPlay);
    },
  };
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

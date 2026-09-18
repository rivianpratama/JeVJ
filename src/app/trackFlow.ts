/**
 * A whole track, from a pasted link or a dropped file to a finished timeline.
 *
 * v2 has one pipeline and both ways in go down it: download (or read) the
 * audio, decode it, analyze all of it, put the cues on the timeline, and only
 * then let a sample of it play. A YouTube link costs a download first and
 * carries a picture at the end of it; a dropped file skips straight to the
 * decode and has nothing to show. Everything after that is identical, which is
 * why this is one module rather than two — v1 had a file path and a captured-tab
 * path that shared nothing, and the two could never be compared.
 *
 * Three things make it its own module rather than a function in `transport`.
 *
 * The **progress bar** is a fiction assembled here: the download reports 0-100
 * of itself and the analysis reports 0..1 of itself, and the caption wants one
 * number that only goes up. So the download owns the first 40% of a link's bar
 * and the analysis the rest, and a file's analysis owns all of it.
 *
 * The **cache** is checked before any of it: a track analyzed once is a
 * `GET /api/analysis/<videoId>` away from being instant, and the difference on
 * a four-minute track is a minute of waiting or none.
 *
 * And the **clock**. Everything the analysis says is in *track* seconds, and
 * everything the visuals read is on the audio clock, and the offset between
 * them only exists once the element is playing — and moves every time it
 * seeks. That mapping is v1's, unchanged, because it was the one part of the
 * file path that was already right.
 */

import { analyzeTrack, httpDeps, type TrackAnalysisDeps } from './trackAnalysis';
import { resolveYouTube, type JobState } from '../source/youtubeJob';
import { parseYouTubeUrl } from '../source/urlParse';
import { validateTrackAnalysis } from '../shared/moodSchema';
import type { Cue, TrackAnalysis } from '../shared/types';
import type { CueTimeline } from '../timeline/timeline';

/** Where the download's share of the bar ends and the analysis's begins. */
export const DOWNLOAD_END = 40;

/** The download's 0-100 as the first `DOWNLOAD_END`% of the caption's bar. */
export function downloadPercent(jobPercent: number): number {
  return clamp01(jobPercent / 100) * DOWNLOAD_END;
}

/**
 * `analyzeTrack`'s 0..1 as the rest of the bar, from wherever the phase before
 * it ended: `DOWNLOAD_END` for a link, 0 for a file, which has no download to
 * wait for and would otherwise open on a bar that is already 40% full.
 */
export function analysisPercent(p: number, from: number): number {
  return from + (100 - from) * clamp01(p);
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** What came out of the pipeline, as the screen needs to know it. */
export interface OpenedTrack {
  /** Whether there is a picture: a download has one, an audio file does not. */
  video: boolean;
  durationSec: number;
}

export interface TrackFlowOptions {
  timeline: CueTimeline;
  /** The one element everything plays through; see `card.video`. */
  el: HTMLMediaElement;
  /** The audio clock the cues end up on. Building it is the caller's problem. */
  ctx: () => AudioContext;
  /** 0-100 across the whole pipeline, monotone within one track. */
  onProgress: (percent: number) => void;
  /** The download is done and the analysis is starting. */
  onResolved?: () => void;
  /**
   * The finished record, cache hit or fresh analysis.
   *
   * It is not the same thing as `OpenedTrack`: that is what the *screen* needs
   * to know, and this is the transcript — every question and every answer, with
   * the track time each is about. The scrolling columns are its only reader.
   */
  onAnalysis?: (a: TrackAnalysis) => void;
  fetchFn?: typeof fetch;
  /** The two model callbacks. Injected so a test never reaches the network. */
  deps?: (o: { title?: string; videoId?: string }) => TrackAnalysisDeps;
}

export interface TrackFlow {
  /** A pasted link, downloaded and analyzed. Null if another track took over. */
  open(url: string): Promise<OpenedTrack | null>;
  /** A dropped file, decoded and analyzed. Null if another track took over. */
  openFile(file: File): Promise<OpenedTrack | null>;
  /** Whatever is running is about a track that is being replaced. */
  cancel(): void;
}

export function createTrackFlow(o: TrackFlowOptions): TrackFlow {
  const fetchFn = o.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const buildDeps = o.deps ?? ((x) => httpDeps({ ...x, fetchFn }));

  /** The whole track's cues in *track* time, until a play offset maps them. */
  let cues: Cue[] = [];
  /** Which pass is the current one; a late one writes nothing. */
  let pass = 0;
  /** How far the clocks may part before the track is re-placed, in seconds. */
  const REPLACE_EPSILON_SEC = 0.05;
  /** The object URL of a dropped file, so the last one can be let go. */
  let objectUrl: string | null = null;

  /**
   * The offline timeline, moved onto the audio clock the renderer reads.
   *
   * Bound to the element once, here, rather than per track: in v2 there is
   * exactly one media element for the life of the page — it has to be, since
   * `createMediaElementSource` can only be called on an element once — so the
   * listeners outlive every track that plays through it.
   */
  function place(): void {
    if (cues.length === 0) return;
    const offset = currentOffset();
    if (!Number.isFinite(offset)) return;
    placedAt = offset;
    o.timeline.replaceSource(
      'offline',
      0,
      cues.map((c) => ({ ...c, t: c.t + offset })),
    );
  }
  function currentOffset(): number {
    return o.ctx().currentTime - o.el.currentTime;
  }
  /** The offset the cues are placed at, or NaN before any placement. */
  let placedAt = Number.NaN;

  // `playing`, not `play`: `play` fires when play() is *called*, and a video
  // that still has to buffer and prime its decoder sits at currentTime 0 for
  // up to a couple of seconds while the audio clock runs on. An offset taken
  // then is short by exactly that much, and every cue in the track fires that
  // much too soon. `playing` fires when frames actually start moving, and
  // again after every stall, which is the other time the two clocks part.
  o.el.addEventListener('playing', place);
  o.el.addEventListener('seeked', place);
  // And a check four times a second for the drift nothing announces. The
  // threshold is above the jitter of a `currentTime` read, well below anything
  // a listener could see.
  o.el.addEventListener('timeupdate', () => {
    if (!Number.isFinite(placedAt) || Math.abs(currentOffset() - placedAt) > REPLACE_EPSILON_SEC) place();
  });

  /** Start of a pass: the old track's cues are not this track's. */
  function begin(): number {
    cues = [];
    o.timeline.replaceSource('offline', 0, []);
    return ++pass;
  }

  /** Point the element at `src`, letting go of whatever it held before. */
  function load(src: string, revocable: boolean): void {
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    objectUrl = revocable ? src : null;
    o.el.src = src;
    o.el.load();
  }

  /** The audio of `data`, decoded and mixed down to the one channel we read. */
  async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
    try {
      return await o.ctx().decodeAudioData(data);
    } catch {
      throw new Error('that audio could not be decoded');
    }
  }

  /**
   * The analysis for this track: the cached one if the server has it, a fresh
   * one otherwise, cached on the way out.
   *
   * A cache miss is the ordinary case and costs one 404; a hit skips tens of
   * seconds of model calls. Neither the read nor the write is allowed to fail
   * the track — a cache that is broken is a cache that is not there.
   */
  async function analysisOf(
    buffer: AudioBuffer,
    from: number,
    about: { title?: string; videoId?: string },
  ): Promise<TrackAnalysis> {
    const cached = about.videoId === undefined ? null : await readCache(about.videoId);
    if (cached !== null) {
      o.onProgress(100);
      return cached;
    }

    const analysis = await analyzeTrack(downmix(buffer), buffer.sampleRate, buildDeps(about), (p) =>
      o.onProgress(analysisPercent(p, from)),
    );
    if (about.videoId !== undefined) await writeCache(about.videoId, analysis);
    return analysis;
  }

  async function readCache(videoId: string): Promise<TrackAnalysis | null> {
    try {
      const res = await fetchFn(`/api/analysis/${encodeURIComponent(videoId)}`);
      if (!res.ok) return null;
      const checked = validateTrackAnalysis(await res.json());
      return checked.ok ? checked.value : null;
    } catch {
      return null;
    }
  }

  async function writeCache(videoId: string, analysis: TrackAnalysis): Promise<void> {
    try {
      await fetchFn(`/api/analysis/${encodeURIComponent(videoId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(analysis),
      });
    } catch {
      // The next play of this track will simply analyze it again.
    }
  }

  return {
    cancel(): void {
      pass += 1;
    },

    async open(url: string): Promise<OpenedTrack | null> {
      const mine = begin();
      const current = (): boolean => mine === pass;

      const parsed = parseYouTubeUrl(url);
      if (parsed === null) throw new Error('that does not look like a youtube link');

      o.onProgress(0);
      const media = await resolveYouTube(
        url,
        (job: JobState) => {
          if (current()) o.onProgress(downloadPercent(job.percent));
        },
        fetchFn,
      );
      if (!current()) return null;
      o.onResolved?.();

      // The element and the decoder read the same file: the first so it can be
      // watched, the second so it can be analyzed. The second read is served
      // from the browser's cache, and both are off our own disk anyway.
      load(media.mediaUrl, false);
      const res = await fetchFn(media.mediaUrl);
      if (!res.ok) throw new Error('the downloaded track could not be read back');
      const buffer = await decode(await res.arrayBuffer());
      if (!current()) return null;

      const analysis = await analysisOf(buffer, DOWNLOAD_END, {
        title: media.title,
        videoId: parsed.videoId,
      });
      if (!current()) return null;

      cues = analysis.cues;
      o.onAnalysis?.(analysis);
      return { video: true, durationSec: analysis.durationSec || media.durationSec };
    },

    async openFile(file: File): Promise<OpenedTrack | null> {
      const mine = begin();
      const current = (): boolean => mine === pass;

      o.onProgress(0);
      const buffer = await decode(await file.arrayBuffer());
      if (!current()) return null;
      load(URL.createObjectURL(file), true);

      const analysis = await analysisOf(buffer, 0, { title: file.name });
      if (!current()) return null;

      cues = analysis.cues;
      o.onAnalysis?.(analysis);
      return { video: false, durationSec: analysis.durationSec };
    },
  };
}

/** Every channel into one, which is what the analysis chain reads. */
export function downmix(buffer: AudioBuffer): Float32Array {
  const first = buffer.getChannelData(0);
  if (buffer.numberOfChannels < 2) return first;

  const out = new Float32Array(first.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + channel[i]! / buffer.numberOfChannels;
  }
  return out;
}

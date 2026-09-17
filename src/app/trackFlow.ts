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
 * them only exists once the element is playing — and moves every time it seeks.
 *
 * v1 took that offset once, on `play`, as `ctx.currentTime − el.currentTime`.
 * Two things are wrong with a single reading. `el.currentTime` is quantised to
 * whatever the element feels like reporting and is *stale* by an unpredictable
 * amount at the instant it is read, so one sample carries tens of milliseconds
 * of jitter — straight into every cue in the track. And the two clocks drift:
 * a media element's playback rate is its own, and over four minutes it does not
 * stay where it started. So the offset is now a running **median of the last
 * eight readings**, re-seeded on every seek, and the timeline is only re-placed
 * when the median has actually moved — see `OFFSET_EPSILON_SEC`. A median and
 * not a mean, because the error is one-sided: a stale `currentTime` is always
 * *behind*, never ahead, and one bad sample must not move the picture.
 */

import { analyzeTrack, httpDeps, type TrackAnalysisDeps } from './trackAnalysis';
import { resolveYouTube, type JobState } from '../source/youtubeJob';
import { parseYouTubeUrl } from '../source/urlParse';
import { validateTrackAnalysis } from '../shared/moodSchema';
import type { Cue, TrackAnalysis } from '../shared/types';
import type { CueTimeline } from '../timeline/timeline';

/** Where the download's share of the bar ends and the analysis's begins. */
export const DOWNLOAD_END = 40;

/**
 * How many offset readings the median is taken over, and how far it has to move
 * before the whole track is re-placed on the audio clock.
 *
 * Eight readings is about two seconds of `timeupdate` (the element fires it
 * roughly four times a second) or an eighth of a second of
 * `requestVideoFrameCallback`, which is long enough to reject a stale sample
 * and short enough to follow a real drift.
 *
 * 5 ms is under the threshold at which a listener can hear a visual and a
 * transient come apart, and re-placing costs a rewrite of every cue in the
 * track — so anything smaller would be paying a rewrite several times a second
 * for a correction nobody can see.
 */
export const OFFSET_WINDOW = 8;
export const OFFSET_EPSILON_SEC = 0.005;

/** The middle of `xs`, which must not be empty. Does not mutate it. */
export function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

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
  /** The object URL of a dropped file, so the last one can be let go. */
  let objectUrl: string | null = null;

  /** The last `OFFSET_WINDOW` readings of the gap between the two clocks. */
  let offsets: number[] = [];
  /** The offset the timeline is currently placed at, or NaN before any. */
  let placedAt = Number.NaN;

  /**
   * The offline timeline, moved onto the audio clock the renderer reads.
   *
   * Bound to the element once, here, rather than per track: in v2 there is
   * exactly one media element for the life of the page — it has to be, since
   * `createMediaElementSource` can only be called on an element once — so the
   * listeners outlive every track that plays through it.
   */
  function place(offset: number): void {
    // Nothing to place yet is not a placement: recording the offset here would
    // let the first reading taken before the analysis finished satisfy the
    // epsilon and leave the finished track un-placed until the clocks drifted.
    if (cues.length === 0) return;
    placedAt = offset;
    o.timeline.replaceSource(
      'offline',
      0,
      cues.map((c) => ({ ...c, t: c.t + offset })),
    );
  }

  /**
   * One reading of the gap between the two clocks, folded into the median.
   *
   * `mediaTime` is where the element says it is; a `requestVideoFrameCallback`
   * supplies the one the compositor actually presented, which is the honest
   * number when there is a picture. Everything else passes `el.currentTime`.
   */
  function sampleOffset(mediaTime: number): void {
    if (!Number.isFinite(mediaTime)) return;
    const now = o.ctx().currentTime;
    if (!Number.isFinite(now)) return;
    offsets.push(now - mediaTime);
    if (offsets.length > OFFSET_WINDOW) offsets.shift();
    const middle = median(offsets);
    if (!Number.isFinite(placedAt) || Math.abs(middle - placedAt) >= OFFSET_EPSILON_SEC) {
      place(middle);
    }
  }

  /**
   * Throw the readings away and take a fresh one.
   *
   * A seek moves one clock and not the other, so every sample taken before it
   * is about a different mapping; a median that still held them would crawl
   * toward the new offset over the next two seconds instead of jumping to it.
   */
  function reseed(): void {
    offsets = [];
    placedAt = Number.NaN;
    sampleOffset(o.el.currentTime);
  }

  o.el.addEventListener('play', reseed);
  o.el.addEventListener('seeked', reseed);
  o.el.addEventListener('timeupdate', () => sampleOffset(o.el.currentTime));

  // A `<video>` can say when a frame was actually presented and which media
  // time was on it, which is the one reading that is not an estimate. It only
  // fires while the picture is being composited, so it supplements the
  // `timeupdate` sampling rather than replacing it.
  const video = o.el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  };
  if (typeof video.requestVideoFrameCallback === 'function') {
    const onFrame = (_now: number, meta: { mediaTime: number }): void => {
      sampleOffset(meta.mediaTime);
      video.requestVideoFrameCallback?.(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  /** Start of a pass: the old track's cues are not this track's. */
  function begin(): number {
    cues = [];
    offsets = [];
    placedAt = Number.NaN;
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

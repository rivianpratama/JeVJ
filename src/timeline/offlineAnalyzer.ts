/**
 * The whole track, before a note of it has played.
 *
 * A local file can offer something a live stream never can: the future. This
 * sweeps the decoded samples through exactly the chain that runs live —
 * `AnalysisPipeline`, frame by frame, faster than real time — then cuts the
 * result into sections, asks Jev once about each, and hands back a cue
 * timeline for the entire track. Anticipation can then be exact rather than
 * predictive: the drop at 2:14 is on the timeline before the first bar plays.
 *
 * Three things fall out of the sweep and all three end up on the timeline:
 *
 * - **beats**, from the same grid the live path uses, which is what a cue can
 *   be snapped to — back-filled to the top of the track, because the grid
 *   cannot lock until it has heard a few seconds and those seconds still have
 *   to be danced to;
 * - **impacts and holes**, at the instant the detector called them. These are
 *   exact timestamps; nothing here is quantized to the 200 ms step. Like every
 *   other writer this one compensates for nothing — the reporting lag comes
 *   off once, in the reader (`src/app/cueReader.ts`);
 * - **moods**, one per segment, at the segment's start, which the timeline
 *   then cross-fades between.
 *
 * Segmentation is the interesting choice. A model call per second would be
 * both slow and pointless — the music does not change every second — so a
 * boundary is cut where the summarizer says the music turned a corner, or
 * where the payload has moved far from the one of a few seconds ago, with a
 * floor of eight seconds so a busy passage cannot shred the track and a
 * ceiling of forty calls so a long one cannot run up a bill.
 *
 * Pure: `Float32Array` in, cues out. No `AudioContext`, no DOM, no fetch — the
 * caller supplies `askJev`, which is the only part that talks to anything.
 */

import { fftMagnitudes } from '../analysis/fft';
import { FeatureExtractor } from '../analysis/features';
import { AnalysisPipeline } from '../analysis/pipeline';
import { Summarizer } from '../analysis/summarizer';
import { CueTimeline } from './timeline';
import type { Beat, GridState } from '../analysis/grid';
import type { Cue, FrameFeatures, MoodInput, MoodVector } from '../shared/types';

/** 60 frames a second, as the live loop gets from the display. */
export const OFFLINE_HOP_SEC = 0.0167;
/** The analyser window the live graph uses, so the features match. */
export const OFFLINE_FFT_SIZE = 4096;

/** How often a payload is built for the segmentation to look at. */
const SAMPLE_SEC = 0.5;
/** The shortest a segment may be — one model call has to cover this much. */
const MIN_SEGMENT_SEC = 8;
/** How far the payload must move from the one a few seconds ago to cut. */
const NOVELTY_BOUNDARY = 0.35;
/** How stale the reference a section boundary is judged against may get. */
const SECTION_REFERENCE_SEC = 4;
/** A boundary this close to the end would buy a call for a few seconds of music. */
const MIN_TAIL_SEC = 2;
/** The most calls one track may cost. */
const MAX_SEGMENTS = 40;
/** How much of the progress bar the sweep owns; the calls own the rest. */
const SWEEP_SHARE = 0.8;
/** Frames between yields, so a browser can paint a progress toast. */
const YIELD_EVERY = 256;
/** The shortest a hole's release may be: one beat at 120 BPM. */
const MIN_GAP_RELEASE_SEC = 0.5;

export interface OfflineSegment {
  start: number;
  end: number;
  /** The payload Jev was asked about, taken from the middle of the segment. */
  input: MoodInput;
}

export interface OfflineResult {
  features: FrameFeatures[];
  timeline: Cue[];
  segments: OfflineSegment[];
}

export async function analyzeOffline(
  mono: Float32Array,
  sampleRate: number,
  askJev: (input: MoodInput) => Promise<MoodVector>,
  onProgress?: (p: number) => void,
): Promise<OfflineResult> {
  const progress = reporter(onProgress);
  const features: FrameFeatures[] = [];
  const tl = new CueTimeline();

  if (mono.length === 0 || !(sampleRate > 0)) {
    progress(1);
    return { features, timeline: [], segments: [] };
  }

  const hop = Math.max(1, Math.round(OFFLINE_HOP_SEC * sampleRate));
  const duration = mono.length / sampleRate;
  const extractor = new FeatureExtractor({ sampleRate, fftSize: OFFLINE_FFT_SIZE });
  const pipeline = new AnalysisPipeline();

  /** Payloads taken every `SAMPLE_SEC`, to cut on and to ask with. */
  const samples: Array<{ t: number; input: MoodInput }> = [];
  const bounds: number[] = [0];

  /** A payload from about four seconds ago — what a *change* is relative to. */
  let reference: MoodInput | null = null;
  let referenceAt = -Infinity;
  let nextSampleAt = 0;
  let lastDropAt = Number.NaN;
  /** Whether the beats before the grid locked have been written yet. */
  let backfilled = false;

  const window = new Float32Array(OFFLINE_FFT_SIZE);
  const frames = Math.ceil(mono.length / hop);

  for (let i = 0; i < frames; i++) {
    // The window *ends* at the frame's time, which is the geometry an
    // `AnalyserNode` has: the samples that arrived before this instant.
    fillWindow(window, mono, i * hop);
    const t = (i * hop) / sampleRate;
    const f = extractor.extract(fftMagnitudes(window), window, t);
    features.push(f);

    const snap = pipeline.step(f);

    for (const beat of snap.beats) {
      tl.add({ t: beat.t, source: 'offline', beat: true, downbeat: beat.downbeat });
      // The first beat the grid ever emits is several seconds into the track,
      // because that is how long a tempo takes to measure. The beats before it
      // were still played, at the same period and the same downbeat phase, and
      // offline is the one mode that can say so after the fact.
      if (!backfilled) {
        backfilled = true;
        backfill(tl, beat, snap.grid);
      }
    }

    const drop = snap.drop;
    if (drop !== null && drop.t !== lastDropAt) {
      lastDropAt = drop.t;
      if (drop.kind === 'impact') {
        tl.add({ t: drop.t, source: 'offline', impact: drop.strength });
      } else {
        // Full tension when the floor goes, released a beat later: a hole
        // nothing follows up on is a quiet passage, not a held breath.
        const beatSec = snap.grid.period > 0 && Number.isFinite(snap.grid.period)
          ? snap.grid.period
          : 0;
        const release = Math.max(beatSec, MIN_GAP_RELEASE_SEC);
        tl.add({ t: drop.t, source: 'offline', build: 1 });
        tl.add({ t: drop.t + release, source: 'offline', build: 0 });
      }
    }

    if (t >= nextSampleAt) {
      nextSampleAt = t + SAMPLE_SEC;
      const input = Summarizer.fromSnapshot(snap, t, duration);
      samples.push({ t, input });

      const segmentStart = bounds[bounds.length - 1]!;
      // Both questions are asked of the same few-seconds-old payload: a
      // boundary is a *change*, and drift measured from the top of the
      // segment would cross the threshold on length alone — every segment
      // would then be exactly the minimum long, which is not segmentation.
      const turned =
        reference !== null &&
        (Summarizer.sectionChanged(reference, input) ||
          Summarizer.novelty(reference, input) >= NOVELTY_BOUNDARY);

      let cut = false;
      if (turned && t - segmentStart >= MIN_SEGMENT_SEC && duration - t >= MIN_TAIL_SEC) {
        bounds.push(t);
        cut = true;
        pipeline.markSectionChange(t);
      }

      // What came before a boundary is not what the next one should be judged
      // against, so a cut re-takes the reference along with everything else.
      if (reference === null || cut || t - referenceAt >= SECTION_REFERENCE_SEC) {
        reference = input;
        referenceAt = t;
      }
    }

    progress((SWEEP_SHARE * (i + 1)) / frames);
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToHost();
  }

  const segments = mergeSegments(spans(bounds, duration), samples);

  // Sequential on purpose: forty parallel calls would be forty rate-limit
  // errors, and nothing downstream can start before the last of them anyway.
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const mood = await askJev(segment.input);
    tl.add({ t: segment.start, source: 'offline', mood });
    progress(SWEEP_SHARE + ((1 - SWEEP_SHARE) * (i + 1)) / segments.length);
  }

  progress(1);
  return { features, timeline: [...tl.cues()], segments };
}

/**
 * The beats before `first`, back to the top of the track.
 *
 * The grid needs a few seconds of music before it can say anything, so its
 * first beat is never the track's first beat. Offline, the period and the
 * downbeat phase it settled on are known facts about what already played:
 * step backwards at that period, keeping the bar count going, and the opening
 * of the track has a grid too. Live, nothing can do this — which is the whole
 * point of the offline pass.
 */
function backfill(tl: CueTimeline, first: Beat, grid: GridState): void {
  const { period, barLength, downbeatOffset } = grid;
  if (!(period > 0) || !Number.isFinite(period)) return;

  for (let k = 1; ; k++) {
    const t = first.t - k * period;
    if (t < 0) return;
    const index = first.index - k;
    tl.add({
      t,
      source: 'offline',
      beat: true,
      downbeat: ((index % barLength) + barLength) % barLength === downbeatOffset,
    });
  }
}

/** `out` filled with the `out.length` samples ending at `end`; short reads are silence. */
function fillWindow(out: Float32Array, mono: Float32Array, end: number): void {
  const start = end - out.length;
  for (let j = 0; j < out.length; j++) {
    const at = start + j;
    out[j] = at >= 0 && at < mono.length ? mono[at]! : 0;
  }
}

/** Boundary times to [start, end) spans. */
function spans(bounds: number[], duration: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < bounds.length; i++) {
    out.push({ start: bounds[i]!, end: i + 1 < bounds.length ? bounds[i + 1]! : duration });
  }
  return out;
}

/**
 * At most `MAX_SEGMENTS` spans, each with the payload nearest its middle.
 *
 * Too many is fixed by folding the shortest span into its shorter neighbour
 * and repeating: the shortest span is the one whose boundary was least worth
 * spending a call on, and its shorter neighbour is the one that least dilutes.
 */
export function mergeSegments(
  raw: Array<{ start: number; end: number }>,
  samples: Array<{ t: number; input: MoodInput }>,
): OfflineSegment[] {
  const spansLeft = raw.slice();
  while (spansLeft.length > MAX_SEGMENTS) {
    let shortest = 0;
    for (let i = 1; i < spansLeft.length; i++) {
      if (length(spansLeft[i]!) < length(spansLeft[shortest]!)) shortest = i;
    }
    const before = spansLeft[shortest - 1];
    const after = spansLeft[shortest + 1];
    const into =
      before === undefined
        ? shortest + 1
        : after === undefined || length(before) <= length(after)
          ? shortest - 1
          : shortest + 1;

    const a = Math.min(into, shortest);
    const b = Math.max(into, shortest);
    spansLeft.splice(a, 2, { start: spansLeft[a]!.start, end: spansLeft[b]!.end });
  }

  return spansLeft.flatMap((s) => {
    const input = nearestSample(samples, (s.start + s.end) / 2);
    return input === null ? [] : [{ start: s.start, end: s.end, input }];
  });
}

function length(s: { start: number; end: number }): number {
  return s.end - s.start;
}

/** The payload taken closest to `t` — the middle of a segment describes it best. */
function nearestSample(samples: Array<{ t: number; input: MoodInput }>, t: number): MoodInput | null {
  let best: { t: number; input: MoodInput } | null = null;
  for (const s of samples) {
    if (best === null || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  }
  return best?.input ?? null;
}

/** Progress, clamped, monotonic and reported at most once a percent. */
function reporter(onProgress: ((p: number) => void) | undefined): (p: number) => void {
  let last = -1;
  return (p: number): void => {
    if (onProgress === undefined) return;
    const next = Math.min(1, Math.max(0, p));
    if (next < last + 0.01 && next < 1) return;
    if (next === last) return;
    last = next;
    onProgress(next);
  };
}

/** Let the host paint. A browser is drawing a progress toast over this. */
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

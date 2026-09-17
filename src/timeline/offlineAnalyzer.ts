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
 * Since v2 the sweep also feeds a second pass. Everything below is pass 1 —
 * segments, one mood each — and what it hands on is the raw material pass 2
 * needs to ask about *moments*: the per-frame features, the two new detector
 * tracks (`vocal`, `harsh`), every payload it took along the way, and the
 * candidate list `findCandidates` builds out of all of them. Pass 2 itself
 * lives in `src/app/trackAnalysis.ts`, because it is a second round of network
 * calls and this file's job is the sweep.
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
import { ONSET_REPORT_LAG_SEC } from '../analysis/onset';
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

/** How far a novelty peak has to stand out before it is worth a question. */
const CANDIDATE_NOVELTY = 0.25;
/** Bars between two novelty peaks; closer than this they are one moment. */
const CANDIDATE_SPACING_BARS = 4;
/** A tempo that moved by this share is a tempo change. */
const TEMPO_CHANGE_RATIO = 0.06;
/** How sure of a key we have to be before a new tonic means anything. */
const KEY_CHANGE_FIT = 0.5;
/** Where `vocal` and `harsh` are read as crossing into their feature. */
const VOCAL_CROSSING = 0.5;
const HARSH_CROSSING = 0.6;
/**
 * The novelty a feature crossing is credited with, which is what it has to
 * survive the cap on.
 *
 * A crossing is not a novelty peak — the payload may barely move when a singer
 * starts screaming over a riff that was already there — so it has to be given a
 * number, and the number decides whether the cap keeps it. `CANDIDATE_NOVELTY`
 * for both was too little for `harsh`: on *Duality* the harshness crosses 0.6
 * four or five times in three and a half minutes, and every one of them lost
 * its slot to one of the track's twenty-nine tempo wobbles, which is why a
 * track that is nothing but screaming returned no `scream_peak` at all. A
 * harshness crossing is the rarest candidate this finder produces and the one
 * a listener is most certain to notice, so it outranks everything but a real
 * slam.
 */
const VOCAL_CROSSING_NOVELTY = CANDIDATE_NOVELTY;
const HARSH_CROSSING_NOVELTY = 0.7;
/**
 * How long a crossing has to hold before it counts.
 *
 * Both features are already smoothed, but a signal sitting on its threshold
 * still wobbles across it, and every wobble would otherwise be a model call.
 * Half a second is shorter than any musical event and longer than any wobble.
 */
const CROSSING_HOLD_SEC = 0.5;
/** Two candidates this close together are one moment. */
const CANDIDATE_MERGE_SEC = 0.3;
/** The most moments one track may cost. */
const MAX_CANDIDATES = 60;
/** A sane bar when the grid never locked. */
const FALLBACK_BAR_SEC = 2;

/**
 * How far back a refinement looks for the attack, and how finely it looks.
 *
 * A detector event is stamped at the *end* of the analyser window it was found
 * in — 4096 samples, so up to 93 ms after the transient actually sounded, and a
 * different amount each time depending on where in the window the attack fell.
 * That is invisible on a pad and plainly wrong on a slam: the picture flashes
 * an eighth of a beat late, and a listener hears the visualizer lagging.
 *
 * Offline there is no reason to guess. The samples are all there, so the
 * envelope can simply be looked at: a millisecond-resolution RMS over the
 * 120 ms behind the event — comfortably more than one window — and the instant
 * of steepest *rise* in it. That is where the energy arrived, which is what a
 * listener calls the hit.
 *
 * 1 ms is finer than any ear discriminates and coarse enough that the envelope
 * is still an envelope rather than the waveform; 120 ms covers the whole window
 * plus a little, and no more, because two bass notes an eighth apart at 150 BPM
 * are 100 ms apart and a longer search would find the wrong one.
 */
const REFINE_WINDOW_SEC = 0.12;
const ENVELOPE_HOP_SEC = 0.001;

/** What found a candidate — which is also what makes it worth asking about. */
export type CandidateReason = 'novelty' | 'impact' | 'gap' | 'tempo' | 'key' | 'vocal' | 'harsh';

/** One moment worth asking Jev to name. */
export interface TransitionCandidate {
  t: number;
  reason: CandidateReason;
  /** How far the music moved around here, 0..1. The cap keeps the highest. */
  novelty: number;
  /** The detector's own instant, when a detector is what found this. */
  detectorT?: number;
}

/** One payload taken during the sweep, with what was true when it was taken. */
export interface OfflineSample {
  t: number;
  input: MoodInput;
  /** How far this payload had moved from the one a few seconds before it. */
  novelty: number;
  /** The key tracker's tonic and how well it fits, for the key-change rule. */
  tonic: number;
  fit: number;
  /** Seconds in a bar here — what a two-bar ramp is measured in. */
  barSec: number;
}

/** A segment before Jev has been asked about it. */
export type SegmentSpan = Omit<OfflineSegment, 'mood'>;

export interface OfflineSegment {
  start: number;
  end: number;
  /** The payload Jev was asked about, taken from the middle of the segment. */
  input: MoodInput;
  /** What Jev said about it. */
  mood: MoodVector;
}

export interface OfflineResult {
  features: FrameFeatures[];
  /** Per frame, aligned with `features`: how much of a voice, how abrasive. */
  vocal: Float32Array;
  harsh: Float32Array;
  timeline: Cue[];
  segments: OfflineSegment[];
  /** Every payload taken during the sweep, half a second apart. */
  samples: OfflineSample[];
  /** The moments pass 2 should ask about, in time order. */
  candidates: TransitionCandidate[];
}

/**
 * The instant a transient at frame-end time `frameEnd` actually sounded.
 *
 * Returns the point of steepest rise in the 1 ms RMS envelope over the
 * `REFINE_WINDOW_SEC` before `frameEnd`. When there is no rise to find — a
 * clipped window at the top of the track, silence, a detector event on a fade —
 * it falls back to `frameEnd − ONSET_REPORT_LAG_SEC`, which is the one-frame
 * correction the live path has always used and is never worse than nothing.
 *
 * Pure: samples in, a time out.
 */
export function refineOnsetTime(
  mono: Float32Array,
  sampleRate: number,
  frameEnd: number,
): number {
  const fallback = frameEnd - ONSET_REPORT_LAG_SEC;
  if (!(sampleRate > 0) || !Number.isFinite(frameEnd) || mono.length === 0) return fallback;

  const hop = Math.max(1, Math.round(ENVELOPE_HOP_SEC * sampleRate));
  const end = Math.min(mono.length, Math.round(frameEnd * sampleRate));
  const start = Math.max(0, end - Math.round(REFINE_WINDOW_SEC * sampleRate));
  const blocks = Math.floor((end - start) / hop);
  // Two blocks make one slope; fewer than three is not an envelope.
  if (blocks < 3) return fallback;

  let best = 0;
  let bestBlock = -1;
  let previous = rms(mono, start, hop);
  for (let b = 1; b < blocks; b++) {
    const level = rms(mono, start + b * hop, hop);
    const slope = level - previous;
    previous = level;
    if (slope > best) {
      best = slope;
      bestBlock = b;
    }
  }
  // The rise is credited to the boundary the energy crossed, which is the
  // *start* of the block that is louder than the one before it.
  return bestBlock < 0 ? fallback : (start + bestBlock * hop) / sampleRate;
}

/** Root mean square of `count` samples from `from`. */
function rms(mono: Float32Array, from: number, count: number): number {
  let sum = 0;
  const end = Math.min(mono.length, from + count);
  for (let i = from; i < end; i++) sum += mono[i]! * mono[i]!;
  const n = end - from;
  return n > 0 ? Math.sqrt(sum / n) : 0;
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
    return {
      features,
      vocal: new Float32Array(0),
      harsh: new Float32Array(0),
      timeline: [],
      segments: [],
      samples: [],
      candidates: [],
    };
  }

  const hop = Math.max(1, Math.round(OFFLINE_HOP_SEC * sampleRate));
  const duration = mono.length / sampleRate;
  const extractor = new FeatureExtractor({ sampleRate, fftSize: OFFLINE_FFT_SIZE });
  const pipeline = new AnalysisPipeline();

  /** Payloads taken every `SAMPLE_SEC`, to cut on and to ask with. */
  const samples: OfflineSample[] = [];
  const bounds: number[] = [0];
  /** Every slam and hole the detector called, for the candidate finder. */
  const drops: Array<{ t: number; kind: 'impact' | 'gap'; strength: number }> = [];

  /** A payload from about four seconds ago — what a *change* is relative to. */
  let reference: MoodInput | null = null;
  let referenceAt = -Infinity;
  let nextSampleAt = 0;
  let lastDropAt = Number.NaN;
  /** Whether the beats before the grid locked have been written yet. */
  let backfilled = false;

  const window = new Float32Array(OFFLINE_FFT_SIZE);
  const frames = Math.ceil(mono.length / hop);
  // Per frame, so pass 2 can find a crossing to the frame rather than to the
  // half-second the payloads are taken at.
  const vocal = new Float32Array(frames);
  const harsh = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    // The window *ends* at the frame's time, which is the geometry an
    // `AnalyserNode` has: the samples that arrived before this instant.
    fillWindow(window, mono, i * hop);
    const t = (i * hop) / sampleRate;
    const f = extractor.extract(fftMagnitudes(window), window, t);
    features.push(f);

    const snap = pipeline.step(f);
    vocal[i] = snap.vocal;
    harsh[i] = snap.harsh;

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
        // The one place a timestamp is moved rather than passed through, and it
        // is a *correction* rather than a compensation: the detector's instant
        // is the end of the window it noticed the transient in, and this is the
        // instant the transient is actually at. Everything downstream — the
        // candidate, the model's verdict, the anticipation ramp drawn in front
        // of the hit — hangs off this number. See `refineOnsetTime`.
        const at = refineOnsetTime(mono, sampleRate, drop.t);
        drops.push({ t: at, kind: drop.kind, strength: drop.strength });
        tl.add({ t: at, source: 'offline', impact: drop.strength });
      } else {
        // A hole is not a transient: its edge is where the energy *left*, and
        // there is no attack in the envelope to find. The frame time stands.
        drops.push({ t: drop.t, kind: drop.kind, strength: drop.strength });
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
      const barSec = snap.grid.period * snap.grid.barLength;
      samples.push({
        t,
        input,
        novelty: reference === null ? 0 : Summarizer.novelty(reference, input),
        tonic: snap.key.tonic,
        fit: snap.key.fit,
        barSec: barSec > 0 && Number.isFinite(barSec) ? barSec : FALLBACK_BAR_SEC,
      });

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

  const spansLeft = mergeSegments(spans(bounds, duration), samples);
  const candidates = findCandidates({
    samples,
    drops,
    frames: features,
    vocal,
    harsh,
  });

  // Sequential on purpose: forty parallel calls would be forty rate-limit
  // errors, and nothing downstream can start before the last of them anyway.
  const segments: OfflineSegment[] = [];
  for (let i = 0; i < spansLeft.length; i++) {
    const segment = spansLeft[i]!;
    const mood = await askJev(segment.input);
    segments.push({ ...segment, mood });
    tl.add({ t: segment.start, source: 'offline', mood });
    progress(SWEEP_SHARE + ((1 - SWEEP_SHARE) * (i + 1)) / spansLeft.length);
  }

  progress(1);
  return { features, vocal, harsh, timeline: [...tl.cues()], segments, samples, candidates };
}

export interface CandidateSources {
  samples: readonly OfflineSample[];
  drops: ReadonlyArray<{ t: number; kind: 'impact' | 'gap'; strength: number }>;
  frames: readonly FrameFeatures[];
  /** Per frame, aligned with `frames`. */
  vocal: ArrayLike<number>;
  harsh: ArrayLike<number>;
}

/**
 * The moments worth asking Jev to name.
 *
 * Six rules, and the reason there are six rather than one is that the things a
 * listener would point at do not share a signature. A drop is a loudness
 * event, a key change is a harmonic one, a voice entering moves neither the
 * loudness nor the harmony — a single "how much did the music change" number
 * would find the first and miss the last two, and a threshold low enough to
 * catch them would return a candidate every bar.
 *
 * So each rule looks for its own kind of evidence and they all feed one list:
 * novelty peaks in the payload stream, every slam and hole the detector
 * called, a tempo that moved, a tonic that moved, and either feature crossing
 * into its own territory. What they emphatically do *not* do is decide what
 * the moment was — that is the model's job, and `none` is one of the answers
 * it can give.
 *
 * Deduplicated, because several rules fire on one moment by design (a drop is
 * a novelty peak *and* an impact *and* often a harshness crossing), and capped
 * at sixty by novelty, because sixty questions is what a track is worth.
 */
export function findCandidates(o: CandidateSources): TransitionCandidate[] {
  const raw: TransitionCandidate[] = [];
  const noveltyAt = (t: number): number => nearestBy(o.samples, t)?.novelty ?? 0;

  // Novelty peaks, highest first, each keeping four bars clear of the ones
  // already taken: a peak is one moment however many samples it spans.
  const peaks = o.samples
    .filter((s, i) => {
      const prev = o.samples[i - 1]?.novelty ?? 0;
      const next = o.samples[i + 1]?.novelty ?? 0;
      return s.novelty >= CANDIDATE_NOVELTY && s.novelty >= prev && s.novelty > next;
    })
    .slice()
    .sort((a, b) => b.novelty - a.novelty);

  const taken: number[] = [];
  for (const peak of peaks) {
    const spacing = CANDIDATE_SPACING_BARS * peak.barSec;
    if (taken.some((t) => Math.abs(t - peak.t) < spacing)) continue;
    taken.push(peak.t);
    raw.push({ t: peak.t, reason: 'novelty', novelty: peak.novelty });
  }

  for (const drop of o.drops) {
    raw.push({
      t: drop.t,
      reason: drop.kind,
      // A detector event is evidence in its own right: a slam the payload
      // stream barely noticed is still a slam, and the cap must not drop it
      // in favour of a quiet drift that happened to score higher.
      novelty: Math.max(noveltyAt(drop.t), drop.strength),
      detectorT: drop.t,
    });
  }

  for (let i = 1; i < o.samples.length; i++) {
    const before = o.samples[i - 1]!;
    const after = o.samples[i]!;

    const bpmBefore = before.input.bpm;
    const bpmAfter = after.input.bpm;
    if (bpmBefore > 0 && bpmAfter > 0) {
      const moved = Math.abs(bpmAfter - bpmBefore) / bpmBefore;
      if (moved > TEMPO_CHANGE_RATIO) {
        raw.push({ t: after.t, reason: 'tempo', novelty: Math.max(after.novelty, moved) });
      }
    }

    if (after.tonic !== before.tonic && after.tonic >= 0 && after.fit > KEY_CHANGE_FIT) {
      raw.push({ t: after.t, reason: 'key', novelty: Math.max(after.novelty, after.fit) });
    }
  }

  for (const c of crossings(o.frames, o.vocal, VOCAL_CROSSING, 'vocal')) {
    raw.push({ ...c, novelty: Math.max(noveltyAt(c.t), VOCAL_CROSSING_NOVELTY) });
  }
  for (const c of crossings(o.frames, o.harsh, HARSH_CROSSING, 'harsh')) {
    raw.push({ ...c, novelty: Math.max(noveltyAt(c.t), HARSH_CROSSING_NOVELTY) });
  }

  return cap(dedupe(raw));
}

/**
 * Where `series` crossed `threshold` and stayed across it.
 *
 * Both the crossing and the hold matter. The crossing is the event; the hold
 * is what keeps a feature resting on its threshold from producing a candidate
 * every few frames, which on a track with a voice mixed at exactly 0.5 would
 * be most of the track.
 */
function crossings(
  frames: readonly FrameFeatures[],
  series: ArrayLike<number>,
  threshold: number,
  reason: CandidateReason,
): TransitionCandidate[] {
  const out: TransitionCandidate[] = [];
  const n = Math.min(frames.length, series.length);
  if (n === 0) return out;

  let above = (series[0] ?? 0) >= threshold;
  let pendingFrom = -1;

  for (let i = 1; i < n; i++) {
    const nowAbove = (series[i] ?? 0) >= threshold;
    if (nowAbove === above) {
      // Back on the old side before the hold elapsed: it was a wobble.
      pendingFrom = -1;
      continue;
    }
    if (pendingFrom < 0) pendingFrom = i;
    const from = frames[pendingFrom]?.t ?? 0;
    if ((frames[i]?.t ?? 0) - from >= CROSSING_HOLD_SEC) {
      out.push({ t: from, reason, novelty: 0 });
      above = nowAbove;
      pendingFrom = -1;
    }
  }
  return out;
}

/**
 * One candidate per moment: the ones within `CANDIDATE_MERGE_SEC` of each
 * other collapse into the strongest, keeping any detector instant among them.
 */
function dedupe(raw: readonly TransitionCandidate[]): TransitionCandidate[] {
  const sorted = raw.slice().sort((a, b) => a.t - b.t);
  const out: TransitionCandidate[] = [];

  for (const c of sorted) {
    const last = out[out.length - 1];
    // Two detector events are never one moment, however close together. The
    // hole and the slam that follows it 150 ms later are the whole point of a
    // silence-slam, and folding them together would throw away whichever of
    // the two scored lower — usually the slam, which is the one with the
    // exact instant the ramp has to land on.
    const bothMeasured = last?.detectorT !== undefined && c.detectorT !== undefined;
    if (last === undefined || bothMeasured || c.t - last.t > CANDIDATE_MERGE_SEC) {
      out.push({ ...c });
      continue;
    }
    // The detector's instant is the exact one, so it survives whichever
    // candidate wins on novelty.
    const winner = c.novelty > last.novelty ? c : last;
    const detectorT = winner.detectorT ?? last.detectorT ?? c.detectorT;
    out[out.length - 1] = {
      t: winner.t,
      reason: winner.reason,
      novelty: Math.max(last.novelty, c.novelty),
      ...(detectorT === undefined ? {} : { detectorT }),
    };
  }
  return out;
}

/** At most `MAX_CANDIDATES`, keeping the highest novelty, back in time order. */
function cap(list: TransitionCandidate[]): TransitionCandidate[] {
  if (list.length <= MAX_CANDIDATES) return list;
  return list
    .slice()
    .sort((a, b) => b.novelty - a.novelty)
    .slice(0, MAX_CANDIDATES)
    .sort((a, b) => a.t - b.t);
}

/** The sample nearest `t`, or null when there are none. */
function nearestBy(samples: readonly OfflineSample[], t: number): OfflineSample | null {
  let best: OfflineSample | null = null;
  for (const s of samples) {
    if (best === null || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  }
  return best;
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
  samples: ReadonlyArray<{ t: number; input: MoodInput }>,
): SegmentSpan[] {
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
function nearestSample(
  samples: ReadonlyArray<{ t: number; input: MoodInput }>,
  t: number,
): MoodInput | null {
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

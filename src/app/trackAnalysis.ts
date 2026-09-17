/**
 * The whole track, analyzed once, before a note of it plays.
 *
 * Two passes and one record. Pass 1 (`analyzeOffline`) sweeps the decoded
 * audio, cuts it into sections and asks Jev what each one *feels* like; pass 2
 * takes the moments that sweep found and asks what each one *is*. The
 * difference matters: a mood cross-fades and a moment does not, and a
 * visualizer that only has moods is smooth and never lands anything.
 *
 * Everything that talks to the network is injected. `askJev` answers about a
 * passage, `askTransition` about a batch of up to four moments, and `deps.log`
 * is not a debugging aid — it is the transcript the scrolling JSON columns
 * read, so every request and every response is written down with the track
 * time it is about, in the order it was asked.
 *
 * **Progress.** The caller owns 0-40% for the download; this reports 0..1 over
 * what is left, mapped so that the sweep ends at 1/3 (40-60% of the caller's
 * bar), pass 1 at 3/4 (60-85%) and pass 2 at 1 (85-100%). It is monotone by
 * construction: each phase reports inside its own slice and the slices are in
 * order.
 *
 * The batching is the one piece of arithmetic here. Sixty moments is sixty
 * questions but not sixty round trips: four candidates ride in each request
 * (`t0`..`t3`), the answers come back split, and the batches go out
 * sequentially for the same reason pass 1's calls do — fifteen parallel
 * requests are fifteen chances to be rate limited, and nothing can start
 * before the last of them anyway. A batch that fails is asked once more two
 * seconds later, and a batch that fails twice is written off — those four
 * moments are missing from the track, the transcript says why, and the bar
 * still reaches 100%.
 */

import { analyzeOffline, type OfflineSample, type TransitionCandidate } from '../timeline/offlineAnalyzer';
import { CueTimeline } from '../timeline/timeline';
import { writeTransitionCues } from '../timeline/transitionWriter';
import { TRANSITION_BATCH } from '../mood/transitionQuestions';
import { NEUTRAL_MOOD } from '../shared/moodSchema';
import type {
  AnalysisLogEntry,
  AnalyzedTransition,
  FrameFeatures,
  MoodInput,
  MoodVector,
  TrackAnalysis,
  TransitionInput,
  TransitionVerdict,
} from '../shared/types';

/** Where the sweep ends and pass 1 ends, as fractions of this pass's own bar. */
const SWEEP_END = 1 / 3;
const PASS_ONE_END = 0.75;
/** Bars either side of a moment that the `before` and `after` pages describe. */
const WINDOW_BARS = 4;
/** The window the loudness jump across a moment is measured over. */
const JUMP_WINDOW_SEC = 1;
/** How far below the passage a frame has to be to count as part of a hole. */
const GAP_DEPTH_DB = 12;
/** The longest hole worth reporting; past this the number stops being useful. */
const MAX_GAP_SEC = 8;
/** A sane bar when the grid never locked. */
const FALLBACK_BAR_SEC = 2;
/** How long a failed batch waits before its one retry. */
const RETRY_DELAY_MS = 2000;

export interface TrackAnalysisDeps {
  /** One passage. Pass 1 calls this once per segment. */
  askJev: (input: MoodInput) => Promise<MoodVector>;
  /**
   * Up to four moments at once, answered in the order they were sent. A throw
   * is a batch that did not happen; see `RETRY_DELAY_MS`.
   */
  askTransition: (inputs: TransitionInput[]) => Promise<TransitionVerdict[]>;
  /** The wait before a retry. A test passes one that does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  title?: string;
  videoId?: string;
}

/**
 * Analyze `mono` end to end and hand back everything about it: the cues to
 * play, what Jev said, and the transcript of the asking.
 */
export async function analyzeTrack(
  mono: Float32Array,
  sampleRate: number,
  deps: TrackAnalysisDeps,
  onProgress?: (p: number) => void,
): Promise<TrackAnalysis> {
  const progress = monotone(onProgress);
  const durationSec = sampleRate > 0 ? mono.length / sampleRate : 0;
  const log: AnalysisLogEntry[] = [];

  // Pass 1. The sweep owns the first slice of the bar and the per-segment
  // calls the second; `analyzeOffline` reports both on one 0..1 scale of its
  // own, with the sweep ending at 0.8, so the two are pulled apart here.
  const offline = await analyzeOffline(mono, sampleRate, deps.askJev, (p) =>
    progress(passOneProgress(p)),
  );

  for (const segment of offline.segments) {
    log.push({ t: segment.start, dir: 'req', json: JSON.stringify(segment.input) });
    log.push({ t: segment.start, dir: 'res', json: JSON.stringify(segment.mood) });
  }

  // Pass 2. The timeline starts as everything the sweep wrote, and the
  // transition cues go on top of it at their own source, so a hole the
  // detector punched and a ramp the model asked for are two ramps rather than
  // one sequence of cues (see `CueTimeline.buildAt`).
  const tl = new CueTimeline();
  for (const cue of offline.timeline) tl.add(cue);

  const inputs = offline.candidates.map((c) =>
    buildTransitionInput(c, {
      samples: offline.samples,
      frames: offline.features,
      vocal: offline.vocal,
      harsh: offline.harsh,
      durationSec,
    }),
  );

  const transitions: AnalyzedTransition[] = [];
  const batches = Math.max(1, Math.ceil(inputs.length / TRANSITION_BATCH));
  for (let b = 0; b * TRANSITION_BATCH < inputs.length; b++) {
    const from = b * TRANSITION_BATCH;
    const batch = inputs.slice(from, from + TRANSITION_BATCH);
    const attempt = await askTwice(deps, batch);
    const verdicts = attempt.verdicts;

    batch.forEach((input, i) => {
      const candidate = offline.candidates[from + i]!;
      const verdict = verdicts[i];
      log.push({ t: candidate.t, dir: 'req', json: JSON.stringify(input) });
      if (verdict === undefined) return;
      log.push({ t: candidate.t, dir: 'res', json: JSON.stringify(verdict) });
      transitions.push({ at: candidate.t, input, verdict });

      writeTransitionCues(tl, candidate.t, verdict, {
        barSec: barSecAt(offline.samples, candidate.t),
        mood: moodAt(offline.segments, candidate.t),
        ...(candidate.detectorT === undefined ? {} : { detectorT: candidate.detectorT }),
        jumpDb: input.jumpDb,
        returnT: returnAfter(offline.candidates, candidate),
      });
    });
    // A batch nobody answered is four moments the track will not have, and the
    // transcript has to say so: the columns in Task 16 would otherwise show
    // four questions and no replies with no explanation of why.
    if (attempt.error !== undefined) {
      log.push({
        t: offline.candidates[from]!.t,
        dir: 'res',
        json: JSON.stringify({ error: attempt.error }),
      });
    }
    progress(PASS_ONE_END + ((1 - PASS_ONE_END) * (b + 1)) / batches);
  }

  progress(1);
  const analysis: TrackAnalysis = {
    title: deps.title ?? '',
    durationSec,
    segments: offline.segments.map((s) => ({ start: s.start, end: s.end, input: s.input, mood: s.mood })),
    transitions,
    cues: [...tl.cues()],
    log,
  };
  if (deps.videoId !== undefined) analysis.videoId = deps.videoId;
  return analysis;
}

/**
 * One batch, asked twice if it has to be.
 *
 * Most of what goes wrong with a batch goes wrong once: a rate limit, a
 * connection that dropped, a gateway that was restarting. Two seconds later it
 * usually works, and a batch is four moments of the track, so it is worth the
 * wait. What is not worth anything is a third try: a request that failed twice
 * two seconds apart is failing for a reason that is still there, and the other
 * twelve batches are still waiting. So the second failure gives up on *these*
 * four candidates and says why, and the sweep carries on to the next batch.
 */
async function askTwice(
  deps: TrackAnalysisDeps,
  batch: TransitionInput[],
): Promise<{ verdicts: TransitionVerdict[]; error?: string }> {
  try {
    return { verdicts: await deps.askTransition(batch) };
  } catch (first) {
    await (deps.sleep ?? sleep)(RETRY_DELAY_MS);
    try {
      return { verdicts: await deps.askTransition(batch) };
    } catch (second) {
      return { verdicts: [], error: message(second) };
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `analyzeOffline`'s own 0..1 on this pass's bar: sweep, then the calls. */
export function passOneProgress(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  // 0.8 is where `analyzeOffline` stops sweeping and starts calling.
  return q <= 0.8
    ? (q / 0.8) * SWEEP_END
    : SWEEP_END + ((q - 0.8) / 0.2) * (PASS_ONE_END - SWEEP_END);
}

export interface WindowSources {
  samples: readonly OfflineSample[];
  frames: readonly FrameFeatures[];
  vocal: ArrayLike<number>;
  harsh: ArrayLike<number>;
  durationSec: number;
}

/**
 * One candidate, as Jev is shown it.
 *
 * The two music pages are not rebuilt: they are the payloads the sweep
 * already took, the one nearest the middle of the four bars before the moment
 * and the one nearest the middle of the four bars after it. A payload
 * describes the seconds behind it, so those two are exactly "the music either
 * side", and building them again from the frames would be both slower and a
 * different measurement than the one pass 1 asked about.
 *
 * Everything else is about the seam itself and is measured from the frames,
 * because a seam is a thing that happens between two payloads.
 */
export function buildTransitionInput(
  candidate: TransitionCandidate,
  o: WindowSources,
): TransitionInput {
  const t = candidate.t;
  const bar = barSecAt(o.samples, t);
  const half = (WINDOW_BARS / 2) * bar;

  const before = nearestSample(o.samples, t - half);
  const after = nearestSample(o.samples, t + half);
  const blank = before ?? after;

  return {
    at: clock(t),
    before: before?.input ?? blank?.input ?? emptyInput(t, o.durationSec),
    after: after?.input ?? blank?.input ?? emptyInput(t, o.durationSec),
    jumpDb: round(jumpAcross(o.frames, t), 1),
    gapBeforeSec: round(gapBefore(o.frames, t), 2),
    bpmBefore: before?.input.bpm ?? 0,
    bpmAfter: after?.input.bpm ?? 0,
    keyChanged:
      before !== null && after !== null && before.tonic !== after.tonic && after.fit > 0.5,
    vocalDelta: round(meanAround(o.frames, o.vocal, t, half, 1) - meanAround(o.frames, o.vocal, t, half, -1), 2),
    harshDelta: round(meanAround(o.frames, o.harsh, t, half, 1) - meanAround(o.frames, o.harsh, t, half, -1), 2),
  };
}

/**
 * Loudness after the moment minus loudness before it, in dB, over a second
 * either side.
 *
 * A second rather than the four bars the pages cover: `jumpDb` is the size of
 * the *step*, and a four-bar mean either side of a drop would average the
 * build into the before and the whole first phrase into the after, which is a
 * different and much duller number.
 */
function jumpAcross(frames: readonly FrameFeatures[], t: number): number {
  const before = meanDb(frames, t - JUMP_WINDOW_SEC, t);
  const after = meanDb(frames, t, t + JUMP_WINDOW_SEC);
  if (before === null || after === null) return 0;
  return after - before;
}

/** How long the music had been near-silent when the moment arrived. */
function gapBefore(frames: readonly FrameFeatures[], t: number): number {
  const reference = meanDb(frames, t - 4, t);
  if (reference === null) return 0;
  const floor = reference - GAP_DEPTH_DB;

  let gap = 0;
  for (let i = indexAtOrBefore(frames, t); i >= 0; i--) {
    const f = frames[i]!;
    // The frame *at* the moment is the moment — on a silence-slam it is the
    // first frame of the slam, and counting it would report no hole at all.
    if (f.t >= t) continue;
    if (f.db > floor) break;
    gap = t - f.t;
    if (gap >= MAX_GAP_SEC) break;
  }
  return Math.min(gap, MAX_GAP_SEC);
}

/** Mean dB over `[from, to)`, or null when no frame falls in it. */
function meanDb(frames: readonly FrameFeatures[], from: number, to: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, indexAtOrBefore(frames, from)); i < frames.length; i++) {
    const f = frames[i]!;
    if (f.t < from) continue;
    if (f.t >= to) break;
    sum += f.db;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/** Mean of `series` over `span` seconds on one `side` of `t`. */
function meanAround(
  frames: readonly FrameFeatures[],
  series: ArrayLike<number>,
  t: number,
  span: number,
  side: 1 | -1,
): number {
  const from = side === 1 ? t : t - span;
  const to = side === 1 ? t + span : t;
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, indexAtOrBefore(frames, from)); i < frames.length; i++) {
    const f = frames[i]!;
    if (f.t < from) continue;
    if (f.t >= to) break;
    sum += series[i] ?? 0;
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

/** Index of the last frame at or before `t`, or 0. */
function indexAtOrBefore(frames: readonly FrameFeatures[], t: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

function nearestSample(samples: readonly OfflineSample[], t: number): OfflineSample | null {
  let best: OfflineSample | null = null;
  for (const s of samples) {
    if (best === null || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  }
  return best;
}

/** Seconds in a bar around `t`, from the sample taken nearest to it. */
export function barSecAt(samples: readonly OfflineSample[], t: number): number {
  const s = nearestSample(samples, t);
  return s !== null && s.barSec > 0 ? s.barSec : FALLBACK_BAR_SEC;
}

/** The mood pass 1 left in force at `t` — the segment it falls inside. */
export function moodAt(
  segments: ReadonlyArray<{ start: number; end: number; mood: MoodVector }>,
  t: number,
): MoodVector {
  let out: MoodVector | null = null;
  for (const s of segments) {
    if (s.start <= t) out = s.mood;
  }
  return out ?? NEUTRAL_MOOD;
}

/**
 * When the music comes back after a hole: the next candidate after this one,
 * if it is close enough to be the other side of the same event.
 */
function returnAfter(
  candidates: readonly TransitionCandidate[],
  candidate: TransitionCandidate,
): number | undefined {
  const i = candidates.indexOf(candidate);
  const next = candidates[i + 1];
  if (next === undefined || next.t - candidate.t > 4) return undefined;
  return next.detectorT ?? next.t;
}

/** `m:ss` — the moment, as the model is shown it. */
function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function round(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Number.isFinite(x) ? Math.round(x * f) / f + 0 : 0;
}

/** A page for a track with no payloads in it at all — a very short file. */
function emptyInput(t: number, durationSec: number): MoodInput {
  return {
    pos: `${clock(t)}/${clock(durationSec)}`,
    bpm: 0,
    tempo: 'moderato',
    beatConf: 0,
    meter: 'unclear',
    sync: 0,
    regular: 0,
    key: '?',
    mode: 'unclear',
    modeConf: 0,
    modal: 'unclear',
    consonance: 0,
    loud: 'pp',
    range: 0,
    trend: 'steady',
    crest: 0,
    bright: 0,
    noise: 0,
    attack: 'mixed',
    sub: 0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0],
    speech: 0,
    vocal: 0,
    harsh: 0,
    onsetsPerSec: 0,
    slope4: 0,
    slope8: 0,
    onsetRatio: 0,
    centroidSlope: 0,
    gap: false,
    barsSinceChange: 0,
    barInPhrase: 0,
  };
}

/** Progress, clamped and never going backwards. */
function monotone(onProgress: ((p: number) => void) | undefined): (p: number) => void {
  let last = -1;
  return (p: number): void => {
    if (onProgress === undefined) return;
    const next = Math.min(1, Math.max(0, p));
    if (next <= last) return;
    last = next;
    onProgress(next);
  };
}

/* ------------------------------------------------------- talking to the server */

/**
 * The two callbacks, wired to the local API.
 *
 * Built like `MoodClient`'s fetch path and for the same reason: the key lives
 * on the server, so the browser asks our own routes and never sees it.
 *
 * The two differ in what they do with a failure, because the caller does. A
 * passage nobody judged still has to have a mood, and a neutral one is the
 * honest answer, so `askJev` falls back. A batch of moments nobody judged is
 * worth asking about a second time, and only a throw tells `askTwice` that
 * there is anything to retry — so `askTransition` throws.
 */
export function httpDeps(
  o: { fetchFn?: typeof fetch; title?: string; videoId?: string } = {},
): TrackAnalysisDeps {
  const fetchFn = o.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const post = async (url: string, body: unknown): Promise<unknown> => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  };

  return {
    ...(o.title === undefined ? {} : { title: o.title }),
    ...(o.videoId === undefined ? {} : { videoId: o.videoId }),
    askJev: async (input) => {
      try {
        const json = await post('/api/mood', input);
        const mood = (json as { mood?: MoodVector } | null)?.mood;
        return mood ?? { ...NEUTRAL_MOOD };
      } catch {
        return { ...NEUTRAL_MOOD };
      }
    },
    askTransition: async (inputs) => {
      const json = await post('/api/transition', { transitions: inputs });
      const verdicts = (json as { verdicts?: TransitionVerdict[] } | null)?.verdicts;
      if (!Array.isArray(verdicts)) throw new Error('the transition call did not answer');
      return verdicts;
    },
  };
}

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

import { beatTrust } from '../analysis/speech';
import { analyzeOffline, type OfflineSample, type TransitionCandidate } from '../timeline/offlineAnalyzer';
import { CueTimeline } from '../timeline/timeline';
import { writeTransitionCues, type DetectorInstant } from '../timeline/transitionWriter';
import { TRANSITION_BATCH } from '../mood/transitionQuestions';
import { NEUTRAL_MOOD } from '../shared/moodSchema';
import type {
  AnalysisLogEntry,
  AnalyzedTransition,
  FrameFeatures,
  MoodInput,
  MoodVector,
  TrackAnalysis,
  TokenUsage,
  TransitionInput,
  TransitionKind,
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

/* ----------------------------------------- what a moment is *not* a drop for */

/**
 * How much of a beat there has to be after a moment for it to be drop-eligible,
 * and how sparse a passage has to be as well before it is called beatless.
 *
 * `beatConf` on its own cannot answer "is there a beat": a TED talk, a
 * Gymnopédie and an Eno pad all read 1.00 within a minute, because syllables,
 * rubato left hands and slow pads all give an autocorrelation *something*
 * periodic to find. What they do not give it is a rhythm anything lands on, so
 * the number used here is `beatTrust` — the confidence tempered by the
 * regularity — and even that is paired with a density floor, because a metal
 * band playing sixteenths reads low regularity too and a drop into a chorus is
 * still a drop. Beatless therefore means *both* "nothing trustworthy to count"
 * and "almost nothing happening", which is what a swell is and what a chorus
 * is not.
 */
const BEATLESS_TRUST = 0.3;
const BEATLESS_ONSETS_PER_SEC = 3;

/**
 * What a noise burst is: broadband, with nothing under it, and no beat worth
 * the name.
 *
 * Applause is the case this exists for, and all three clauses are needed to
 * name it. Measured on the talk, every candidate the ear hears as clapping or
 * laughter reads a flatness of 0.16-0.22 on the page after it against 0.00-0.11
 * everywhere the man is speaking: a room clapping is close to white noise and a
 * voice is not.
 *
 * Flatness alone is not enough, because the other thing that reads flat is
 * distortion — *Duality* has twenty-three candidates over 0.15 — and the
 * second clause is what tells a room from a guitar wall. A room is noisy and
 * *not abrasive*: it has no saturation, it is not especially bright and it
 * sits low in the track's own loudness range, so `harsh` reads 0.2-0.4 on the
 * talk's applause against 0.5-0.7 on every flat candidate in *Duality*. The
 * third clause is `beatTrust`, which is what says no record is playing at all.
 *
 * Read off the page after the moment rather than off the frames, deliberately:
 * these are the numbers the model is also shown, so a candidate the flag fires
 * on is one whose own page says why.
 */
const BURST_FLATNESS = 0.15;
const BURST_HARSH = 0.45;
const BURST_TRUST = 0.3;

/**
 * What a screamed climax needs before it is even offered as one.
 *
 * Harshness alone does not distinguish a throat from a machine. A supersaw
 * lead, a distorted synth and a hard-sidechained pad are all abrasive,
 * bright, flat and loud, and all of them step the harshness up at a seam —
 * which is the `scream_peak` signal list word for word. What none of them have
 * is a voice, and the voice detector is the one reading that says so. So the
 * two are required together: the harshness says *abrasive*, the vocal reading
 * says *a person*, and only a candidate with both is put on the table as
 * scream-eligible. Everything else that is merely loud and nasty is left to be
 * judged from the pages, where `drop` and `none` are both available.
 *
 * Read off the page after the moment, like `burst` and `beatless`, so a
 * candidate the gate closes on is one whose own page says why.
 */
const SCREAM_HARSH = 0.6;
const SCREAM_VOCAL = 0.4;

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
  /**
   * Running totals, mutated in place by whoever owns the two callbacks above.
   *
   * It is on the deps rather than returned by them because only the thing that
   * actually talks to the network sees a `usage` field, and the two callbacks
   * hand back a mood and a list of verdicts. `httpDeps` allocates one and adds
   * to it; a test that injects its own callbacks simply does not pass one, and
   * the record comes out without a cost attached.
   */
  usage?: TokenUsage;
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

  // What the detector stamped to the frame during the sweep. A verdict on a
  // candidate the summarizer found lands on one of these, not on the sample
  // time the summarizer's smoothing put it at — see `snapToDetector`.
  const slams: DetectorInstant[] = [];
  const holes: DetectorInstant[] = [];
  for (const c of offline.timeline) {
    if (c.source !== 'offline') continue;
    if (c.impact !== undefined) slams.push({ t: c.t, strength: c.impact });
    else if (c.build === 1) holes.push({ t: c.t, strength: 0 });
  }

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
        slams,
        holes,
      });
    });
    // A batch nobody answered is four moments the track will not have, and the
    // transcript has to say so: the scrolling columns would otherwise show
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
    ...(deps.usage === undefined ? {} : { usage: { ...deps.usage } }),
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
    burst: isBurst(after?.input ?? null),
    beatless: isBeatless(after?.input ?? null),
    eligible: eligibleKinds(after?.input ?? null),
  };
}

/**
 * The gated kinds this moment's measurements actually permit.
 *
 * One entry today. It is an array rather than a boolean because the gate is a
 * statement about the taxonomy — *these kinds are on the table* — and the next
 * kind that needs one should join the list rather than add a second flag with
 * a name nobody can guess the polarity of.
 */
function eligibleKinds(page: MoodInput | null): TransitionKind[] {
  if (page === null) return [];
  return page.harsh >= SCREAM_HARSH && page.vocal >= SCREAM_VOCAL ? ['scream_peak'] : [];
}

/**
 * Whether the music after `page` has no beat worth calling one.
 *
 * Both halves are needed; see `BEATLESS_TRUST`. A page that does not exist —
 * a moment past the end of the samples — is not evidence of anything and reads
 * false, because the flag's only job is to *remove* a candidate from
 * consideration as a drop and doing that on missing data would be a guess.
 */
function isBeatless(page: MoodInput | null): boolean {
  if (page === null) return false;
  return (
    beatTrust(page.beatConf, page.regular) < BEATLESS_TRUST &&
    page.onsetsPerSec < BEATLESS_ONSETS_PER_SEC
  );
}

/** Whether what follows the moment is a noise burst rather than music. */
function isBurst(page: MoodInput | null): boolean {
  if (page === null) return false;
  return (
    page.noise >= BURST_FLATNESS &&
    page.harsh <= BURST_HARSH &&
    beatTrust(page.beatConf, page.regular) < BURST_TRUST
  );
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
    pause: 0,
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
 * The key lives on the server, so the browser asks our own routes and never
 * sees it — which is why these are `fetch` calls to `/api/...` rather than an
 * SDK client, and why the SDK is not in the client bundle at all.
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
  // One object for the whole analysis, added to as the answers come back and
  // copied into the record at the end. See `TrackAnalysisDeps.usage`.
  const usage: TokenUsage = { calls: 0, input_tokens: 0, output_tokens: 0, lastLatencyMs: 0 };

  const post = async (url: string, body: unknown): Promise<unknown> => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    // Both routes answer with the same shape of accounting. A response that
    // carries none is still a call, which is the number the HUD divides by.
    const u = (json as { usage?: { input_tokens?: number; output_tokens?: number } } | null)?.usage;
    const ms = (json as { latencyMs?: number } | null)?.latencyMs;
    usage.calls += 1;
    usage.input_tokens += Number(u?.input_tokens) || 0;
    usage.output_tokens += Number(u?.output_tokens) || 0;
    if (Number.isFinite(ms)) usage.lastLatencyMs = ms as number;
    return json;
  };

  return {
    usage,
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

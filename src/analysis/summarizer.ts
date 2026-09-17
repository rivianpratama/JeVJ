/**
 * Everything the analysis knows, written down as the one page Jev is asked
 * about — plus the two questions the app asks of that page: how much has
 * changed since last time, and has the music turned a corner.
 *
 * The payload is small on purpose. It is sent several times a minute, and the
 * budget it has to stay inside (160 tokens) is a hard constraint of the plan,
 * so every field is rounded to the precision that still means something: two
 * decimals on a 0..1 score, one on a slope in dB, integers on counts, and the
 * eight bands as single digits. Rounding is not cosmetic here — it is how the
 * payload fits, and it is what keeps a value that drifted in the last decimal
 * place from reading as news.
 *
 * Two ways in, one way through. `snapshot` pulls the readings off the trackers
 * itself; `fromSnapshot` takes readings somebody else already gathered — the
 * analysis loop builds all of them every frame, and asking the trackers again
 * would both duplicate the work and risk a payload assembled from two
 * different instants. Both call the same builder.
 *
 * Pure: no clock, no network, no DOM.
 */

import type { BeatGrid, GridState } from './grid';
import type { DynamicsTracker } from './dynamics';
import type { KeyTracker, KeyEstimate } from './key';
import type { RhythmTracker } from './rhythm';
import type { SpeechDetector } from './speech';
import type { TimbreTracker } from './timbre';
import { consonance } from './timbre';
import type { VocalDetector } from './vocal';
import { harshness } from './vocal';
import { tempoMarking, type TempoEstimate } from './tempo';
import type {
  Attack,
  DynClass,
  FrameFeatures,
  Meter,
  MoodInput,
  Trend,
} from '../shared/types';

/** Schema bounds, repeated here because this is what has to land inside them. */
const MAX_BPM = 300;
const MAX_SLOPE_DB = 60;
const MAX_ONSET_RATE = 20;
const MAX_BARS_SINCE_CHANGE = 999;
const MAX_BAR_IN_PHRASE = 31;
const BAND_LEVELS = 9;

/** A pitch class the schema will accept, or the "no key" mark. */
const KEY_RE = /^([A-G][#b]?|\?)$/;
/** `m:ss/m:ss` or `m:ss/live`, as the schema spells it. */
const POS_RE = /^\d+:\d{2}\/(\d+:\d{2}|live)$/;

/** How far a bar's level has to move for the level rule to call a boundary. */
const SECTION_SLOPE_DB = 6;
/** How far the onset density has to move for the density rule to call one. */
const SECTION_BUSY_RATIO = 1.8;
const SECTION_SPARSE_RATIO = 0.55;
/** How sure of the mode we have to be before a new key name means anything. */
const SECTION_MODE_CONF = 0.4;

/** The dynamic classes in order, so `loud` can be a number in the distance. */
const LOUD_ORDER: readonly DynClass[] = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

/**
 * Everything a `MoodInput` is built from, in the shape the analysis loop's
 * snapshot already has.
 *
 * Structural on purpose: `AnalysisSnapshot` satisfies this without knowing it
 * exists, so `src/analysis` never has to import anything from `src/app` — not
 * even a type. Whatever else the snapshot grows, it stays assignable here.
 */
export interface MoodReadings {
  features: { bands: ArrayLike<number> };
  grid: GridState;
  /** null before the first tempo has been measured. */
  tempo: TempoEstimate | null;
  key: KeyEstimate;
  rhythm: { sync: number; regular: number; meter: Meter; onsetsPerSec: number; onsetRatio: number };
  dynamics: {
    loud: DynClass;
    range: number;
    trend: Trend;
    crest: number;
    slope4: number;
    slope8: number;
    gap: boolean;
  };
  timbre: {
    consonance: number;
    bright: number;
    noise: number;
    attack: Attack;
    sub: number;
    centroidSlope: number;
  };
  speech: number;
  /** 0..1 how much of a singing voice is present. */
  vocal: number;
  /** 0..1 how abrasive the sound is. */
  harsh: number;
}

/**
 * The trackers, as the methods the summary reads.
 *
 * `Pick` rather than the classes themselves: the real trackers satisfy these,
 * and so does a stub, which is the only way to hold the formatting up against
 * a fixed set of readings. `frame` is here because two fields — the band
 * levels and the consonance of the current chroma — come off the frame itself
 * rather than off any tracker.
 */
export interface SummarizerDeps {
  grid: Pick<BeatGrid, 'state'>;
  key: Pick<KeyTracker, 'estimate'>;
  rhythm: Pick<RhythmTracker, 'syncopation' | 'regularity' | 'meter' | 'onsetsPerSec' | 'onsetRatio'>;
  dyn: Pick<DynamicsTracker, 'loudClass' | 'range' | 'trend' | 'crest' | 'slopeDb' | 'gap' | 'position'>;
  timbre: Pick<TimbreTracker, 'brightness' | 'noisiness' | 'attack' | 'subWeight' | 'centroidSlope'>;
  speech: Pick<SpeechDetector, 'score'>;
  vocal: Pick<VocalDetector, 'score'>;
  tempo: () => TempoEstimate | null;
  frame: () => FrameFeatures;
}

export class Summarizer {
  constructor(private readonly d: SummarizerDeps) {}

  /** Read every tracker at `now` and write the page. */
  snapshot(now: number, positionSec: number, durationSec: number | null): MoodInput {
    const { grid, key, rhythm, dyn, timbre, speech, vocal } = this.d;
    const state = grid.state();
    const barSec = state.period * state.barLength;
    const frame = this.d.frame();
    const attack = timbre.attack();

    return Summarizer.fromSnapshot(
      {
        features: frame,
        grid: state,
        tempo: this.d.tempo(),
        key: key.estimate(),
        rhythm: {
          sync: rhythm.syncopation(),
          regular: rhythm.regularity(),
          meter: rhythm.meter(),
          onsetsPerSec: rhythm.onsetsPerSec(now),
          onsetRatio: rhythm.onsetRatio(now, barSec),
        },
        dynamics: {
          loud: dyn.loudClass(),
          range: dyn.range(),
          trend: dyn.trend(),
          crest: dyn.crest(),
          slope4: dyn.slopeDb(4, barSec, now),
          slope8: dyn.slopeDb(8, barSec, now),
          gap: dyn.gap(now, state.period),
        },
        timbre: {
          consonance: consonance(frame.chroma),
          bright: timbre.brightness(),
          noise: timbre.noisiness(),
          attack,
          sub: timbre.subWeight(),
          centroidSlope: timbre.centroidSlope(),
        },
        // The beat as well as how sure of it we are: a pulse train's harmonics
        // sit in the syllabic band, and the detector can only take them out of
        // the measurement if it is told where they are. Same call as
        // `AnalysisPipeline.step` — see `pipeline.ts`.
        speech: speech.score(state.confidence, state.period > 0 ? 1 / state.period : 0),
        vocal: vocal.score(),
        harsh: harshness({
          bright: timbre.brightness(),
          flatness: timbre.noisiness(),
          loudRel: dyn.position(),
          attack,
        }),
      },
      positionSec,
      durationSec,
    );
  }

  /** The same page, from readings somebody else already gathered. */
  static fromSnapshot(r: MoodReadings, positionSec: number, durationSec: number | null): MoodInput {
    const bpm = clamp(r.grid.bpm, 0, MAX_BPM);
    return normalize({
      pos: formatPos(positionSec, durationSec),
      bpm,
      tempo: r.tempo?.marking ?? tempoMarking(bpm),
      beatConf: r.grid.confidence,
      meter: r.rhythm.meter,
      sync: r.rhythm.sync,
      regular: r.rhythm.regular,
      key: r.key.key,
      mode: r.key.mode,
      modeConf: r.key.modeConf,
      modal: r.key.modal,
      consonance: r.timbre.consonance,
      loud: r.dynamics.loud,
      range: r.dynamics.range,
      trend: r.dynamics.trend,
      crest: r.dynamics.crest,
      bright: r.timbre.bright,
      noise: r.timbre.noise,
      attack: r.timbre.attack,
      sub: r.timbre.sub,
      bands: bandDigits(r.features.bands),
      speech: r.speech,
      vocal: r.vocal,
      harsh: r.harsh,
      onsetsPerSec: r.rhythm.onsetsPerSec,
      slope4: r.dynamics.slope4,
      slope8: r.dynamics.slope8,
      onsetRatio: r.rhythm.onsetRatio,
      centroidSlope: r.timbre.centroidSlope,
      gap: r.dynamics.gap,
      barsSinceChange: r.grid.barsSinceChange,
      barInPhrase: r.grid.barInPhrase,
    });
  }

  /**
   * 0..1: how far apart two payloads are, over a fixed vector of the numeric
   * fields, each scaled to roughly 0..1 first.
   *
   * Mean absolute difference, doubled — half the vector moving all the way is
   * already a different piece of music — and clamped. Each term is clamped on
   * its own too, so a 120 dB swing in one slope cannot outvote everything else
   * by itself.
   */
  static novelty(a: MoodInput, b: MoodInput): number {
    const x = vector(a);
    const y = vector(b);
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += clamp(Math.abs((x[i] ?? 0) - (y[i] ?? 0)), 0, 1);
    return clamp((sum / x.length) * 2, 0, 1);
  }

  /**
   * Whether the music has likely turned a corner between `prev` and `cur`.
   *
   * `prev` is the last payload we compared against — a few seconds back, which
   * is what "vs 4 s ago" means in practice. Every rule is an *edge*: a level
   * that is still steep, or a bar that is still sparse, is the same section it
   * was a moment ago, and re-reporting it would restart the phrase count on
   * every frame of a breakdown. With nothing to compare against there is no
   * edge, so the first payload is never a boundary.
   */
  static sectionChanged(prev: MoodInput | null, cur: MoodInput): boolean {
    if (prev === null) return false;

    const flipped = trendSign(prev.trend) * trendSign(cur.trend) < 0;
    const steep = Math.abs(cur.slope4) >= SECTION_SLOPE_DB && Math.abs(prev.slope4) < SECTION_SLOPE_DB;
    const density = outsideDensity(cur.onsetRatio) && !outsideDensity(prev.onsetRatio);
    const modulated =
      cur.modeConf > SECTION_MODE_CONF && cur.key !== prev.key && cur.key !== '?' && prev.key !== '?';

    return flipped || steep || density || modulated;
  }

  /** The instance form the plan names; the rule needs no state of its own. */
  sectionChanged(prev: MoodInput | null, cur: MoodInput): boolean {
    return Summarizer.sectionChanged(prev, cur);
  }

  /**
   * The payload as the compact JSON that goes on the wire. Rounds and clamps
   * on the way out, so a hand-built or hand-edited input still serializes to
   * something `validateMoodInput` accepts.
   */
  static serialize(m: MoodInput): string {
    return JSON.stringify(normalize(m));
  }
}

/** `m:ss/m:ss`, or `m:ss/live` when the length is unknown. */
function formatPos(positionSec: number, durationSec: number | null): string {
  const length =
    durationSec !== null && Number.isFinite(durationSec) && durationSec > 0
      ? clock(durationSec)
      : 'live';
  return `${clock(positionSec)}/${length}`;
}

function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The eight 0..1 band levels as single digits 0..9. */
function bandDigits(bands: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Math.round(clamp(bands[i] ?? 0, 0, 1) * BAND_LEVELS));
  return out;
}

/** Eight digits, whatever arrived: already-built payloads come through here. */
function bandInts(bands: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Math.round(clamp(bands[i] ?? 0, 0, BAND_LEVELS)));
  return out;
}

/**
 * Every numeric field rounded and clamped into the schema's range. Idempotent,
 * so running it on an already-built payload changes nothing.
 */
function normalize(m: MoodInput): MoodInput {
  return {
    // Built payloads always carry a well-formed position; a hand-made one may
    // not, and `serialize` promises output the schema accepts.
    pos: POS_RE.test(m.pos) ? m.pos : '0:00/live',
    bpm: Math.round(clamp(m.bpm, 0, MAX_BPM)),
    tempo: m.tempo,
    beatConf: unit(m.beatConf),
    meter: m.meter,
    sync: unit(m.sync),
    regular: unit(m.regular),
    key: KEY_RE.test(m.key) ? m.key : '?',
    mode: m.mode,
    modeConf: unit(m.modeConf),
    modal: m.modal,
    consonance: unit(m.consonance),
    loud: m.loud,
    range: unit(m.range),
    trend: m.trend,
    crest: unit(m.crest),
    bright: unit(m.bright),
    noise: unit(m.noise),
    attack: m.attack,
    sub: unit(m.sub),
    bands: bandInts(m.bands),
    speech: unit(m.speech),
    // Tenths, not hundredths, and the only two fields rounded that coarsely.
    // The payload is two characters over its 160-token ceiling with them at
    // two decimals, and the second decimal of a detector score that is only
    // ever read as "is there a voice" or "is this abrasive" is not a decimal
    // anyone acts on — the candidate rules cross at 0.5 and 0.6, and they
    // cross on the unrounded frame values, not on this page.
    vocal: tenths(m.vocal, 0, 1),
    harsh: tenths(m.harsh, 0, 1),
    onsetsPerSec: tenths(m.onsetsPerSec, 0, MAX_ONSET_RATE),
    slope4: tenths(m.slope4, -MAX_SLOPE_DB, MAX_SLOPE_DB),
    slope8: tenths(m.slope8, -MAX_SLOPE_DB, MAX_SLOPE_DB),
    onsetRatio: tenths(m.onsetRatio, 0, MAX_ONSET_RATE),
    centroidSlope: hundredths(m.centroidSlope, -1, 1),
    gap: m.gap,
    barsSinceChange: Math.round(clamp(m.barsSinceChange, 0, MAX_BARS_SINCE_CHANGE)),
    barInPhrase: Math.round(clamp(m.barInPhrase, 0, MAX_BAR_IN_PHRASE)),
  };
}

/** A 0..1 score at two decimals — as fine as anything downstream can use. */
function unit(x: number): number {
  return hundredths(x, 0, 1);
}

/**
 * `+ 0` on the way out: a value a hair below zero rounds to `-0`, which reads
 * as `-0` everywhere a payload is compared or printed, and is not a reading
 * anything measured.
 */
function hundredths(x: number, lo: number, hi: number): number {
  return Math.round(clamp(x, lo, hi) * 100) / 100 + 0;
}

function tenths(x: number, lo: number, hi: number): number {
  return Math.round(clamp(x, lo, hi) * 10) / 10 + 0;
}

/** NaN reads as the bottom of the range: an unmeasured field, not a loud one. */
function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo < 0 && hi > 0 ? 0 : lo;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * The comparable part of a payload: every numeric field scaled so that one
 * unit of difference means about as much in each.
 */
function vector(m: MoodInput): number[] {
  return [
    m.bpm / 200,
    m.beatConf,
    m.sync,
    m.regular,
    m.modeConf,
    m.consonance,
    m.range,
    m.bright,
    m.noise,
    m.sub,
    m.speech,
    // A voice arriving and a passage turning abrasive are both changes a
    // listener would name, so both are worth a segment boundary.
    m.vocal,
    m.harsh,
    ...m.bands.map((b) => b / BAND_LEVELS),
    m.slope8 / 30,
    m.onsetRatio / 4,
    m.centroidSlope,
    Math.max(0, LOUD_ORDER.indexOf(m.loud)) / (LOUD_ORDER.length - 1),
    // ±0.5, not ±1: every other term spans one unit, so building→fading has to
    // span one too. At ±1 the flip would be worth 2 and the per-term clamp
    // would quietly cut it back to 1 — the same number, but by accident.
    trendSign(m.trend) / 2,
  ];
}

function trendSign(t: Trend): number {
  return t === 'building' ? 1 : t === 'fading' ? -1 : 0;
}

function outsideDensity(ratio: number): boolean {
  return ratio >= SECTION_BUSY_RATIO || ratio <= SECTION_SPARSE_RATIO;
}

import {
  BEATS_TO_CHANGE,
  CUE_SOURCES,
  GENRES,
  MOTIONS,
  PRE_DROP_STYLES,
  SECTIONS,
  TRANSITION_KINDS,
  type AnalysisLogEntry,
  type AnalyzedSegment,
  type AnalyzedTransition,
  type Attack,
  type Cue,
  type DynClass,
  type Genre,
  type Meter,
  type Mode,
  type ModalFlavor,
  type MoodInput,
  type MoodVector,
  type Motion,
  type Section,
  type TempoMarking,
  type TrackAnalysis,
  type TransitionInput,
  type TransitionVerdict,
  type Trend,
} from './types';

type Valid<T> = { ok: true; value: T };
type Invalid = { ok: false; error: string };

const TEMPOS = [
  'largo',
  'adagio',
  'andante',
  'moderato',
  'allegro',
  'vivace',
  'presto',
] as const satisfies readonly TempoMarking[];
const METERS = ['duple', 'triple', 'unclear'] as const satisfies readonly Meter[];
const MODES = ['major', 'minor', 'unclear'] as const satisfies readonly Mode[];
const MODAL_FLAVORS = [
  'ionian',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'aeolian',
  'locrian',
  'unclear',
] as const satisfies readonly ModalFlavor[];
const DYN_CLASSES = ['pp', 'p', 'mp', 'mf', 'f', 'ff'] as const satisfies readonly DynClass[];
const TRENDS = ['building', 'fading', 'steady'] as const satisfies readonly Trend[];
const ATTACKS = ['sharp', 'soft', 'mixed'] as const satisfies readonly Attack[];

/** `m:ss/m:ss` for a file, `m:ss/live` for a stream of unknown length. */
const POS_RE = /^\d+:\d{2}\/(\d+:\d{2}|live)$/;
const KEY_RE = /^([A-G][#b]?|\?)$/;

/** MoodInput fields that carry a plain 0..1 score. */
const INPUT_UNIT_FIELDS = [
  'beatConf',
  'sync',
  'regular',
  'modeConf',
  'consonance',
  'range',
  'crest',
  'bright',
  'noise',
  'sub',
  'speech',
  'pause',
  'vocal',
  'harsh',
] as const;

/** MoodVector fields that carry a plain 0..1 score. */
const VECTOR_UNIT_FIELDS = [
  'valence',
  'arousal',
  'tension',
  'warmth',
  'synthetic',
  'space',
  'aggression',
  'melancholy',
  'hypnotic',
  'euphoricPeak',
  'spoken',
  'dropImminent',
  'impact',
  'confidence',
] as const;

function num(x: unknown, lo: number, hi: number): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
}

function oneOf<T extends string>(x: unknown, list: readonly T[]): x is T {
  return typeof x === 'string' && (list as readonly string[]).includes(x);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function bad(field: string, expected: string): Invalid {
  return { ok: false, error: `${field}: expected ${expected}` };
}

/** First field of `o` that is not a finite number in 0..1, or null. */
function firstBadUnit(o: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const f of fields) if (!num(o[f], 0, 1)) return f;
  return null;
}

/**
 * A probability map must carry every member of `keys` as a 0..1 number.
 * Returns why it does not, or null when it is well formed.
 */
function distError(o: unknown, keys: readonly string[]): string | null {
  if (!isRecord(o)) return 'an object';
  for (const k of keys) {
    if (!num(o[k], 0, 1)) return `a 0..1 number for every member (bad or missing: "${k}")`;
  }
  return null;
}

function pickDist<K extends string>(o: Record<string, unknown>, keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = o[k] as number;
  return out;
}

export function validateMoodInput(x: unknown): Valid<MoodInput> | Invalid {
  if (!isRecord(x)) return bad('moodInput', 'an object');

  if (typeof x['pos'] !== 'string' || !POS_RE.test(x['pos'])) return bad('pos', '"m:ss/m:ss" or "m:ss/live"');
  if (typeof x['key'] !== 'string' || !KEY_RE.test(x['key'])) return bad('key', 'a pitch class A-G with optional #/b, or "?"');

  if (!num(x['bpm'], 0, 300)) return bad('bpm', 'a finite number in 0..300');
  if (!num(x['slope4'], -60, 60)) return bad('slope4', 'a finite number in -60..60');
  if (!num(x['slope8'], -60, 60)) return bad('slope8', 'a finite number in -60..60');
  if (!num(x['onsetRatio'], 0, 20)) return bad('onsetRatio', 'a finite number in 0..20');
  // An absolute onset rate, not a 0..1 score: the reference payload in the plan
  // carries 4.2. Clamped like onsetRatio, which is well above any real density.
  if (!num(x['onsetsPerSec'], 0, 20)) return bad('onsetsPerSec', 'a finite number in 0..20');
  if (!num(x['centroidSlope'], -1, 1)) return bad('centroidSlope', 'a finite number in -1..1');
  if (!num(x['barsSinceChange'], 0, 999)) return bad('barsSinceChange', 'a finite number in 0..999');
  if (!num(x['barInPhrase'], 0, 31)) return bad('barInPhrase', 'a finite number in 0..31');

  const badUnit = firstBadUnit(x, INPUT_UNIT_FIELDS);
  if (badUnit) return bad(badUnit, 'a finite number in 0..1');

  if (!oneOf(x['tempo'], TEMPOS)) return bad('tempo', `one of ${TEMPOS.join(', ')}`);
  if (!oneOf(x['meter'], METERS)) return bad('meter', `one of ${METERS.join(', ')}`);
  if (!oneOf(x['mode'], MODES)) return bad('mode', `one of ${MODES.join(', ')}`);
  if (!oneOf(x['modal'], MODAL_FLAVORS)) return bad('modal', `one of ${MODAL_FLAVORS.join(', ')}`);
  if (!oneOf(x['loud'], DYN_CLASSES)) return bad('loud', `one of ${DYN_CLASSES.join(', ')}`);
  if (!oneOf(x['trend'], TRENDS)) return bad('trend', `one of ${TRENDS.join(', ')}`);
  if (!oneOf(x['attack'], ATTACKS)) return bad('attack', `one of ${ATTACKS.join(', ')}`);

  const bands = x['bands'];
  if (!Array.isArray(bands) || bands.length !== 8) return bad('bands', 'an array of 8 integers 0..9');
  for (const b of bands) {
    if (!num(b, 0, 9) || !Number.isInteger(b)) return bad('bands', 'an array of 8 integers 0..9');
  }

  if (typeof x['gap'] !== 'boolean') return bad('gap', 'a boolean');

  // Every field above is checked, so the shape holds; copy it so that unknown
  // extra keys never reach the model prompt.
  const v = x as unknown as MoodInput;
  return {
    ok: true,
    value: {
      pos: v.pos,
      bpm: v.bpm,
      tempo: v.tempo,
      beatConf: v.beatConf,
      meter: v.meter,
      sync: v.sync,
      regular: v.regular,
      key: v.key,
      mode: v.mode,
      modeConf: v.modeConf,
      modal: v.modal,
      consonance: v.consonance,
      loud: v.loud,
      range: v.range,
      trend: v.trend,
      crest: v.crest,
      bright: v.bright,
      noise: v.noise,
      attack: v.attack,
      sub: v.sub,
      bands: [...v.bands],
      speech: v.speech,
      pause: v.pause,
      vocal: v.vocal,
      harsh: v.harsh,
      onsetsPerSec: v.onsetsPerSec,
      slope4: v.slope4,
      slope8: v.slope8,
      onsetRatio: v.onsetRatio,
      centroidSlope: v.centroidSlope,
      gap: v.gap,
      barsSinceChange: v.barsSinceChange,
      barInPhrase: v.barInPhrase,
    },
  };
}

export function validateMoodVector(x: unknown): Valid<MoodVector> | Invalid {
  if (!isRecord(x)) return bad('moodVector', 'an object');

  const badUnit = firstBadUnit(x, VECTOR_UNIT_FIELDS);
  if (badUnit) return bad(badUnit, 'a finite number in 0..1');

  if (!oneOf(x['genre'], GENRES)) return bad('genre', `one of ${GENRES.join(', ')}`);
  if (!oneOf(x['section'], SECTIONS)) return bad('section', `one of ${SECTIONS.join(', ')}`);
  if (!oneOf(x['motion'], MOTIONS)) return bad('motion', `one of ${MOTIONS.join(', ')}`);
  if (!oneOf(x['beatsToChange'], BEATS_TO_CHANGE)) return bad('beatsToChange', `one of ${BEATS_TO_CHANGE.join(', ')}`);
  if (!oneOf(x['preDropStyle'], PRE_DROP_STYLES)) return bad('preDropStyle', `one of ${PRE_DROP_STYLES.join(', ')}`);

  const genrePErr = distError(x['genreP'], GENRES);
  if (genrePErr) return bad('genreP', genrePErr);
  const sectionPErr = distError(x['sectionP'], SECTIONS);
  if (sectionPErr) return bad('sectionP', sectionPErr);
  const motionPErr = distError(x['motionP'], MOTIONS);
  if (motionPErr) return bad('motionP', motionPErr);

  const v = x as unknown as MoodVector;
  return {
    ok: true,
    value: {
      valence: v.valence,
      arousal: v.arousal,
      tension: v.tension,
      warmth: v.warmth,
      synthetic: v.synthetic,
      space: v.space,
      aggression: v.aggression,
      melancholy: v.melancholy,
      hypnotic: v.hypnotic,
      euphoricPeak: v.euphoricPeak,
      spoken: v.spoken,
      genre: v.genre,
      genreP: pickDist(x['genreP'] as Record<string, unknown>, GENRES),
      section: v.section,
      sectionP: pickDist(x['sectionP'] as Record<string, unknown>, SECTIONS),
      motion: v.motion,
      motionP: pickDist(x['motionP'] as Record<string, unknown>, MOTIONS),
      dropImminent: v.dropImminent,
      beatsToChange: v.beatsToChange,
      impact: v.impact,
      preDropStyle: v.preDropStyle,
      confidence: v.confidence,
    },
  };
}

/** `m:ss` — where a transition happens, without the track length after it. */
const AT_RE = /^\d+:\d{2}$/;
/** The widest loudness jump worth stating; past this the number is noise. */
const MAX_JUMP_DB = 120;
/** A hole longer than this is a track boundary, not a break. */
const MAX_GAP_SEC = 60;

export function validateTransitionInput(x: unknown): Valid<TransitionInput> | Invalid {
  if (!isRecord(x)) return bad('transition', 'an object');
  if (typeof x['at'] !== 'string' || !AT_RE.test(x['at'])) return bad('at', '"m:ss"');

  const before = validateMoodInput(x['before']);
  if (!before.ok) return bad('before', before.error);
  const after = validateMoodInput(x['after']);
  if (!after.ok) return bad('after', after.error);

  if (!num(x['jumpDb'], -MAX_JUMP_DB, MAX_JUMP_DB)) return bad('jumpDb', `a finite number in ±${MAX_JUMP_DB}`);
  if (!num(x['gapBeforeSec'], 0, MAX_GAP_SEC)) return bad('gapBeforeSec', `a finite number in 0..${MAX_GAP_SEC}`);
  if (!num(x['bpmBefore'], 0, 300)) return bad('bpmBefore', 'a finite number in 0..300');
  if (!num(x['bpmAfter'], 0, 300)) return bad('bpmAfter', 'a finite number in 0..300');
  if (typeof x['keyChanged'] !== 'boolean') return bad('keyChanged', 'a boolean');
  if (!num(x['vocalDelta'], -1, 1)) return bad('vocalDelta', 'a finite number in -1..1');
  if (!num(x['harshDelta'], -1, 1)) return bad('harshDelta', 'a finite number in -1..1');
  if (typeof x['burst'] !== 'boolean') return bad('burst', 'a boolean');
  if (typeof x['beatless'] !== 'boolean') return bad('beatless', 'a boolean');

  const v = x as unknown as TransitionInput;
  return {
    ok: true,
    value: {
      at: v.at,
      before: before.value,
      after: after.value,
      jumpDb: v.jumpDb,
      gapBeforeSec: v.gapBeforeSec,
      bpmBefore: v.bpmBefore,
      bpmAfter: v.bpmAfter,
      keyChanged: v.keyChanged,
      vocalDelta: v.vocalDelta,
      harshDelta: v.harshDelta,
      burst: v.burst,
      beatless: v.beatless,
    },
  };
}

export function validateTransitionVerdict(x: unknown): Valid<TransitionVerdict> | Invalid {
  if (!isRecord(x)) return bad('verdict', 'an object');
  const badUnit = firstBadUnit(x, ['intensity', 'dramatic', 'release', 'confidence']);
  if (badUnit) return bad(badUnit, 'a finite number in 0..1');
  if (!oneOf(x['kind'], TRANSITION_KINDS)) return bad('kind', `one of ${TRANSITION_KINDS.join(', ')}`);
  const kindPErr = distError(x['kindP'], TRANSITION_KINDS);
  if (kindPErr) return bad('kindP', kindPErr);

  const v = x as unknown as TransitionVerdict;
  return {
    ok: true,
    value: {
      kind: v.kind,
      kindP: pickDist(x['kindP'] as Record<string, unknown>, TRANSITION_KINDS),
      intensity: v.intensity,
      dramatic: v.dramatic,
      release: v.release,
      confidence: v.confidence,
    },
  };
}

/**
 * A whole analysis record, as it arrives from a cache file or a POST.
 *
 * Deliberately shallower than the two validators above. Every segment and
 * every transition in here was built by our own pass and checked on the way
 * in; what this guards against is a *truncated or corrupt file*, not a hostile
 * payload field by field — so it insists on the shape, the times and the
 * kinds, and copies the rest. Anything it rejects is a cache entry we throw
 * away and rebuild, which costs one re-analysis and never a wrong picture.
 */
export function validateTrackAnalysis(x: unknown): Valid<TrackAnalysis> | Invalid {
  if (!isRecord(x)) return bad('analysis', 'an object');
  if (typeof x['title'] !== 'string') return bad('title', 'a string');
  if (!num(x['durationSec'], 0, 24 * 3600)) return bad('durationSec', 'a finite number of seconds');
  if (x['videoId'] !== undefined && typeof x['videoId'] !== 'string') return bad('videoId', 'a string');

  const segments: AnalyzedSegment[] = [];
  if (!Array.isArray(x['segments'])) return bad('segments', 'an array');
  for (const raw of x['segments']) {
    if (!isRecord(raw)) return bad('segments', 'an array of objects');
    const input = validateMoodInput(raw['input']);
    const mood = validateMoodVector(raw['mood']);
    if (!input.ok) return bad('segments[].input', input.error);
    if (!mood.ok) return bad('segments[].mood', mood.error);
    if (!num(raw['start'], 0, Infinity) || !num(raw['end'], 0, Infinity)) {
      return bad('segments[]', 'a start and end in seconds');
    }
    segments.push({ start: raw['start'], end: raw['end'], input: input.value, mood: mood.value });
  }

  const transitions: AnalyzedTransition[] = [];
  if (!Array.isArray(x['transitions'])) return bad('transitions', 'an array');
  for (const raw of x['transitions']) {
    if (!isRecord(raw)) return bad('transitions', 'an array of objects');
    if (!num(raw['at'], 0, Infinity)) return bad('transitions[].at', 'a time in seconds');
    const input = validateTransitionInput(raw['input']);
    const verdict = validateTransitionVerdict(raw['verdict']);
    if (!input.ok) return bad('transitions[].input', input.error);
    if (!verdict.ok) return bad('transitions[].verdict', verdict.error);
    transitions.push({ at: raw['at'], input: input.value, verdict: verdict.value });
  }

  if (!Array.isArray(x['cues'])) return bad('cues', 'an array');
  const cues: Cue[] = [];
  for (const raw of x['cues']) {
    if (!isRecord(raw) || !num(raw['t'], -Infinity, Infinity)) return bad('cues[]', 'a cue with a time');
    if (!oneOf(raw['source'], CUE_SOURCES)) return bad('cues[].source', `one of ${CUE_SOURCES.join(', ')}`);
    cues.push(raw as unknown as Cue);
  }

  if (!Array.isArray(x['log'])) return bad('log', 'an array');
  const log: AnalysisLogEntry[] = [];
  for (const raw of x['log']) {
    if (!isRecord(raw) || !num(raw['t'], -Infinity, Infinity)) return bad('log[]', 'an entry with a time');
    if (raw['dir'] !== 'req' && raw['dir'] !== 'res') return bad('log[].dir', '"req" or "res"');
    if (typeof raw['json'] !== 'string') return bad('log[].json', 'a string');
    log.push({ t: raw['t'], dir: raw['dir'], json: raw['json'] });
  }

  const out: TrackAnalysis = {
    title: x['title'],
    durationSec: x['durationSec'],
    segments,
    transitions,
    cues,
    log,
  };
  if (typeof x['videoId'] === 'string') out.videoId = x['videoId'];
  // What the analysis cost, when the record carries it. Optional rather than
  // required: a record cached before v2.1 has none, and a cache that rejects
  // its own old entries is a cache that re-analyzes every track once.
  const u = x['usage'];
  if (isRecord(u) && num(u['calls'], 0, Infinity)) {
    out.usage = {
      calls: u['calls'],
      input_tokens: num(u['input_tokens'], 0, Infinity) ? u['input_tokens'] : 0,
      output_tokens: num(u['output_tokens'], 0, Infinity) ? u['output_tokens'] : 0,
      lastLatencyMs: num(u['lastLatencyMs'], 0, Infinity) ? u['lastLatencyMs'] : 0,
    };
  }
  return { ok: true, value: out };
}

/**
 * A distribution that sums to 1 and whose argmax is `chosen`, so that a
 * consumer recomputing the argmax from the probabilities (MoodState does)
 * agrees with the named value.
 */
function leaning<K extends string>(keys: readonly K[], chosen: K, p = 0.4): Record<K, number> {
  const rest = (1 - p) / (keys.length - 1);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = k === chosen ? p : rest;
  return out;
}

/**
 * What the visuals run on before Jev has said anything, and what we fall back
 * to when a call fails: mid-scale on every score, low on every noul, and
 * `confidence: 0` so consumers can tell it apart from a real judgment.
 */
export const NEUTRAL_MOOD: MoodVector = {
  valence: 0.5,
  arousal: 0.5,
  tension: 0.5,
  warmth: 0.5,
  synthetic: 0.5,
  space: 0.5,
  aggression: 0.2,
  melancholy: 0.2,
  hypnotic: 0.2,
  euphoricPeak: 0.2,
  spoken: 0.2,
  genre: 'pop',
  genreP: leaning(GENRES, 'pop'),
  section: 'verse_steady',
  sectionP: leaning(SECTIONS, 'verse_steady'),
  motion: 'flow',
  motionP: leaning(MOTIONS, 'flow'),
  dropImminent: 0.1,
  beatsToChange: 'none',
  impact: 0.3,
  preDropStyle: 'none',
  confidence: 0,
};

/**
 * `m` with every number rounded, for putting on the wire.
 *
 * A `MoodVector` carries three probability maps, and a probability that came
 * out of a renormalisation is a float with seventeen digits of nothing in it:
 * serialized in full a vector is about a kilobyte, against a server that reads
 * two. Two decimals is finer than anything downstream can act on — the HUD
 * prints two, the slew swallows the rest — and it keeps every field inside the
 * range `validateMoodVector` insists on, so the rounded object is still a valid
 * one.
 */
export function compactMoodVector(m: MoodVector, digits = 2): MoodVector {
  const round = (x: number): number => Number(x.toFixed(digits));
  const dist = <K extends string>(p: Record<K, number>, keys: readonly K[]): Record<K, number> => {
    const out = {} as Record<K, number>;
    for (const k of keys) out[k] = round(p[k] ?? 0);
    return out;
  };
  return {
    ...m,
    valence: round(m.valence),
    arousal: round(m.arousal),
    tension: round(m.tension),
    warmth: round(m.warmth),
    synthetic: round(m.synthetic),
    space: round(m.space),
    aggression: round(m.aggression),
    melancholy: round(m.melancholy),
    hypnotic: round(m.hypnotic),
    euphoricPeak: round(m.euphoricPeak),
    spoken: round(m.spoken),
    genreP: dist(m.genreP, GENRES),
    sectionP: dist(m.sectionP, SECTIONS),
    motionP: dist(m.motionP, MOTIONS),
    dropImminent: round(m.dropImminent),
    impact: round(m.impact),
    confidence: round(m.confidence),
  };
}

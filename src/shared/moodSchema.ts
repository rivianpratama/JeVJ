import {
  BEATS_TO_CHANGE,
  GENRES,
  MOTIONS,
  PRE_DROP_STYLES,
  SECTIONS,
  type Attack,
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

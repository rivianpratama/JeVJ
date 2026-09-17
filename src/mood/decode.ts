/**
 * Jev's answers as the mood vector the rest of the app runs on.
 *
 * Three conversions, and the reason each one is here rather than at the call
 * site:
 *
 * - a score comes back as a probability-weighted mean of *level indices*, so
 *   its range depends on the rubric that was asked. Dividing by
 *   `levels − 1` is what makes valence and space comparable, and what lets the
 *   visuals treat every score as a plain 0..1 knob.
 * - a noul is already a probability, and stays one. It is not rounded to a
 *   yes/no here: "0.6 aggressive" is a useful amount of aggressive.
 * - a choice is a label *and* a distribution. Both are kept: the label for
 *   anything that switches, the distribution so `MoodState` can cross-fade
 *   between labels instead of teleporting.
 *
 * Nothing here trusts the model's spelling. Probability maps are coerced onto
 * our own const arrays — labels we do not know drop out, the rest are
 * renormalized — and anything missing or malformed falls back to the neutral
 * value rather than propagating a NaN into the renderer.
 */

import { MOOD_QUESTIONS } from './questions';
import { NEUTRAL_MOOD, validateMoodVector } from '../shared/moodSchema';
import {
  BEATS_TO_CHANGE,
  GENRES,
  MOTIONS,
  PRE_DROP_STYLES,
  SECTIONS,
  type MoodVector,
} from '../shared/types';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** How many rubric levels the question with this id was asked with. */
function levelsOf(id: string): number {
  const q = MOOD_QUESTIONS[id];
  return q !== undefined && q.type === 'score' ? q.criteria.length : 2;
}

/** Confidences gathered while decoding, averaged into `MoodVector.confidence`. */
type Confidences = number[];

function decodeScore(a: unknown, id: string, fallback: number, conf: Confidences): number {
  if (!isRecord(a) || !finite(a['score'])) return fallback;
  const levels = levelsOf(id);
  if (finite(a['confidence'])) conf.push(clamp(a['confidence'], 0, 1));
  return clamp(a['score'], 0, levels - 1) / (levels - 1);
}

function decodeNoul(a: unknown, fallback: number): number {
  if (!isRecord(a) || !finite(a['noul'])) return fallback;
  return clamp(a['noul'], 0, 1);
}

/**
 * A label and a distribution over `labels`. Unknown labels are dropped and
 * what is left is renormalized; an empty or unusable map falls back to
 * `fallbackP`, which already sums to 1 and already leans on `fallbackLabel`.
 */
function decodeChoice<K extends string>(
  a: unknown,
  labels: readonly K[],
  fallbackLabel: K,
  fallbackP: Record<K, number>,
  conf: Confidences,
): { label: K; p: Record<K, number> } {
  if (!isRecord(a)) return { label: fallbackLabel, p: { ...fallbackP } };
  if (finite(a['confidence'])) conf.push(clamp(a['confidence'], 0, 1));

  const raw = isRecord(a['probabilities']) ? a['probabilities'] : {};
  const p = {} as Record<K, number>;
  let total = 0;
  for (const k of labels) {
    const v = raw[k];
    const x = finite(v) && v > 0 ? v : 0;
    p[k] = x;
    total += x;
  }

  const chosen = labels.find((k) => k === a['choice']);

  if (total <= 0) {
    // Nothing usable in the map. A valid label on its own is still an answer;
    // put all of the mass on it so the state machine can slew toward it.
    if (chosen !== undefined) {
      for (const k of labels) p[k] = k === chosen ? 1 : 0;
      return { label: chosen, p };
    }
    return { label: fallbackLabel, p: { ...fallbackP } };
  }

  for (const k of labels) p[k] = p[k] / total;

  if (chosen !== undefined) return { label: chosen, p };

  // No label we recognize: the distribution is the answer, so read its peak.
  let best = labels[0] as K;
  for (const k of labels) if (p[k] > p[best]) best = k;
  return { label: best, p };
}

/**
 * The mood vector the answers describe. Always valid: if anything about the
 * decode went wrong badly enough that the schema rejects it, the neutral mood
 * goes out instead, and its `confidence: 0` says so.
 */
export function decodeAnswers(answers: Record<string, unknown>): MoodVector {
  const conf: Confidences = [];

  const genre = decodeChoice(answers['genre'], GENRES, NEUTRAL_MOOD.genre, NEUTRAL_MOOD.genreP, conf);
  const section = decodeChoice(answers['section'], SECTIONS, NEUTRAL_MOOD.section, NEUTRAL_MOOD.sectionP, conf);
  const motion = decodeChoice(answers['motion'], MOTIONS, NEUTRAL_MOOD.motion, NEUTRAL_MOOD.motionP, conf);

  // These two have no distribution in the vector, so only the label survives;
  // their confidences still count toward the average.
  const beats = decodeChoice(
    answers['beats_to_change'],
    BEATS_TO_CHANGE,
    NEUTRAL_MOOD.beatsToChange,
    uniform(BEATS_TO_CHANGE),
    conf,
  );
  const preDrop = decodeChoice(
    answers['pre_drop_style'],
    PRE_DROP_STYLES,
    NEUTRAL_MOOD.preDropStyle,
    uniform(PRE_DROP_STYLES),
    conf,
  );

  const mood: MoodVector = {
    valence: decodeScore(answers['valence'], 'valence', NEUTRAL_MOOD.valence, conf),
    arousal: decodeScore(answers['arousal'], 'arousal', NEUTRAL_MOOD.arousal, conf),
    tension: decodeScore(answers['tension'], 'tension', NEUTRAL_MOOD.tension, conf),
    warmth: decodeScore(answers['warmth'], 'warmth', NEUTRAL_MOOD.warmth, conf),
    synthetic: decodeScore(answers['synthetic'], 'synthetic', NEUTRAL_MOOD.synthetic, conf),
    space: decodeScore(answers['space'], 'space', NEUTRAL_MOOD.space, conf),
    aggression: decodeNoul(answers['aggression'], NEUTRAL_MOOD.aggression),
    melancholy: decodeNoul(answers['melancholy'], NEUTRAL_MOOD.melancholy),
    hypnotic: decodeNoul(answers['hypnotic'], NEUTRAL_MOOD.hypnotic),
    euphoricPeak: decodeNoul(answers['euphoric_peak'], NEUTRAL_MOOD.euphoricPeak),
    spoken: decodeNoul(answers['spoken'], NEUTRAL_MOOD.spoken),
    genre: genre.label,
    genreP: genre.p,
    section: section.label,
    sectionP: section.p,
    motion: motion.label,
    motionP: motion.p,
    dropImminent: decodeNoul(answers['drop_imminent'], NEUTRAL_MOOD.dropImminent),
    beatsToChange: beats.label,
    impact: decodeScore(answers['impact'], 'impact', NEUTRAL_MOOD.impact, conf),
    preDropStyle: preDrop.label,
    confidence: conf.length === 0 ? 0 : conf.reduce((a, b) => a + b, 0) / conf.length,
  };

  const checked = validateMoodVector(mood);
  return checked.ok ? checked.value : { ...NEUTRAL_MOOD };
}

function uniform<K extends string>(labels: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of labels) out[k] = 1 / labels.length;
  return out;
}

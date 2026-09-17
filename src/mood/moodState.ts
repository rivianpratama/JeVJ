/**
 * The mood the visuals actually read: Jev's last judgment, approached rather
 * than jumped to.
 *
 * Answers arrive every few seconds and land whole — valence 0.25 one moment,
 * 0.9 the next. Handing that straight to a renderer running at sixty frames a
 * second would make the picture flinch every time the model speaks, and the
 * flinch would be an artifact of the polling rate rather than of the music. So
 * each field is a first-order lag toward its target, and the time constants
 * say what each field is *for*:
 *
 * - the standing scores (valence, arousal, warmth…) move over τ = 1.5 s. They
 *   describe the mood of a passage; a passage does not turn on a dime.
 * - the nouls move over τ = 1 s: a little quicker, because "is this
 *   aggressive" can genuinely flip inside a bar.
 * - `euphoricPeak`, `impact` and `dropImminent` move over τ = 0.4 s. These are
 *   the ones with a deadline — a drop that is landing does not care that the
 *   average was calm two seconds ago.
 *
 * Choices cross-fade by slewing the whole probability map and re-reading its
 * argmax, so a label only changes when the new one has genuinely overtaken the
 * old. That is what stops `motion` from strobing between `flow` and `pulse` on
 * two adjacent calls that were nearly a coin-flip.
 *
 * The clock is the caller's audio clock, and `tick` is idempotent for a given
 * `now`, so the HUD and the renderer can both read it in the same frame.
 */

import { NEUTRAL_MOOD } from '../shared/moodSchema';
import { GENRES, MOTIONS, SECTIONS, type MoodVector } from '../shared/types';

/** Seconds to cover 63% of the distance, per family of field. */
const TAU_SCORE = 1.5;
const TAU_NOUL = 1.0;
const TAU_FAST = 0.4;

/** Fields that follow the slow score constant. */
const SCORE_FIELDS = [
  'valence',
  'arousal',
  'tension',
  'warmth',
  'synthetic',
  'space',
  'confidence',
] as const;
const NOUL_FIELDS = ['aggression', 'melancholy', 'hypnotic', 'spoken'] as const;
const FAST_FIELDS = ['euphoricPeak', 'impact', 'dropImminent'] as const;

export class MoodState {
  private value: MoodVector;
  private target: MoodVector;
  private at = Number.NaN;

  constructor(initial: MoodVector = NEUTRAL_MOOD) {
    this.value = clone(initial);
    this.target = clone(initial);
  }

  /**
   * Aim at `m` from `now` on. The state is first brought up to `now` against
   * the old target, so a target that arrives mid-flight does not rewrite the
   * motion that already happened.
   */
  setTarget(m: MoodVector, now: number): void {
    this.advance(now);
    this.target = clone(m);
    this.at = now;
  }

  /** The mood as of `now`. */
  tick(now: number): MoodVector {
    this.advance(now);
    return clone(this.value);
  }

  /** The mood as of the last tick, without advancing the clock. */
  current(): MoodVector {
    return clone(this.value);
  }

  private advance(now: number): void {
    if (Number.isNaN(this.at)) this.at = now;
    const dt = now - this.at;
    // Not `Math.max(0, dt)`: a clock that went backwards (a seek, a new track)
    // should hold, not extrapolate.
    if (!(dt > 0)) {
      if (dt < 0) this.at = now;
      return;
    }
    this.at = now;

    const slow = 1 - Math.exp(-dt / TAU_SCORE);
    const mid = 1 - Math.exp(-dt / TAU_NOUL);
    const fast = 1 - Math.exp(-dt / TAU_FAST);

    for (const f of SCORE_FIELDS) this.value[f] = lerp(this.value[f], this.target[f], slow);
    for (const f of NOUL_FIELDS) this.value[f] = lerp(this.value[f], this.target[f], mid);
    for (const f of FAST_FIELDS) this.value[f] = lerp(this.value[f], this.target[f], fast);

    this.value.genreP = slewDist(this.value.genreP, this.target.genreP, GENRES, slow);
    this.value.sectionP = slewDist(this.value.sectionP, this.target.sectionP, SECTIONS, slow);
    this.value.motionP = slewDist(this.value.motionP, this.target.motionP, MOTIONS, slow);
    this.value.genre = argmax(this.value.genreP, GENRES);
    this.value.section = argmax(this.value.sectionP, SECTIONS);
    this.value.motion = argmax(this.value.motionP, MOTIONS);

    // No distribution to cross-fade, and both are deadlines rather than
    // moods: the newest answer is the only one worth acting on.
    this.value.beatsToChange = this.target.beatsToChange;
    this.value.preDropStyle = this.target.preDropStyle;
  }
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function slewDist<K extends string>(
  from: Record<K, number>,
  to: Record<K, number>,
  keys: readonly K[],
  k: number,
): Record<K, number> {
  const out = {} as Record<K, number>;
  let total = 0;
  for (const key of keys) {
    const v = Math.max(0, lerp(from[key] ?? 0, to[key] ?? 0, k));
    out[key] = v;
    total += v;
  }
  // Both ends sum to one, so the blend does too up to rounding; normalizing
  // keeps that true after thousands of frames.
  if (total > 0) for (const key of keys) out[key] = out[key] / total;
  else for (const key of keys) out[key] = 1 / keys.length;
  return out;
}

function argmax<K extends string>(p: Record<K, number>, keys: readonly K[]): K {
  let best = keys[0] as K;
  for (const key of keys) if (p[key] > p[best]) best = key;
  return best;
}

function clone(m: MoodVector): MoodVector {
  return { ...m, genreP: { ...m.genreP }, sectionP: { ...m.sectionP }, motionP: { ...m.motionP } };
}

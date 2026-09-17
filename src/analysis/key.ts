/**
 * What key the music is in, and what flavour of it.
 *
 * Krumhansl and Kessler asked listeners how well each pitch class fitted a
 * given key and got two twelve-number profiles out of it — one major, one
 * minor. Correlate a piece's accumulated chroma against all twenty-four
 * rotations of those two profiles and the best match is the key a listener
 * would name. That is the whole method, and it is old enough to be boring,
 * which is exactly what we want here.
 *
 * Two things are layered on top:
 *
 * - The chroma is *accumulated*, not averaged, and forgets exponentially. A key
 *   is a property of a phrase, not a frame: eight bars of evidence with the
 *   most recent bar weighing most is what a listener actually has.
 * - Major and minor are not the only colours. The same seven notes read as
 *   dorian or mixolydian depending on which one is home, so once the tonic is
 *   known the accumulated chroma is matched against the seven diatonic modes.
 *
 * Pure: chroma vectors and seconds in, a judgment out. Nothing here touches
 * the DOM, Web Audio or the wall clock.
 */

import type { Mode, ModalFlavor } from '../shared/types';

/** Krumhansl-Kessler major key profile, tonic first. */
export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
/** Krumhansl-Kessler minor key profile, tonic first. */
export const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The seven diatonic modes as pitch-class sets measured from their tonic. */
const MODE_TEMPLATES: Array<{ name: ModalFlavor; pcs: number[] }> = [
  { name: 'ionian', pcs: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'dorian', pcs: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'phrygian', pcs: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'lydian', pcs: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'mixolydian', pcs: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'aeolian', pcs: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'locrian', pcs: [0, 1, 3, 5, 6, 8, 10] },
];

/** What a second of history is worth once the next second has gone by. */
const DEFAULT_DECAY_PER_SECOND = 0.88;
/**
 * The correlation margin that counts as a confident major/minor call. Beyond
 * about a quarter of a correlation point the two profiles are not close, so
 * that is the full scale for `modeConf`.
 */
const MODE_MARGIN_SCALE = 0.25;
/** Below this much margin the call is only made if one profile fits well. */
const MODE_MARGIN_FLOOR = 0.08;
/** ...and "fits well" means a correlation at least this high. */
const MODE_FIT_FLOOR = 0.5;
/** How far the best mode template must beat the runner-up to be named. */
const MODAL_MARGIN = 0.05;
/** A tab left in the background must not decay the whole accumulator away. */
const MAX_DT = 1;

/**
 * The two profiles written out for all twelve tonics, once. `estimate()` runs
 * every frame and correlating against freshly rotated copies would allocate
 * twenty-four arrays sixty times a second for numbers that never change.
 */
const ROTATED_MAJOR = rotations(KK_MAJOR);
const ROTATED_MINOR = rotations(KK_MINOR);

export interface KeyEstimate {
  /** A pitch-class name, or '?' when nothing has been heard. */
  key: string;
  mode: Mode;
  /** 0..1: how far apart the best major and best minor fits are. */
  modeConf: number;
  modal: ModalFlavor;
  /** Pitch class of the tonic, or -1 when there is no key. */
  tonic: number;
}

const NOTHING: KeyEstimate = { key: '?', mode: 'unclear', modeConf: 0, modal: 'unclear', tonic: -1 };

export class KeyTracker {
  private readonly decay: number;
  private readonly acc = new Float32Array(12);

  constructor(decayPerSecond: number = DEFAULT_DECAY_PER_SECOND) {
    if (!(decayPerSecond > 0) || decayPerSecond > 1) {
      throw new RangeError(`decayPerSecond must be in (0, 1], got ${decayPerSecond}`);
    }
    this.decay = decayPerSecond;
  }

  /**
   * One frame of chroma, and how long it has been since the last one.
   *
   * The decay is raised to `dt` rather than applied per frame so the memory is
   * a span of seconds whatever rate the frames arrive at — a dropped frame
   * must not make the tracker remember longer.
   */
  push(chroma: Float32Array, dt: number): void {
    const step = Math.pow(this.decay, Math.min(MAX_DT, Math.max(0, dt)));
    for (let i = 0; i < 12; i++) this.acc[i] = this.acc[i]! * step + (chroma[i] ?? 0);
  }

  estimate(): KeyEstimate {
    let total = 0;
    for (let i = 0; i < 12; i++) total += this.acc[i]!;
    if (!(total > 0)) return NOTHING;

    // Best fit in each mode, over all twelve rotations.
    let majorTonic = 0;
    let majorFit = -Infinity;
    let minorTonic = 0;
    let minorFit = -Infinity;
    for (let tonic = 0; tonic < 12; tonic++) {
      const major = pearson(this.acc, ROTATED_MAJOR[tonic]!);
      if (major > majorFit) {
        majorFit = major;
        majorTonic = tonic;
      }
      const minor = pearson(this.acc, ROTATED_MINOR[tonic]!);
      if (minor > minorFit) {
        minorFit = minor;
        minorTonic = tonic;
      }
    }

    const margin = clamp((majorFit - minorFit) / MODE_MARGIN_SCALE, -1, 1);
    // A small margin means the two profiles fit about as well as each other.
    // That is only "unclear" if neither fits: two good fits a hair apart still
    // name a key, they just do not insist on its colour.
    const undecided =
      Math.abs(margin) < MODE_MARGIN_FLOOR && majorFit < MODE_FIT_FLOOR && minorFit < MODE_FIT_FLOOR;

    const major = margin >= 0;
    const tonic = major ? majorTonic : minorTonic;
    const mode: Mode = undecided ? 'unclear' : major ? 'major' : 'minor';

    return {
      key: PC_NAMES[tonic] ?? '?',
      mode,
      modeConf: Math.abs(margin),
      modal: modalFlavor(this.acc, tonic),
      tonic,
    };
  }
}

/** Pearson correlation. 0 when either side is flat — no shape, no agreement. */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;

  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Which of the seven diatonic modes the chroma looks most like, measured from
 * `tonic`.
 *
 * The chroma is rotated so the tonic is index 0 and each template scores the
 * share of the music's energy that falls inside its mode. The tonic itself is
 * left out of both the score and the normalisation: every one of the seven
 * templates contains it, so it is the same constant in every score and tells
 * us nothing about which mode this is — but normalising by a total that
 * included it would make every margin shrink as the tonic got louder. A dorian
 * melody over a drone would then be less recognisably dorian the more it
 * sounded like dorian. Measured on the fixture in `tests/analysis/key.test.ts`
 * the drone pulled the winning margin from 0.078 down to 0.042, under the 0.05
 * a mode has to clear; without the tonic in the denominator it reads 0.075
 * with the drone and 0.099 without, which is the stability we want.
 *
 * The winner still has to beat the runner-up by that margin: a bare triad
 * belongs to three modes at once and naming one of them would be an invention.
 */
export function modalFlavor(chroma: Float32Array, tonic: number): ModalFlavor {
  if (tonic < 0) return 'unclear';

  let total = 0;
  for (let pc = 1; pc < 12; pc++) total += Math.max(0, chroma[(tonic + pc) % 12] ?? 0);
  if (!(total > 0)) return 'unclear';

  let best: ModalFlavor = 'unclear';
  let bestScore = -Infinity;
  let second = -Infinity;

  for (const template of MODE_TEMPLATES) {
    let score = 0;
    for (const pc of template.pcs) {
      if (pc === 0) continue;
      score += Math.max(0, chroma[(tonic + pc) % 12] ?? 0);
    }
    score /= total;

    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = template.name;
    } else if (score > second) {
      second = score;
    }
  }

  return bestScore - second >= MODAL_MARGIN ? best : 'unclear';
}

/** `profile` written out for a key whose tonic is each pitch class in turn. */
function rotations(profile: number[]): Float64Array[] {
  return Array.from({ length: 12 }, (_, tonic) => {
    const out = new Float64Array(12);
    for (let i = 0; i < 12; i++) out[(tonic + i) % 12] = profile[i]!;
    return out;
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

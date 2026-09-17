/**
 * The groove: how far off the beat the music plays, how evenly it plays, how
 * it counts, and whether it is getting busier.
 *
 * The beat grid already says *where* the beats are; this says what the music
 * does around them. Everything is measured against `grid.phase` rather than
 * against absolute time, so a track that speeds up does not read as suddenly
 * syncopated.
 *
 * Three ideas:
 *
 * - Syncopation is onset energy away from the beat. A small deadband around
 *   phase 0 absorbs the frame quantisation and the human milliseconds; past
 *   a sixteenth the onset is off the beat and counts fully.
 * - Regularity is the spread of the inter-onset intervals, measured with a
 *   median and a median absolute deviation rather than a mean and a variance.
 *   One missed onset doubles one interval, and that must not turn a machine
 *   into a rubato player.
 * - Meter is decided by where the accents fall. Two accumulators collect onset
 *   strength by beat-position-modulo-3 and modulo-4; whichever hypothesis has
 *   one position standing further above its siblings is the one the music is
 *   counted in.
 *
 * Pure: times come from the caller's audio clock and nothing here touches the
 * DOM.
 */

import type { Meter } from '../shared/types';

/**
 * How many onsets are kept. At the ten a second dense music manages that is
 * three minutes of history — far more than the ten bars `onsetRatio` reaches
 * back for, and the whole buffer is allocated once.
 */
const CAPACITY = 2048;

/** How far back syncopation and regularity look. */
const GROOVE_WINDOW_SEC = 8;
/** And how far back the onset rate is counted. */
const DENSITY_WINDOW_SEC = 4;

/** Inside a sixteenth of the beat an onset is *on* it. */
const ON_BEAT_DEADBAND = 1 / 16;
/** By a quarter beat away it is fully off it. */
const OFF_BEAT_FULL = 1 / 4;

/** Fewer intervals than this and the spread means nothing. */
const MIN_INTERVALS = 4;
/** The deviation-to-median ratio that counts as completely irregular. */
const IRREGULAR_SCALE = 0.2;

/** Beats of evidence before the meter is worth naming. */
const MIN_METER_BEATS = 8;
/** Two hypotheses this close are not telling us anything. */
const METER_DECIDE_MARGIN = 0.1;
/** What last beat's accent evidence is worth once another beat has gone by. */
const METER_DECAY = 0.99;

/** The widest change in density worth reporting. */
const MAX_ONSET_RATIO = 20;

export class RhythmTracker {
  private readonly ts = new Float64Array(CAPACITY);
  private readonly strengths = new Float64Array(CAPACITY);
  private readonly phases = new Float64Array(CAPACITY);
  private head = 0;
  private stored = 0;

  /** Accent evidence by position in a three-beat and a four-beat bar. */
  private readonly acc3 = new Float64Array(3);
  private readonly acc4 = new Float64Array(4);
  private beats = 0;
  private prevPhase = -1;

  /**
   * Every frame, whether or not anything happened: the beat count is made of
   * phase *wraps*, and an onset-only view of the phase would miss most of
   * them. Music whose onsets all land on the beat reports the same phase every
   * time, and the count would never advance.
   */
  tick(_t: number, phase: number): void {
    this.advance(phase);
  }

  /** One onset, with the grid's phase at the moment it sounded. */
  pushOnset(t: number, strength: number, phase: number): void {
    this.advance(phase);

    this.ts[this.head] = t;
    this.strengths[this.head] = strength;
    this.phases[this.head] = wrap(phase);
    this.head = (this.head + 1) % CAPACITY;
    if (this.stored < CAPACITY) this.stored += 1;

    this.acc3[this.beats % 3] = this.acc3[this.beats % 3]! + strength;
    this.acc4[this.beats % 4] = this.acc4[this.beats % 4]! + strength;
  }

  /** 0 when every onset is on a beat, 1 when every onset is between them. */
  syncopation(): number {
    const from = this.windowStart(GROOVE_WINDOW_SEC);
    let off = 0;
    let all = 0;
    for (let i = this.indexFrom(from); i < this.stored; i++) {
      const s = this.strengthAt(i);
      all += s;
      off += s * offBeatWeight(this.phaseAt(i));
    }
    return all > 0 ? off / all : 0;
  }

  /** 1 for a metronome, 0 for free time. */
  regularity(): number {
    const from = this.windowStart(GROOVE_WINDOW_SEC);
    const start = this.indexFrom(from);
    const n = this.stored - start - 1;
    if (n < MIN_INTERVALS) return 0;

    const gaps = new Float64Array(n);
    for (let i = 0; i < n; i++) gaps[i] = this.timeAt(start + i + 1) - this.timeAt(start + i);

    const middle = median(gaps);
    if (!(middle > 0)) return 0;

    const spread = new Float64Array(n);
    for (let i = 0; i < n; i++) spread[i] = Math.abs(gaps[i]! - middle);

    return clamp(1 - median(spread) / middle / IRREGULAR_SCALE, 0, 1);
  }

  /** Duple or triple, from where the accents keep landing. */
  meter(): Meter {
    if (this.beats < MIN_METER_BEATS) return 'unclear';

    const triple = dominance(this.acc3);
    const duple = dominance(this.acc4);
    if (Math.abs(triple - duple) <= METER_DECIDE_MARGIN) return 'unclear';
    return triple > duple ? 'triple' : 'duple';
  }

  /** Onsets a second over the last four seconds. */
  onsetsPerSec(now: number): number {
    return this.countIn(now - DENSITY_WINDOW_SEC, now) / DENSITY_WINDOW_SEC;
  }

  /**
   * How much busier the last two bars are than the two bars that ran from
   * ten to eight bars ago — the snare-roll detector, essentially.
   *
   * 1 means "no change", which is also the answer when the comparison window
   * is older than anything retained: silence about the past beats a made-up
   * number about it.
   */
  onsetRatio(now: number, barSec: number): number {
    if (!(barSec > 0) || this.stored === 0) return 1;

    const wasFrom = now - 10 * barSec;
    if (wasFrom < this.timeAt(0)) return 1;

    const is = this.countIn(now - 2 * barSec, now);
    const was = this.countIn(wasFrom, now - 8 * barSec);
    if (was === 0) return is > 0 ? MAX_ONSET_RATIO : 1;
    return clamp(is / was, 0, MAX_ONSET_RATIO);
  }

  /** A phase that has gone backwards is a beat that has gone by. */
  private advance(phase: number): void {
    const p = wrap(phase);
    if (this.prevPhase >= 0 && p < this.prevPhase) {
      this.beats += 1;
      for (let i = 0; i < 3; i++) this.acc3[i] = this.acc3[i]! * METER_DECAY;
      for (let i = 0; i < 4; i++) this.acc4[i] = this.acc4[i]! * METER_DECAY;
    }
    this.prevPhase = p;
  }

  private countIn(from: number, to: number): number {
    let n = 0;
    for (let i = this.indexFrom(from); i < this.stored; i++) {
      if (this.timeAt(i) > to) break;
      n += 1;
    }
    return n;
  }

  /** Where a window of `seconds` before the newest onset starts. */
  private windowStart(seconds: number): number {
    return this.stored === 0 ? 0 : this.timeAt(this.stored - 1) - seconds;
  }

  /** First retained index at or after `t`; `stored` when every onset is older. */
  private indexFrom(t: number): number {
    let lo = 0;
    let hi = this.stored;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private slot(i: number): number {
    const oldest = this.stored < CAPACITY ? 0 : this.head;
    return (oldest + i) % CAPACITY;
  }

  private timeAt(i: number): number {
    return this.ts[this.slot(i)]!;
  }

  private strengthAt(i: number): number {
    return this.strengths[this.slot(i)]!;
  }

  private phaseAt(i: number): number {
    return this.phases[this.slot(i)]!;
  }
}

/**
 * How far an onset at `phase` is from the beat, 0..1. Flat inside the
 * deadband, then straight up to full weight at a quarter of a beat — which is
 * where the sixteenth-note grid the ear hears syncopation on begins.
 */
function offBeatWeight(phase: number): number {
  const distance = Math.min(phase, 1 - phase);
  return clamp((distance - ON_BEAT_DEADBAND) / (OFF_BEAT_FULL - ON_BEAT_DEADBAND), 0, 1);
}

/**
 * How far the strongest slot of a bar hypothesis stands above the average of
 * the others, as a share of all the evidence. 0 when every slot is equal,
 * which is what a hypothesis that does not fit the music looks like.
 */
function dominance(acc: Float64Array): number {
  let total = 0;
  let best = 0;
  for (let i = 0; i < acc.length; i++) {
    total += acc[i]!;
    best = Math.max(best, acc[i]!);
  }
  if (!(total > 0) || acc.length < 2) return 0;
  const others = (total - best) / (acc.length - 1);
  return (best - others) / total;
}

/** Median of `values`, which is sorted in place. */
function median(values: Float64Array): number {
  const n = values.length;
  if (n === 0) return 0;
  values.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

function wrap(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  const p = phase % 1;
  return p < 0 ? p + 1 : p;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Loudness, and what the music is doing with it.
 *
 * Dynamics are relative and always have been: pp and ff are marks about *this*
 * piece, and a mastered pop record whose whole range is six decibels still has
 * quiet moments and loud ones. So everything here is measured against the
 * session's own running range rather than against dBFS.
 *
 * The running range has to forget, or a single loud transient at the start
 * would make the next ten minutes read as pianissimo. It forgets slowly — half
 * a decibel a second — which is fast enough that a long quiet passage after a
 * loud one eventually reads as quiet, and slow enough that one bar of silence
 * does not reset the scale.
 *
 * Pure: decibels and audio-clock seconds in, judgments out.
 */

import type { DynClass, Trend } from '../shared/types';
import { TimedRing } from './ring';

/** How much loudness history is kept. Eight bars at 60 BPM is 32 s. */
const HISTORY_SEC = 60;
/** 60 s at 200 frames a second — headroom for any display. */
const CAPACITY = HISTORY_SEC * 200;

/** The window "how loud is it right now" averages over. */
const LOUDNESS_WINDOW_SEC = 3;
/** How fast the remembered session extremes creep toward the present. */
const EXTREME_DECAY_DB_PER_SEC = 0.5;
/** Below this the session has no range yet and everything is mezzo-forte. */
const MIN_SPAN_DB = 1e-6;

/** Where each dynamic marking starts, as a position in the session range. */
const LOUD_STEPS: Array<{ upTo: number; name: DynClass }> = [
  { upTo: 0.1, name: 'pp' },
  { upTo: 0.3, name: 'p' },
  { upTo: 0.45, name: 'mp' },
  { upTo: 0.6, name: 'mf' },
  { upTo: 0.8, name: 'f' },
];

/** The span `range()` looks over, and the decibels that count as "wide". */
const RANGE_WINDOW_SEC = 20;
const RANGE_FULL_DB = 30;
/** Recomputing percentiles every frame is wasted work; this often is plenty. */
const RANGE_CACHE_SEC = 0.25;

/** `trend()` compares the last 1.5 s against the 3 s before that. */
const TREND_RECENT_SEC = 1.5;
const TREND_PAST_SEC = 4.5;
/** Decibels of change that count as a crescendo or a diminuendo. */
const TREND_DB = 3;

/** `crest()` looks over two seconds and calls 20 dB of peak-to-rms "full". */
const CREST_WINDOW_SEC = 2;
const CREST_FULL_DB = 20;

/** The half-second means `slopeDb` compares. */
const SLOPE_WINDOW_SEC = 0.5;

/** A gap is this long, this far below the recent average, inside the last beat. */
const GAP_WINDOW_SEC = 0.15;
const GAP_REFERENCE_SEC = 4;
const GAP_DEPTH_DB = 12;

export class DynamicsTracker {
  private readonly history = new TimedRing(CAPACITY);
  private lastT = 0;
  private started = false;

  /** The session's running quietest and loudest three-second loudness. */
  private lo = 0;
  private hi = 0;

  private rangeCachedAt = -Infinity;
  private rangeCached = 0;

  push(db: number, t: number): void {
    const level = Number.isFinite(db) ? db : -100;
    this.history.push(t, level);

    const now = this.loudness(t);
    if (!this.started) {
      this.lo = now;
      this.hi = now;
      this.started = true;
      this.lastT = t;
      return;
    }

    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    // Both extremes creep toward the present, and neither may pass it: the
    // current loudness always sits inside the range it is measured against.
    this.lo = Math.min(now, this.lo + EXTREME_DECAY_DB_PER_SEC * dt);
    this.hi = Math.max(now, this.hi - EXTREME_DECAY_DB_PER_SEC * dt);
  }

  /**
   * 0..1: where the present sits between the session's quietest and loudest.
   *
   * A range narrower than `MIN_SPAN_DB` is not a range — a track that has only
   * played one bar, or a fixture that is one sustained sound — and reads 0.5,
   * the middle, rather than whichever end the noise happened to fall on.
   * `harsh` is built on this, so a degenerate range must not be able to make
   * silence read as a scream.
   */
  position(): number {
    const span = this.hi - this.lo;
    if (!(span > MIN_SPAN_DB)) return 0.5;
    return clamp((this.loudness(this.lastT) - this.lo) / span, 0, 1);
  }

  /** Where the present sits in the session's own range, named like a score. */
  loudClass(): DynClass {
    const position = this.position();
    for (const step of LOUD_STEPS) if (position < step.upTo) return step.name;
    return 'ff';
  }

  /** 0 for a compressed master, 1 for something that uses 30 dB or more. */
  range(): number {
    if (this.lastT - this.rangeCachedAt < RANGE_CACHE_SEC) return this.rangeCached;

    const values = this.window(this.lastT - RANGE_WINDOW_SEC, this.lastT);
    this.rangeCachedAt = this.lastT;
    // The extremes are read at the 95th and 10th percentile rather than at the
    // max and min: one clipped transient is not the music's dynamic range, and
    // neither is the one frame where everything happened to cancel.
    const spread = values.length === 0 ? 0 : percentile(values, 0.95) - percentile(values, 0.1);
    this.rangeCached = clamp(spread / RANGE_FULL_DB, 0, 1);
    return this.rangeCached;
  }

  /** Crescendo, diminuendo, or neither. */
  trend(): Trend {
    const now = this.lastT;
    const recent = this.history.mean(now - TREND_RECENT_SEC, now);
    const before = this.history.mean(now - TREND_PAST_SEC, now - TREND_RECENT_SEC);
    if (this.history.countIn(now - TREND_PAST_SEC, now - TREND_RECENT_SEC) === 0) return 'steady';

    const change = recent - before;
    if (change > TREND_DB) return 'building';
    if (change < -TREND_DB) return 'fading';
    return 'steady';
  }

  /**
   * Peak over rms across the last two seconds, 0..1. Transients that stand
   * well above the body of the sound read high; a limited master reads low.
   */
  crest(): number {
    const from = this.lastT - CREST_WINDOW_SEC;
    const peak = this.history.max(from, this.lastT);
    if (!Number.isFinite(peak)) return 0;

    // The frames are already dB of an rms; averaging them has to happen in
    // the linear domain or the answer is a geometric mean, not an rms.
    const start = this.history.indexAtOrAfter(from);
    let power = 0;
    let n = 0;
    for (let i = start; i < this.history.length; i++) {
      const linear = Math.pow(10, this.history.valueAt(i) / 20);
      power += linear * linear;
      n += 1;
    }
    if (n === 0) return 0;

    const rmsDb = 20 * Math.log10(Math.max(Math.sqrt(power / n), 1e-10));
    return clamp((peak - rmsDb) / CREST_FULL_DB, 0, 1);
  }

  /**
   * How much louder the music is now than it was `barsBack` bars ago, in dB,
   * to one decimal. 0 when the history does not reach that far.
   */
  slopeDb(barsBack: number, barSec: number, now: number): number {
    const thenEnd = now - barsBack * barSec;
    const thenStart = thenEnd - SLOPE_WINDOW_SEC;
    if (this.history.countIn(thenStart, thenEnd) === 0) return 0;
    if (this.history.countIn(now - SLOPE_WINDOW_SEC, now) === 0) return 0;

    const change = this.history.mean(now - SLOPE_WINDOW_SEC, now) - this.history.mean(thenStart, thenEnd);
    return Math.round(change * 10) / 10;
  }

  /**
   * Whether the music dropped out somewhere in the last beat — the one-beat
   * silence that so often precedes a drop.
   *
   * The reference is the plain four-second mean, gap included. That dilutes
   * the measurement a little: a 0.2 s hole is 5% of four seconds, so it drags
   * the reference down with it by about 0.6 dB and has to be that much deeper
   * to clear the threshold. Left as it is deliberately — a reference that
   * excluded the thing it is measuring would need to know where the gap was
   * before it could look for it.
   */
  gap(now: number, beatSec: number): boolean {
    if (!(beatSec >= GAP_WINDOW_SEC)) return false;
    if (this.history.countIn(now - GAP_REFERENCE_SEC, now) === 0) return false;

    const reference = this.history.mean(now - GAP_REFERENCE_SEC, now);
    const floor = reference - GAP_DEPTH_DB;

    const first = this.history.indexAtOrAfter(now - beatSec);
    for (let i = first; i < this.history.length; i++) {
      const start = this.history.timeAt(i);
      if (start + GAP_WINDOW_SEC > now) break;
      if (this.history.mean(start, start + GAP_WINDOW_SEC) <= floor) return true;
    }
    return false;
  }

  /** The three-second mean loudness ending at `t`. */
  private loudness(t: number): number {
    return this.history.mean(t - LOUDNESS_WINDOW_SEC, t);
  }

  /** A fresh copy of the loudness samples in `[from, to]`, oldest first. */
  private window(from: number, to: number): Float64Array {
    const start = this.history.indexAtOrAfter(from);
    let n = 0;
    while (start + n < this.history.length && this.history.timeAt(start + n) <= to) n += 1;

    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.history.valueAt(start + i);
    return out;
  }
}

/** `p` of the way through `values`, which is sorted in place. */
function percentile(values: Float64Array, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  values.sort();
  const at = clamp(p, 0, 1) * (n - 1);
  const lo = Math.floor(at);
  const hi = Math.min(n - 1, lo + 1);
  return values[lo]! + (values[hi]! - values[lo]!) * (at - lo);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

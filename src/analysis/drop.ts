/**
 * The two loudness events that matter to a visualizer and that no model is
 * fast enough to call: the slam, and the hole that so often precedes it.
 *
 * Jev answers in hundreds of milliseconds, which is fine for "this is a
 * build" and useless for "hit now". So the impact stays here, in a detector
 * that runs on every frame and owes nothing to the network: a short window
 * that is suddenly much louder than the second before it, with the bass in it
 * and an onset on it, is a drop. A short window far below the last few seconds
 * is the silence before one.
 *
 * Loudness is averaged in the power domain, not in dB. A mean of decibels is a
 * geometric mean of energies: one loud frame among eleven quiet ones barely
 * moves it, and a slam would take a fifth of a second to register. Averaging
 * the energies and converting once at the end is both the physically correct
 * reading and the responsive one — the first two frames of a 18 dB jump are
 * enough to clear the threshold.
 *
 * Pure: frames in, events out, no clock but the one stamped on the frames.
 */

import { TimedRing } from './ring';
import type { FrameFeatures } from '../shared/types';

/** How much louder than the preceding dip a slam has to be. */
const JUMP_DB = 8;
/** How far back the dip that a slam is measured against is looked for. */
const DIP_WINDOW_SEC = 1;
/** The window "now" is measured over. */
const SHORT_SEC = 0.2;

/** How much of the low end an impact has to carry. */
const LOW_SHARE = 0.5;
/** One impact per this many seconds; a drop is an event, not a state. */
const IMPACT_COOLDOWN_SEC = 1.5;

/** What a gap is measured against, and how far below it one sits. */
const GAP_REFERENCE_SEC = 4;
const GAP_DEPTH_DB = 12;
const GAP_COOLDOWN_SEC = 2;

/** Frames of history: ten seconds at 60 fps, with room for faster hosts. */
const CAPACITY = 1200;

/** Quietest level the detector will reason about, so log10(0) never happens. */
const FLOOR_DB = -120;

export interface DropEvent {
  /** Audio-clock time of the frame the event was called on. */
  t: number;
  /** 0..1: how much of one this was. */
  strength: number;
  kind: 'impact' | 'gap';
}

export interface DropOptions {
  jumpDb?: number;
  dipWindowSec?: number;
  shortSec?: number;
}

export class DropDetector {
  private readonly jumpDb: number;
  private readonly dipWindowSec: number;
  private readonly shortSec: number;

  /** Per-frame energy, linear. */
  private readonly power = new TimedRing(CAPACITY);
  /** The short-window loudness of each frame, in dB — what a dip is a dip in. */
  private readonly short = new TimedRing(CAPACITY);

  private lastImpactAt = -Infinity;
  private lastGapAt = -Infinity;

  constructor(o: DropOptions = {}) {
    this.jumpDb = o.jumpDb ?? JUMP_DB;
    this.dipWindowSec = o.dipWindowSec ?? DIP_WINDOW_SEC;
    this.shortSec = o.shortSec ?? SHORT_SEC;
  }

  /**
   * One frame in; the event it completed, or null. At most one event per
   * frame: an impact is a rise and a gap is a fall, so they cannot both be
   * true, and the impact is checked first because it is the one with a
   * deadline.
   */
  push(f: FrameFeatures, onset: number): DropEvent | null {
    const t = f.t;
    this.power.push(t, toPower(f.db));

    const now = toDb(this.meanPower(t - this.shortSec, t));
    this.short.push(t, now);

    const impact = this.impact(f, onset, t, now);
    if (impact) return impact;
    return this.gap(t, now);
  }

  /**
   * A slam: much louder than the quietest moment of the preceding second,
   * with the bass in it and an onset on it.
   */
  private impact(f: FrameFeatures, onset: number, t: number, now: number): DropEvent | null {
    if (onset <= 0) return null;
    if (t - this.lastImpactAt < IMPACT_COOLDOWN_SEC) return null;

    const low = ((f.bands[0] ?? 0) + (f.bands[1] ?? 0)) / 2;
    if (low < LOW_SHARE) return null;

    // The dip is looked for *before* the short window, so the slam itself is
    // never the thing it is measured against.
    const dipEnd = t - this.shortSec;
    const dip = this.minShort(dipEnd - this.dipWindowSec, dipEnd);
    if (dip === null) return null;

    const jump = now - dip;
    if (jump < this.jumpDb) return null;

    this.lastImpactAt = t;
    // Half the strength is how far the jump overshot the threshold — twice it
    // is as hard as this reads — and half is how much of it was bass.
    const rise = clamp01(jump / (2 * this.jumpDb));
    return { t, strength: clamp01(0.6 * rise + 0.4 * clamp01(low)), kind: 'impact' };
  }

  /** A hole: the short window far below the last few seconds. */
  private gap(t: number, now: number): DropEvent | null {
    if (t - this.lastGapAt < GAP_COOLDOWN_SEC) return null;
    if (this.power.countIn(t - GAP_REFERENCE_SEC, t) < 2) return null;

    const reference = toDb(this.meanPower(t - GAP_REFERENCE_SEC, t));
    const depth = reference - now;
    if (depth < GAP_DEPTH_DB) return null;

    this.lastGapAt = t;
    return { t, strength: clamp01(depth / (2 * GAP_DEPTH_DB)), kind: 'gap' };
  }

  /** Mean energy over `(from, to]` — the last `to - from` seconds, exactly. */
  private meanPower(from: number, to: number): number {
    let sum = 0;
    let n = 0;
    for (let i = this.firstAfter(from, this.power); i < this.power.length; i++) {
      if (this.power.timeAt(i) > to) break;
      sum += this.power.valueAt(i);
      n += 1;
    }
    return n === 0 ? 0 : sum / n;
  }

  /** Quietest short-window loudness in `(from, to]`, or null when empty. */
  private minShort(from: number, to: number): number | null {
    let m = Infinity;
    for (let i = this.firstAfter(from, this.short); i < this.short.length; i++) {
      if (this.short.timeAt(i) > to) break;
      m = Math.min(m, this.short.valueAt(i));
    }
    return m === Infinity ? null : m;
  }

  /** First index strictly after `t`: the windows here exclude their own start. */
  private firstAfter(t: number, ring: TimedRing): number {
    let i = ring.indexAtOrAfter(t);
    while (i < ring.length && ring.timeAt(i) <= t) i += 1;
    return i;
  }
}

function toPower(db: number): number {
  return 10 ** (Math.max(Number.isFinite(db) ? db : FLOOR_DB, FLOOR_DB) / 10);
}

function toDb(power: number): number {
  return power <= 0 ? FLOOR_DB : Math.max(FLOOR_DB, 10 * Math.log10(power));
}

function clamp01(x: number): number {
  return Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x));
}

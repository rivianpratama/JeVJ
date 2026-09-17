/**
 * The two loudness events that matter to a visualizer and that no model is
 * fast enough to call: the slam, and the hole that so often precedes it.
 *
 * Jev answers in hundreds of milliseconds, which is fine for "this is a
 * build" and useless for "hit now". So the impact stays here, in a detector
 * that runs on every frame and owes nothing to the network: a short window
 * that is suddenly much louder than the second before it *and* louder than
 * nearly all of the last few seconds, with the bass in it and an onset on it,
 * is a drop. A short window far below the last few seconds is the silence
 * before one.
 *
 * That second condition is the one that stops the detector calling a drop four
 * times a bar. A kick drum satisfies everything else: it is a low-frequency
 * transient, it has an onset on it, and 0.2 s of kick is comfortably more than
 * 6 dB above the second around it, because most of that second is the gap
 * between kicks. What a kick is *not* is louder than the track it is part of —
 * the last kick was exactly this loud, and so was the one before it. Comparing
 * the moment against a high quantile of the last four seconds asks precisely
 * that: is this the loudest thing that has happened lately, or just the latest?
 * The 90th percentile rather than the maximum, so one stray peak — a clipped
 * sample, a crowd noise — cannot immunise the track against the drop that
 * follows it.
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

/**
 * How much louder than the second before it a slam has to be.
 *
 * Against the *mean* of that second, not its quietest moment. A minimum is the
 * bottom of whatever hole the music happened to leave, so on any track with a
 * beat in it the comparison is "loud moment versus gap between loud moments" —
 * which every beat wins. A mean is the level of the passage, and 6 dB over the
 * passage is the four-fold jump in energy that reads as the music arriving.
 * (8 dB over a minimum was the old pair; 6 over a mean is the stricter of the
 * two on a kick track and the more forgiving on a real, dense drop.)
 */
const JUMP_DB = 6;
/** How much of the recent past that mean is taken over. */
const MEAN_WINDOW_SEC = 1;
/** The window "now" is measured over. */
const SHORT_SEC = 0.2;

/**
 * How far above the recent quantile a slam has to stand, and what "recent"
 * and "quantile" mean.
 *
 * 2 dB is deliberately small: this condition is a comparison, not a margin.
 * Either the moment is above almost everything behind it or it is not, and the
 * 2 dB only keeps a tie from counting. Four seconds is two bars at club tempo —
 * long enough to contain the passage the drop is arriving *out of*, short
 * enough that the loud section before a breakdown has rolled off the back by
 * the time the drop lands.
 */
const HEADROOM_DB = 2;
const HEADROOM_WINDOW_SEC = 4;
const HEADROOM_QUANTILE = 0.9;

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
  /** dB above the preceding second's mean. */
  jumpDb?: number;
  /** How much of the preceding audio that mean covers. */
  meanWindowSec?: number;
  /** dB above the preceding quantile. */
  headroomDb?: number;
  /** How far back that quantile is taken over. */
  headroomWindowSec?: number;
  /** The window "now" is measured over. */
  shortSec?: number;
}

export class DropDetector {
  private readonly jumpDb: number;
  private readonly meanWindowSec: number;
  private readonly headroomDb: number;
  private readonly headroomWindowSec: number;
  private readonly shortSec: number;

  /** Per-frame energy, linear. */
  private readonly power = new TimedRing(CAPACITY);
  /** The short-window loudness of each frame, in dB — what the quantile is of. */
  private readonly short = new TimedRing(CAPACITY);
  /** Scratch for the quantile, so the per-frame path allocates nothing. */
  private readonly scratch = new Float64Array(CAPACITY);

  private lastImpactAt = -Infinity;
  private lastGapAt = -Infinity;

  constructor(o: DropOptions = {}) {
    this.jumpDb = o.jumpDb ?? JUMP_DB;
    this.meanWindowSec = o.meanWindowSec ?? MEAN_WINDOW_SEC;
    this.headroomDb = o.headroomDb ?? HEADROOM_DB;
    this.headroomWindowSec = o.headroomWindowSec ?? HEADROOM_WINDOW_SEC;
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

    // The frame just pushed is always inside this window, so it is never empty.
    const now = toDb(this.meanPower(t - this.shortSec, t) ?? 0);
    this.short.push(t, now);

    const impact = this.impact(f, onset, t, now);
    if (impact) return impact;
    return this.gap(t, now);
  }

  /**
   * A slam: louder than the passage it came out of *and* louder than nearly
   * all of the last few seconds, with the bass in it and an onset on it.
   *
   * The cheap tests come first — an onset, the cooldown, the bass share are
   * all reads of numbers already in hand — and the two window statistics are
   * only computed for the frames that get that far.
   */
  private impact(f: FrameFeatures, onset: number, t: number, now: number): DropEvent | null {
    if (onset <= 0) return null;
    if (t - this.lastImpactAt < IMPACT_COOLDOWN_SEC) return null;

    const low = ((f.bands[0] ?? 0) + (f.bands[1] ?? 0)) / 2;
    if (low < LOW_SHARE) return null;

    // Both windows end where the short one begins, so the slam is never part
    // of the thing it is being measured against.
    const before = t - this.shortSec;

    const passage = this.meanPower(before - this.meanWindowSec, before);
    if (passage === null) return null;
    const jump = now - toDb(passage);
    if (jump < this.jumpDb) return null;

    const usual = this.quantileShort(before - this.headroomWindowSec, before, HEADROOM_QUANTILE);
    if (usual === null) return null;
    if (now - usual < this.headroomDb) return null;

    this.lastImpactAt = t;
    // Strength is read off the jump, not off the headroom: the headroom is a
    // yes-or-no question — is this new? — and a drop that clears the recent
    // quantile by 20 dB is not twice the event one that clears it by 10 is.
    // So: how far the jump overshot its threshold, twice it being as hard as
    // this reads, mixed with how much of the hit was bass.
    const rise = clamp01(jump / (2 * this.jumpDb));
    return { t, strength: clamp01(0.6 * rise + 0.4 * clamp01(low)), kind: 'impact' };
  }

  /** A hole: the short window far below the last few seconds. */
  private gap(t: number, now: number): DropEvent | null {
    if (t - this.lastGapAt < GAP_COOLDOWN_SEC) return null;
    if (this.power.countIn(t - GAP_REFERENCE_SEC, t) < 2) return null;

    const reference = toDb(this.meanPower(t - GAP_REFERENCE_SEC, t) ?? 0);
    const depth = reference - now;
    if (depth < GAP_DEPTH_DB) return null;

    this.lastGapAt = t;
    return { t, strength: clamp01(depth / (2 * GAP_DEPTH_DB)), kind: 'gap' };
  }

  /**
   * Mean energy over `(from, to]` — the last `to - from` seconds, exactly —
   * or null when the span holds no frames, which is a span the detector has
   * no opinion about rather than a silent one.
   */
  private meanPower(from: number, to: number): number | null {
    let sum = 0;
    let n = 0;
    for (let i = this.firstAfter(from, this.power); i < this.power.length; i++) {
      if (this.power.timeAt(i) > to) break;
      sum += this.power.valueAt(i);
      n += 1;
    }
    return n === 0 ? null : sum / n;
  }

  /**
   * The `p`-quantile of the short-window loudness over `(from, to]`, in dB, or
   * null when empty. Nearest rank, so the answer is always a level the music
   * actually reached.
   */
  private quantileShort(from: number, to: number, p: number): number | null {
    let n = 0;
    for (let i = this.firstAfter(from, this.short); i < this.short.length; i++) {
      if (this.short.timeAt(i) > to) break;
      this.scratch[n] = this.short.valueAt(i);
      n += 1;
    }
    if (n === 0) return null;

    const slice = this.scratch.subarray(0, n);
    slice.sort();
    return slice[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]!;
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

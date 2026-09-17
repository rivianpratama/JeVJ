/**
 * The cue timeline: what the visuals are to do, and exactly when.
 *
 * Nothing in the app reacts to Jev directly. Three writers — the beat grid,
 * Jev's predictions and the local detector — put cues on this one store, and
 * the renderer asks it a single question every frame: what is true *now*. That
 * indirection is the whole trick behind hitting a drop on the sample. A
 * prediction can be written seconds early and, when the transient actually
 * arrives a frame late, moved (`reanchor`) without anything downstream
 * knowing; an offline pass can write a whole track's cues before playback
 * starts (`replaceSource`); and a model answer that lands 400 ms after the
 * question was asked still lands *at* the instant it was asked about.
 *
 * Three kinds of value live here, and each is read differently:
 *
 * - **mood** is a slow judgment, so it is interpolated between the answers
 *   either side of `now`. In file mode, where every segment's answer is known
 *   in advance, that makes the mood cross-fade across the whole track.
 * - **impact** is a hit. It is not interpolated and never quantized: it fires
 *   at its exact timestamp and decays exponentially (τ = 0.25 s), which is
 *   what makes an unconfirmed prediction fade instead of firing a fake drop.
 * - **build** is a ramp already sampled at the timeline's 0.2 s step, so it is
 *   held: the latest value at or before `now`.
 *
 * Every time here is audio-clock seconds. Pure: no DOM, no Web Audio, no
 * wall clock.
 */

import type { Cue, CueSource, MoodVector, Section } from '../shared/types';

/** The grid the ramps are written on: 200 ms, as the plan specifies. */
const STEP = 0.2;
/** Two cues from one writer this close together are one cue. */
const MERGE_SEC = 0.005;
/** How fast an impact falls away — one time constant per quarter second. */
const IMPACT_TAU = 0.25;
/**
 * How far back `at` bothers to look for an impact. Five time constants is
 * e^-5 ≈ 0.7% of the hit, below anything a renderer can show.
 */
const IMPACT_LOOKBACK = 5 * IMPACT_TAU;
/**
 * How far *before* the predicted instant a cue still counts as the one being
 * re-anchored. The detector confirms a hit it can only measure to within a
 * frame, and a grid beat written 20 ms early is the same beat.
 */
const REANCHOR_TOLERANCE = 0.05;

/** What the renderer reads for one instant. */
export interface CueReading {
  /** Interpolated between the mood-carrying cues either side of `t`. */
  mood: Partial<MoodVector>;
  /** 0..1, decayed from the sharpest hit still ringing. */
  impact: number;
  /** 0..1 anticipation ramp; the latest value written at or before `t`. */
  build: number;
  /** The section last declared at or before `t`, if any. */
  section?: Section;
}

/** Cues that carry a mood: the two model-driven sources. */
function carriesMood(c: Cue): boolean {
  return (c.source === 'jev' || c.source === 'offline') && c.mood !== undefined;
}

export class CueTimeline {
  readonly step = STEP;

  private list: Cue[] = [];

  /**
   * Put a cue on the timeline, keeping it sorted.
   *
   * Cues within 5 ms *from the same source* are merged rather than stacked:
   * one writer saying two things about one instant — a mood and the ramp
   * sample that starts at the same moment, a re-anchored prediction and the
   * strength the detector measured for it — is one cue. Different sources are
   * never merged; the whole point of the source tag is that a measurement and
   * a prediction about the same instant stay distinguishable.
   *
   * The cue is copied, so a caller reusing one object cannot rewrite history.
   */
  add(c: Cue): void {
    const cue: Cue = { ...c };
    const i = this.mergeTarget(cue);
    if (i >= 0) {
      this.list[i] = merge(this.list[i]!, cue);
      return;
    }
    this.list.splice(this.insertionPoint(cue.t), 0, cue);
  }

  /** Everything on the timeline, in time order. Read-only to callers. */
  cues(): readonly Cue[] {
    return this.list;
  }

  /**
   * Drop what has gone by — the live window keeps only the last couple of
   * seconds — except what is still *in force*.
   *
   * The mood, the build level and the section are read as "the latest one at
   * or before now", so the cue that established each of them is still being
   * read however long ago it was written. Dropping it on age alone would
   * silently reset the mood to nothing in the middle of a track, which in file
   * mode — where a segment's mood cue can be minutes behind the playhead — is
   * most of the time. At most three cues survive this way.
   */
  prune(before: number): void {
    const cut = this.insertionPoint(before);
    if (cut <= 0) return;

    let mood: Cue | null = null;
    let build: Cue | null = null;
    let section: Cue | null = null;
    for (let i = 0; i < cut; i++) {
      const c = this.list[i]!;
      if (carriesMood(c)) mood = c;
      if (c.build !== undefined) build = c;
      if (c.section !== undefined) section = c;
    }

    const keep: Cue[] = [];
    for (const c of [mood, build, section]) {
      if (c !== null && !keep.includes(c)) keep.push(c);
    }
    keep.sort((a, b) => a.t - b.t);
    this.list = [...keep, ...this.list.slice(cut)];
  }

  /** Drop whatever a writer no longer believes. */
  remove(predicate: (c: Cue) => boolean): void {
    this.list = this.list.filter((c) => !predicate(c));
  }

  /** What the visuals should be doing at `t`. */
  at(t: number): CueReading {
    const last = this.lastAtOrBefore(t);

    let build = 0;
    let section: Section | undefined;
    let prevMood: Cue | null = null;
    let haveBuild = false;

    for (let i = last; i >= 0; i--) {
      const c = this.list[i]!;
      if (!haveBuild && c.build !== undefined) {
        build = c.build;
        haveBuild = true;
      }
      if (section === undefined && c.section !== undefined) section = c.section;
      if (prevMood === null && carriesMood(c)) prevMood = c;
      if (haveBuild && section !== undefined && prevMood !== null) break;
    }

    let nextMood: Cue | null = null;
    for (let i = last + 1; i < this.list.length; i++) {
      const c = this.list[i]!;
      if (carriesMood(c)) {
        nextMood = c;
        break;
      }
    }

    return {
      mood: blend(prevMood, nextMood, t),
      impact: this.impactAt(t, last),
      build,
      ...(section === undefined ? {} : { section }),
    };
  }

  /** The cues due in the next `horizon` seconds, in time order. */
  upcoming(now: number, horizon: number): Cue[] {
    const out: Cue[] = [];
    for (let i = this.insertionPoint(now); i < this.list.length; i++) {
      const c = this.list[i]!;
      if (c.t > now + horizon) break;
      out.push({ ...c });
    }
    return out;
  }

  /**
   * Hand one source's future back to it: everything it wrote at or after
   * `from` goes, and `cues` takes its place. What it wrote *before* `from`
   * stays — those cues already happened — and what other sources wrote is
   * none of its business.
   */
  replaceSource(source: CueSource, from: number, cues: Cue[]): void {
    this.remove((c) => c.source === source && c.t >= from);
    for (const c of cues) this.add(c);
  }

  /**
   * The hit landed at `actualT`, not at `predictedT`: move the prediction, and
   * everything predicted with it.
   *
   * Only `jev` and `grid` cues move. Those are the two sources that guessed;
   * a `detector` cue is a measurement and an `offline` cue is a fact about the
   * file, and neither becomes less true because a later measurement disagreed.
   * Cues slightly *before* the predicted instant move too — see
   * `REANCHOR_TOLERANCE`.
   */
  reanchor(predictedT: number, actualT: number): void {
    const delta = actualT - predictedT;
    if (delta === 0 || !Number.isFinite(delta)) return;

    const from = predictedT - REANCHOR_TOLERANCE;
    let moved = false;
    for (const c of this.list) {
      if (c.t < from) continue;
      if (c.source !== 'jev' && c.source !== 'grid') continue;
      c.t += delta;
      moved = true;
    }
    // A shifted suffix can cross the cues that did not move, so order is only
    // guaranteed again once the list is re-sorted.
    if (moved) this.list.sort((a, b) => a.t - b.t);
  }

  /** The strongest impact still ringing at `t`, decayed from its own instant. */
  private impactAt(t: number, last: number): number {
    let out = 0;
    for (let i = last; i >= 0; i--) {
      const c = this.list[i]!;
      const age = t - c.t;
      if (age > IMPACT_LOOKBACK) break;
      if (c.impact === undefined) continue;
      out = Math.max(out, c.impact * Math.exp(-Math.max(0, age) / IMPACT_TAU));
    }
    return out;
  }

  /** Index of the last cue at or before `t`, or -1 when there is none. */
  private lastAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid]!.t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  /** The index `t` would be inserted at: the first cue with `cue.t >= t`. */
  private insertionPoint(t: number): number {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid]!.t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The cue `c` should be folded into, or -1 when it is news. */
  private mergeTarget(c: Cue): number {
    const from = this.insertionPoint(c.t - MERGE_SEC);
    for (let i = from; i < this.list.length; i++) {
      const other = this.list[i]!;
      if (other.t > c.t + MERGE_SEC) break;
      if (other.source === c.source) return i;
    }
    return -1;
  }
}

/**
 * Two cues about the same instant, as one.
 *
 * The newer value wins everywhere except `impact`, which takes the *louder* of
 * the two: when the detector confirms a predicted hit it writes what it
 * measured onto the prediction, and a measurement that under-reads a slam the
 * model called hard should not talk it down.
 */
function merge(a: Cue, b: Cue): Cue {
  const out: Cue = { ...a, ...b, t: a.t, source: a.source };
  if (a.mood !== undefined || b.mood !== undefined) out.mood = { ...a.mood, ...b.mood };
  if (a.impact !== undefined || b.impact !== undefined) {
    out.impact = Math.max(a.impact ?? 0, b.impact ?? 0);
  }
  return out;
}

/**
 * The mood at `t`, between the answers either side of it.
 *
 * Numbers are interpolated; labels and their probability maps are not — you
 * cannot be half in `drop_climax` — so a label holds until the cue that
 * carries the new one is actually reached.
 */
function blend(a: Cue | null, b: Cue | null, t: number): Partial<MoodVector> {
  if (a === null) return b === null ? {} : { ...b.mood };
  if (b === null) return { ...a.mood };

  const span = b.t - a.t;
  const w = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 1;
  const out: Record<string, unknown> = { ...a.mood };

  for (const [key, to] of Object.entries(b.mood ?? {})) {
    const from = (a.mood as Record<string, unknown> | undefined)?.[key];
    if (typeof to === 'number' && typeof from === 'number') out[key] = from + (to - from) * w;
    else if (w >= 1 || from === undefined) out[key] = to;
  }
  return out as unknown as Partial<MoodVector>;
}

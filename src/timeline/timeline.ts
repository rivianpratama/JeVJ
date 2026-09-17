/**
 * The cue timeline: what the visuals are to do, and exactly when.
 *
 * Nothing in the app reacts to Jev directly. Three writers — the beat grid,
 * the offline pass's verdicts and the local detector — put cues on this one
 * store, and
 * the renderer asks it a single question every frame: what is true *now*. That
 * indirection is the whole trick behind hitting a drop on the sample. A
 * prediction can be written seconds early and, when the transient actually
 * arrives a frame late, moved (`reanchor`) without anything downstream
 * knowing; an offline pass can write a whole track's cues before playback
 * starts (`replaceSource`); and a model answer that lands 400 ms after the
 * question was asked is still written at the instant it was asked about,
 * because a writer is handed the time of the music, not of the reply.
 *
 * **One clock, and one place where it is corrected.** Every time written here
 * is *analysis time*: the audio clock as the analysis chain sees it, which
 * runs late relative to what the listener hears by the detector's reporting
 * lag. Frames, onsets, grid predictions, detector events and the Jev cues the
 * offline pass wrote are all on that one clock, so they can be compared
 * without anybody subtracting anything. No writer compensates. The *reader*
 * does it once — `src/app/cueReader.ts` asks for `now + latencySec` — which is
 * the only place the two clocks ever meet.
 *
 * Three kinds of value live here, and each is read differently:
 *
 * - **mood** is a slow judgment, so it is interpolated between the answers
 *   either side of `now`. In file mode, where every segment's answer is known
 *   in advance, that makes the mood cross-fade across the whole track.
 * - **impact** is a hit. It is not interpolated and never quantized: it fires
 *   at its exact timestamp and decays exponentially (τ = 0.25 s), which is
 *   what makes an unconfirmed prediction fade instead of firing a fake drop.
 * - **build** is a ramp, so it is interpolated between the two cues either
 *   side of `now` and falls back to nothing once the ramp is over. Every
 *   writer that opens a ramp closes it. Crucially the channel is read *per
 *   source* and then maxed: Jev's two-bar anticipation and the hole the
 *   detector just punched through the middle of it are two ramps, not one
 *   sequence of cues, and one writer's release must not notch another
 *   writer's climb. See `buildAt`.
 *
 * Pure: no DOM, no Web Audio, no wall clock.
 */

import type { Cue, CueSource, MoodVector, Section, TransitionKind } from '../shared/types';

/** The grid the ramps are written on: 200 ms, as the plan specifies. */
const STEP = 0.2;
/** Two cues from one writer this close together are one cue. */
const MERGE_SEC = 0.005;
/**
 * How fast an impact falls away — and why that is not one number.
 *
 * A quarter-second time constant is right for a clap and wrong for a slam. The
 * two are the same *event* to this file, differing only in the `impact` on the
 * cue, and decaying both at 0.25 s meant the biggest hit in a track was over
 * in about a second — the picture flashed and went back to what it was doing
 * while the room was still ringing, which is the "the hit is too short"
 * complaint word for word.
 *
 * So the sustain scales with the hit: `0.25 + 0.5·intensity`, which is a
 * quarter-second for something barely there and three quarters for an
 * overwhelming slam. It is the intensity the model gave the moment, so a
 * *named* drop rings longer than an unnamed transient of the same loudness,
 * which is the right way round.
 */
const IMPACT_TAU_BASE = 0.25;
const IMPACT_TAU_SPAN = 0.5;

/** The time constant a hit of this strength falls away over. */
export function impactTau(intensity: number): number {
  const i = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  return IMPACT_TAU_BASE + IMPACT_TAU_SPAN * i;
}

/**
 * How far back `at` bothers to look for an impact. Five time constants is
 * e^-5 ≈ 0.7% of the hit, below anything a renderer can show — taken at the
 * *longest* constant, since a quiet hit that has already faded costs one
 * comparison to skip and a loud one that has not must not be skipped.
 */
const IMPACT_LOOKBACK = 5 * impactTau(1);
/**
 * How far *before* the predicted instant a cue still counts as the one being
 * re-anchored. The detector confirms a hit it can only measure to within a
 * frame, and a grid beat written 20 ms early is the same beat.
 */
const REANCHOR_TOLERANCE = 0.05;
/**
 * How long a build value stands with nothing written after it: one step, the
 * distance between two samples of a live ramp. Past that the ramp is over and
 * the build is nothing — an anticipation nobody is renewing is not an
 * anticipation, and a `1` left standing would pin the visuals at full tension
 * for the rest of the track.
 */
const BUILD_HOLD_SEC = STEP;
/**
 * The widest two build cues may be apart and still be read as one ramp. No
 * writer draws a ramp with a wider gap in it — 0.2 s steps, and a beat for a
 * hole's release — so past this the two cues are about different moments, and
 * sliding between them would tighten the visuals for half a minute into a
 * hole nobody can hear coming yet.
 */
const BUILD_SPAN_MAX = 2;

/** What the renderer reads for one instant. */
export interface CueReading {
  /** Interpolated between the mood-carrying cues either side of `t`. */
  mood: Partial<MoodVector>;
  /** 0..1, decayed from the sharpest hit still ringing. */
  impact: number;
  /** 0..1 anticipation ramp, interpolated between the cues either side of `t`. */
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
   * Where the mood and section cues are, so a read does not have to walk back
   * to the top of the track to find them. Both are read as "the latest one at
   * or before now" and neither has a window to bound the search — in file mode
   * the whole track is on the timeline and there may be no section cue at all,
   * which is an O(n) walk sixty times a second. Built on demand, thrown away
   * by every mutation: writers touch the list a few times a tick and the
   * renderer reads it every frame, so rebuilding is the cheap side.
   */
  private idx: { mood: number[]; section: number[] } | null = null;

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
    this.idx = null;

    const i = this.mergeTarget(cue);
    if (i >= 0) {
      const merged = merge(this.list[i]!, cue);
      this.list[i] = merged;
      // A merge can move the cue by up to 5 ms — onto the hit, when one of the
      // two is one — and 5 ms is enough to cross a neighbour from another
      // source.
      const behind = (this.list[i - 1]?.t ?? -Infinity) > merged.t;
      const ahead = (this.list[i + 1]?.t ?? Infinity) < merged.t;
      if (behind || ahead) this.list.sort((a, b) => a.t - b.t);
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
   * The mood and the section are read as "the latest one at or before now", so
   * the cue that established each of them is still being read however long ago
   * it was written. Dropping it on age alone would silently reset the mood to
   * nothing in the middle of a track, which in file mode — where a segment's
   * mood cue can be minutes behind the playhead — is most of the time.
   *
   * A build cue is the left-hand end of the ramp running through now, and
   * ramps are read *per source* (`buildAt`), so one survivor for the whole
   * channel is not enough: a hole the detector released just before the cutoff
   * would be kept and the anchor of the Jev ramp climbing underneath it thrown
   * away, and that ramp would read nothing until its next sample landed. One
   * per source, then — but only while it could still be read at all. Past
   * `BUILD_SPAN_MAX` nothing can interpolate with it and nothing holds that
   * long, so an old ramp anchor is not kept alive for a source that has gone
   * quiet.
   */
  prune(before: number): void {
    const cut = this.insertionPoint(before);
    if (cut <= 0) return;
    this.idx = null;

    let mood: Cue | null = null;
    let section: Cue | null = null;
    const builds = new Map<CueSource, Cue>();
    for (let i = 0; i < cut; i++) {
      const c = this.list[i]!;
      if (carriesMood(c)) mood = c;
      if (c.section !== undefined) section = c;
      if (c.build !== undefined && before - c.t <= BUILD_SPAN_MAX) builds.set(c.source, c);
    }

    const keep: Cue[] = [];
    for (const c of [mood, section, ...builds.values()]) {
      if (c !== null && !keep.includes(c)) keep.push(c);
    }
    keep.sort((a, b) => a.t - b.t);
    this.list = [...keep, ...this.list.slice(cut)];
  }

  /** Drop whatever a writer no longer believes. */
  remove(predicate: (c: Cue) => boolean): void {
    this.idx = null;
    this.list = this.list.filter((c) => !predicate(c));
  }

  /** What the visuals should be doing at `t`. */
  at(t: number): CueReading {
    const last = this.lastAtOrBefore(t);
    const index = this.index();

    const prevMood = this.list[indexBefore(index.mood, last)] ?? null;
    const nextMood = this.list[indexAfter(index.mood, last)] ?? null;
    const section = this.list[indexBefore(index.section, last)]?.section;

    return {
      mood: blend(prevMood, nextMood, t),
      impact: this.impactAt(t, last),
      build: this.buildAt(t, last),
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
   * The transition kinds of every cue whose instant falls in `(from, to]`,
   * appended to `out`.
   *
   * This is how a *seam* reaches the visuals at all. Everything else the
   * renderer reads off this timeline is a level — the mood is interpolated, the
   * impact is decayed, the build is a ramp — and a level cannot say "a drop
   * happened just now, once". The director's one-shot flourishes and its spin
   * reversal need exactly that, so they are read as the half-open interval
   * between the last frame's instant and this one's: every cue is seen once, by
   * exactly one frame, however long the frames are.
   *
   * `out` is filled rather than returned, because this runs every frame and the
   * usual answer is nothing at all.
   */
  transitionsIn(from: number, to: number, out: TransitionKind[]): void {
    if (!(to > from)) return;
    for (let i = this.insertionPoint(from); i < this.list.length; i++) {
      const c = this.list[i]!;
      if (c.t > to) break;
      // Half-open: `insertionPoint` lands on the first cue at or after `from`,
      // and a cue exactly at `from` was this interval's predecessor's.
      if (c.t <= from) continue;
      if (c.transition !== undefined) out.push(c.transition);
    }
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
    if (moved) {
      this.idx = null;
      this.list.sort((a, b) => a.t - b.t);
    }
  }

  /**
   * The build at `t`: every source's own ramp, and the loudest of them wins.
   *
   * The build channel is shared but the ramps on it are not. Jev draws a two-
   * bar anticipation while the detector punches a hole in the middle of it and
   * releases a beat later; read as one sequence of cues, that release would
   * notch Jev's ramp down to nothing and the hole's own `build: 1` would be
   * lost whenever it landed on a ramp sample. So each source is interpolated
   * against its own cues — a release ends its own ramp and nobody else's — and
   * the reading is the maximum. Tension from two writers at once is still
   * tension.
   *
   * Both scans are bounded: a cue further than `BUILD_SPAN_MAX` from `t`
   * cannot contribute, because it is too far to interpolate with and too old
   * to hold.
   */
  private buildAt(t: number, last: number): number {
    const prev = new Map<CueSource, Cue>();
    const next = new Map<CueSource, Cue>();

    for (let i = last; i >= 0; i--) {
      const c = this.list[i]!;
      if (t - c.t > BUILD_SPAN_MAX) break;
      if (c.build !== undefined && !prev.has(c.source)) prev.set(c.source, c);
    }
    for (let i = last + 1; i < this.list.length; i++) {
      const c = this.list[i]!;
      if (c.t - t > BUILD_SPAN_MAX) break;
      if (c.build !== undefined && !next.has(c.source)) next.set(c.source, c);
    }

    let out = 0;
    for (const [source, a] of prev) out = Math.max(out, rampAt(a, next.get(source) ?? null, t));
    return out;
  }

  /** The strongest impact still ringing at `t`, decayed from its own instant. */
  private impactAt(t: number, last: number): number {
    let out = 0;
    for (let i = last; i >= 0; i--) {
      const c = this.list[i]!;
      const age = t - c.t;
      if (age > IMPACT_LOOKBACK) break;
      if (c.impact === undefined) continue;
      out = Math.max(out, c.impact * Math.exp(-Math.max(0, age) / impactTau(c.impact)));
    }
    return out;
  }

  /** The mood and section positions, built if a mutation has thrown them away. */
  private index(): { mood: number[]; section: number[] } {
    if (this.idx !== null) return this.idx;

    const mood: number[] = [];
    const section: number[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i]!;
      if (carriesMood(c)) mood.push(i);
      if (c.section !== undefined) section.push(i);
    }
    this.idx = { mood, section };
    return this.idx;
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
  // The hit's own instant wins. A ramp's last sample can land three
  // milliseconds before the target it was drawn for, and folding the hit into
  // it would fire the drop three milliseconds early — small, but it is exactly
  // the error this whole file exists to avoid. Everything else is a judgment
  // about "around here" and can take the earlier stamp.
  const t = a.impact === undefined && b.impact !== undefined ? b.t : a.t;
  const out: Cue = { ...a, ...b, t, source: a.source };
  if (a.mood !== undefined || b.mood !== undefined) out.mood = { ...a.mood, ...b.mood };
  if (a.impact !== undefined || b.impact !== undefined) {
    out.impact = Math.max(a.impact ?? 0, b.impact ?? 0);
  }
  return out;
}

/**
 * The last entry of `positions` that is at or before `i`, or -1.
 *
 * `positions` is sorted, so this is a binary search: the point of the index is
 * that neither the length of the track nor the distance back to the last mood
 * cue costs a read anything.
 */
function indexBefore(positions: number[], i: number): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid]! <= i) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1 >= 0 ? positions[lo - 1]! : -1;
}

/** The first entry of `positions` after `i`, or -1. */
function indexAfter(positions: number[], i: number): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid]! <= i) lo = mid + 1;
    else hi = mid;
  }
  return lo < positions.length ? positions[lo]! : -1;
}

/**
 * One source's build at `t`: a ramp, read between its cues either side of it.
 *
 * A writer samples a ramp every 0.2 s, but the renderer draws at 60 fps, so
 * holding the last sample would step the anticipation up in visible stairs.
 * Between two cues the value slides; the step only sets how often a writer has
 * to say something.
 *
 * Nothing after `a` means the ramp is over: the value stands for one step —
 * long enough that a live ramp being written one sample at a time never
 * flickers — and is then nothing. That is what makes every ramp terminate,
 * and it is why each writer closes its own: a `build: 0` after the hit, a
 * release a beat after a hole.
 */
function rampAt(a: Cue | null, b: Cue | null, t: number): number {
  if (a === null || a.build === undefined) return 0;
  if (b?.build !== undefined && b.t - a.t <= BUILD_SPAN_MAX) {
    const span = b.t - a.t;
    const w = span > 0 ? (t - a.t) / span : 1;
    return a.build + (b.build - a.build) * Math.min(1, Math.max(0, w));
  }
  return t - a.t <= BUILD_HOLD_SEC ? a.build : 0;
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

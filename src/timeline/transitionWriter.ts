/**
 * A named moment, turned into instructions with timestamps.
 *
 * v1 had a second writer next to this one for a *live* prediction, where the
 * interesting problem was *when*: a model answering in half a second cannot be
 * trusted with an instant, so its "a drop in eight beats" had to be resolved
 * against the beat grid and snapped to a phrase boundary. v2 does not predict —
 * the whole track is judged before a note of it plays — so that writer is gone
 * and this one is the only one. Here the instant is already known to the
 * sample: the candidate finder took it off the detector or off a novelty peak
 * in a file we have all of. What is not known is *what it is*, and that is what
 * the verdict carries. So this writer has the opposite shape: no snapping, no
 * prediction, one rule per kind.
 *
 * Every rule is specified in the plan and every one of them is a claim about
 * what the visuals should do:
 *
 * - **drop** gets the hit at the exact instant, the intensity as its impact,
 *   and a two-bar anticipation ramp in front of it. The ramp is the whole
 *   reason a pre-analysis exists: live, the tension can only start when the
 *   model has spoken, which is after the build has already begun; offline it
 *   starts exactly two bars out, every time.
 * - **breakdown** and **quiet_fall** pull the arousal down for two bars and
 *   put it back. A relative adjustment needs something to be relative *to*,
 *   which is why the context carries the mood pass 1 left in force here: the
 *   cue written is absolute, so the timeline can interpolate it, and the
 *   restoring cue two bars later is what keeps the adjustment an event rather
 *   than a permanent re-scoring of the rest of the track.
 * - **break_silence** opens full tension at the hole and closes it on the
 *   return, with a hit there only if the energy actually came back.
 * - **scream_peak** is the one kind with a floor under its impact: a scream
 *   the model called mild is still a scream, and 0.8 is what that is worth.
 * - **tempo_change** and **key_change** touch nothing but tension. They are
 *   real events and they are not *section* boundaries, and writing a section
 *   for them would restart the phrase count in the middle of a passage.
 *
 * And anything the model called dramatic — a jolt, goosebumps, a held breath —
 * also sets `flourish`, which is the Director's cue to fire a one-shot.
 *
 * Every cue is written at source `jev`: these are the model's judgments, and
 * they share a build channel with each other rather than with the detector's
 * holes. `CueTimeline` reads each source's ramp separately for exactly that
 * reason — a hole the detector punched in the middle of an anticipation ramp
 * spikes and falls back onto the ramp instead of notching through it.
 *
 * Pure: a timeline, a time, a verdict and the context, in.
 */

import type { CueTimeline } from './timeline';
import type { Cue, MoodVector, TransitionVerdict } from '../shared/types';

/** Bars of anticipation in front of a drop. */
const RAMP_BARS = 2;
/** Bars an arousal or tension adjustment stands for. */
const ADJUST_BARS = 2;
/** Bars a scream's aggression stands for. */
const AGGRESSION_BARS = 1;
/** How far the arousal falls into a breakdown, and tension rises at a change. */
const AROUSAL_DROP = 0.3;
const TENSION_RISE = 0.2;
/** How much more space a voice puts around the music. */
const SPACE_RISE = 0.2;
/** The least impact a scream is worth, whatever the model said. */
const SCREAM_FLOOR = 0.8;
/** How far a hole's energy has to come back for the return to be a hit. */
const RETURN_JUMP_DB = 6;
/** Above this, Jev called the moment a jolt and the Director fires a flourish. */
const DRAMATIC = 0.6;
/** A sane bar when the grid never locked, so a ramp is still drawn. */
const FALLBACK_BAR_SEC = 2;

export interface TransitionContext {
  /** Seconds in a bar here. A grid that never locked falls back to 2 s. */
  barSec: number;
  /**
   * The mood pass 1 left in force at this instant — what a relative
   * adjustment adjusts, and what the restoring cue puts back.
   */
  mood: MoodVector;
  /**
   * The detector's exact instant, refined to the sample, when one of them found
   * this moment.
   *
   * `drop` and `scream_peak` land on this and not on `at` wherever it exists,
   * and the difference is audible. `at` is the *candidate's* time, which has
   * been through the dedupe: several rules fire on one moment by design and the
   * one that wins on novelty contributes its own timestamp, which may be a
   * payload sample taken half a second away. For a mood that does not matter.
   * For the instant a hit lands on it is the whole thing.
   */
  detectorT?: number;
  /** Loudness change across the moment, in dB. */
  jumpDb?: number;
  /** When the music comes back after a hole. Defaults to one bar later. */
  returnT?: number;
}

/**
 * Write the cues one verdict calls for.
 *
 * `at` is the candidate's own time, which came through the dedupe and may be a
 * payload sample rather than a transient. Anything that has to land *on the
 * sample* — the two kinds a listener would clap along with, `drop` and
 * `scream_peak` — uses `ctx.detectorT` instead wherever there is one. The rest
 * keep `at`: a hole's edge, a voice arriving, a key moving are all things that
 * happen over a bar, and there is no attack in the envelope to snap them to.
 */
export function writeTransitionCues(
  tl: CueTimeline,
  at: number,
  verdict: TransitionVerdict,
  ctx: TransitionContext,
): void {
  const bar = ctx.barSec > 0 && Number.isFinite(ctx.barSec) ? ctx.barSec : FALLBACK_BAR_SEC;
  const hit = ctx.detectorT ?? at;
  const flourish = verdict.dramatic >= DRAMATIC;
  const mark = (c: Cue): void => tl.add({ ...c, transition: verdict.kind, ...(flourish ? { flourish: true } : {}) });

  switch (verdict.kind) {
    case 'drop': {
      rampTo(tl, hit, bar * RAMP_BARS, tl.step);
      mark({ t: hit, source: 'jev', impact: verdict.intensity, build: 1, section: 'drop_climax' });
      tl.add({ t: hit + tl.step, source: 'jev', build: 0 });
      return;
    }

    case 'build_start': {
      mark({ t: at, source: 'jev', section: 'build' });
      return;
    }

    case 'breakdown':
    case 'quiet_fall': {
      mark({
        t: at,
        source: 'jev',
        section: 'breakdown',
        mood: { arousal: clamp(ctx.mood.arousal - AROUSAL_DROP) },
      });
      tl.add({ t: at + ADJUST_BARS * bar, source: 'jev', mood: { arousal: ctx.mood.arousal } });
      return;
    }

    case 'break_silence': {
      mark({ t: at, source: 'jev', build: 1 });
      const back = ctx.returnT ?? at + bar;
      const jumped = (ctx.jumpDb ?? 0) >= RETURN_JUMP_DB;
      tl.add({
        t: back,
        source: 'jev',
        build: 0,
        transition: verdict.kind,
        ...(jumped ? { impact: verdict.intensity, ...(flourish ? { flourish: true } : {}) } : {}),
      });
      return;
    }

    case 'vocal_entry': {
      // No restoring cue and none specified: a voice is a thing that stays,
      // and the next segment's mood cue is what takes the space back.
      mark({
        t: at,
        source: 'jev',
        mood: { space: clamp(ctx.mood.space + SPACE_RISE), motion: 'pulse' },
      });
      return;
    }

    case 'scream_peak': {
      mark({
        t: hit,
        source: 'jev',
        impact: Math.max(verdict.intensity, SCREAM_FLOOR),
        mood: { aggression: 1 },
      });
      tl.add({ t: hit + AGGRESSION_BARS * bar, source: 'jev', mood: { aggression: ctx.mood.aggression } });
      return;
    }

    case 'tempo_change':
    case 'key_change': {
      mark({ t: at, source: 'jev', mood: { tension: clamp(ctx.mood.tension + TENSION_RISE) } });
      tl.add({ t: at + ADJUST_BARS * bar, source: 'jev', mood: { tension: ctx.mood.tension } });
      return;
    }

    case 'none':
      return;
  }
}

/**
 * A 0→1 ramp over the `span` seconds before `target`, sampled every `step`.
 *
 * The last sample before the target is written, the target itself is not: the
 * caller writes that one, with the hit on it. A ramp that would start before
 * the top of the track is cut rather than shifted — the anticipation is two
 * bars long or it is however much track there is.
 */
function rampTo(tl: CueTimeline, target: number, span: number, step: number): void {
  const start = Math.max(0, target - span);
  const length = target - start;
  if (!(length > 0)) return;
  for (let t = start; t < target - 1e-9; t += step) {
    tl.add({ t, source: 'jev', build: (t - start) / length });
  }
}

function clamp(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

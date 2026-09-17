import { describe, expect, it } from 'vitest';
import {
  DPR_STEPS,
  FAST_HOLD_SEC,
  FAST_MS,
  SLOW_HOLD_SEC,
  SLOW_MS,
  STEP_COOLDOWN_SEC,
  createDprState,
  stepDpr,
  type DprState,
} from '../../src/visuals/dprGovernor';

const FRAME = 1 / 60;

/** Run `seconds` of frames at a steady cost, and return the cap at the end. */
function run(s: DprState, seconds: number, frameMs: number, playing = true): number {
  let cap = s.cap;
  for (let i = 0; i < Math.round(seconds / FRAME); i++) {
    cap = stepDpr(s, { dt: FRAME, frameMs, playing });
  }
  return cap;
}

describe('stepDpr', () => {
  it('starts at the full pixel ratio', () => {
    expect(createDprState().cap).toBe(DPR_STEPS[DPR_STEPS.length - 1]);
    expect(DPR_STEPS).toEqual([1, 1.25, 1.5]);
  });

  it('holds while the frame time is comfortable', () => {
    const s = createDprState();
    expect(run(s, 60, 8)).toBe(1.5);
  });

  it('gives up a step after three seconds of slow frames', () => {
    const s = createDprState();
    // Under the hold: the reading is smoothed, so it takes a moment to be
    // believed at all, and then three seconds of believing it.
    expect(run(s, 2, 24)).toBe(1.5);
    expect(run(s, 2, 24)).toBe(1.25);
  });

  it('takes one step at a time, no faster than one per ten seconds', () => {
    const s = createDprState();
    run(s, 5, 24);
    expect(s.cap).toBe(1.25);
    // Still slow, but the last change was moments ago: up to a second short of
    // the cooldown, nothing moves.
    expect(run(s, STEP_COOLDOWN_SEC - 1 - s.sinceChange, 24)).toBe(1.25);
    expect(run(s, 2, 24)).toBe(1);
  });

  it('will not go below the smallest step however slow the machine is', () => {
    const s = createDprState();
    run(s, 120, 40);
    expect(s.cap).toBe(1);
  });

  it('gives a step back after ten seconds of comfortable frames', () => {
    const s = createDprState();
    run(s, 5, 24);
    expect(s.cap).toBe(1.25);

    // Nine seconds of comfort is not enough, ten is.
    expect(run(s, 9, 8)).toBe(1.25);
    expect(run(s, 2, 8)).toBe(1.5);
  });

  it('holds between the two thresholds rather than hunting', () => {
    const s = createDprState();
    const between = (SLOW_MS + FAST_MS) / 2;
    expect(run(s, 60, between)).toBe(1.5);

    // And from below, too: a machine that was demoted is not promoted back on
    // a reading that is merely not slow.
    const demoted = createDprState();
    run(demoted, 5, 24);
    expect(run(demoted, 60, between)).toBe(1.25);
  });

  it('counts nothing while there is no audio', () => {
    const s = createDprState();
    expect(run(s, 60, 24, false)).toBe(1.5);
    expect(s.slowFor).toBe(0);
  });

  it('holds its average over a frame it could not measure', () => {
    const s = createDprState();
    run(s, 2, 24);
    const before = s.frameMs;
    stepDpr(s, { dt: FRAME, frameMs: Number.NaN, playing: true });
    expect(s.frameMs).toBe(before);
  });

  it('needs a real sample before it decides anything', () => {
    const s = createDprState();
    for (let i = 0; i < 600; i++) stepDpr(s, { dt: FRAME, frameMs: Number.NaN, playing: true });
    expect(s.cap).toBe(1.5);
    expect(s.seeded).toBe(false);
  });

  it('survives a step the page was frozen through', () => {
    const s = createDprState();
    // A tab that comes back after a minute must not demote on one huge dt.
    const cap = stepDpr(s, { dt: 60, frameMs: 24, playing: true });
    expect(cap).toBe(1.5);
    expect(s.slowFor).toBeLessThanOrEqual(SLOW_HOLD_SEC);
    expect(FAST_HOLD_SEC).toBe(10);
  });
});

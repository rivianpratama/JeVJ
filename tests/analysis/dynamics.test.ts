import { describe, expect, it } from 'vitest';
import { DynamicsTracker } from '../../src/analysis/dynamics';

/** The rate the analysis loop pushes frames at. */
const FPS = 60;
const STEP = 1 / FPS;

/** `seconds` more loudness from `from`, `db(t)` deciding what each frame reads. */
function feed(
  tracker: DynamicsTracker,
  from: number,
  seconds: number,
  db: (t: number) => number,
): DynamicsTracker {
  for (let i = 0; i * STEP <= seconds; i++) {
    const t = from + i * STEP;
    tracker.push(db(t), t);
  }
  return tracker;
}

/** A fresh tracker fed `seconds` of loudness starting at t = 0. */
function run(seconds: number, db: (t: number) => number): DynamicsTracker {
  return feed(new DynamicsTracker(), 0, seconds, db);
}

describe('DynamicsTracker trend', () => {
  it('calls a six-second crescendo building', () => {
    const tracker = run(6, (t) => -40 + 30 * (t / 6));

    expect(tracker.trend()).toBe('building');
  });

  it('calls the same ramp downhill fading', () => {
    const tracker = run(6, (t) => -10 - 30 * (t / 6));

    expect(tracker.trend()).toBe('fading');
  });

  it('calls a flat level steady', () => {
    expect(run(6, () => -20).trend()).toBe('steady');
  });

  it('has no trend before it has heard enough to have one', () => {
    expect(new DynamicsTracker().trend()).toBe('steady');
  });
});

describe('DynamicsTracker range', () => {
  it('is wide when the music swings fifty decibels', () => {
    // Half a second loud, half a second quiet, for twenty seconds.
    const tracker = run(20, (t) => (Math.floor(t * 2) % 2 === 0 ? -10 : -60));

    expect(tracker.range()).toBeGreaterThan(0.8);
  });

  it('is near zero when nothing moves', () => {
    expect(run(20, () => -18).range()).toBeLessThan(0.05);
  });
});

describe('DynamicsTracker loudClass', () => {
  it('reads pp once a long quiet passage follows a loud one', () => {
    const tracker = run(20, () => -10);
    feed(tracker, 20, 20, () => -40);

    expect(tracker.loudClass()).toBe('pp');
  });

  it('reads ff at the top of the session range', () => {
    const tracker = run(20, () => -40);
    feed(tracker, 20, 20, () => -10);

    expect(tracker.loudClass()).toBe('ff');
  });

  it('sits in the middle when there is no range to sit in', () => {
    expect(run(5, () => -20).loudClass()).toBe('mf');
  });
});

describe('DynamicsTracker crest', () => {
  it('is near zero for a level signal and rises with peaks', () => {
    expect(run(4, () => -20).crest()).toBeLessThan(0.05);

    // One frame in ten twelve decibels above the rest.
    const peaky = run(4, (t) => (Math.round(t * FPS) % 10 === 0 ? -8 : -20));
    expect(peaky.crest()).toBeGreaterThan(0.2);
  });
});

describe('DynamicsTracker slopeDb', () => {
  it('measures the change over a number of bars', () => {
    const tracker = run(12, (t) => -40 + 2.5 * t); // 2.5 dB a second

    // Four bars of two seconds each: eight seconds, so twenty decibels.
    expect(tracker.slopeDb(4, 2, 12)).toBeGreaterThan(19);
    expect(tracker.slopeDb(4, 2, 12)).toBeLessThan(21);
    // Rounded to one decimal, as the mood input wants it.
    expect(tracker.slopeDb(4, 2, 12) * 10).toBeCloseTo(Math.round(tracker.slopeDb(4, 2, 12) * 10), 6);
  });

  it('is zero when there is nothing that far back', () => {
    expect(run(1, () => -20).slopeDb(8, 2, 1)).toBe(0);
  });
});

describe('DynamicsTracker gap', () => {
  it('finds a hole in the last beat', () => {
    // Steady -20 dB, with the floor dropping out for 0.2 s mid-beat.
    const tracker = run(8, (t) => (t >= 7.6 && t < 7.8 ? -35 : -20));

    expect(tracker.gap(8, 0.5)).toBe(true);
  });

  it('does not find one in steady music', () => {
    expect(run(8, () => -20).gap(8, 0.5)).toBe(false);
  });

  it('ignores a hole that has already gone by', () => {
    const tracker = run(8, (t) => (t >= 5.0 && t < 5.2 ? -35 : -20));

    expect(tracker.gap(8, 0.5)).toBe(false);
  });
});

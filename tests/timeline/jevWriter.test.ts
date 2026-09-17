import { describe, expect, it } from 'vitest';
import { BeatGrid, type GridState } from '../../src/analysis/grid';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { CueTimeline } from '../../src/timeline/timeline';
import { writeJevCues, type GridLike } from '../../src/timeline/jevWriter';
import type { MoodVector } from '../../src/shared/types';

/** A real 120 BPM grid ticked to `now`, with downbeats on the even seconds. */
function grid120(now: number): BeatGrid {
  const grid = new BeatGrid();
  grid.onOnset(1.5, 1, 1);
  grid.setTempo({ bpm: 120, period: 0.5, confidence: 0.9, marking: 'allegro' }, 1.5);
  grid.tick(now);
  return grid;
}

/** A grid with the phrase count set where the test needs it. */
function fakeGrid(o: {
  period: number;
  nextBeat: number;
  /** Which predicted step (0-based, from `now`) is the first downbeat. */
  firstDownbeatStep: number;
  barsSinceChange: number;
}): GridLike {
  return {
    state: (): GridState => ({
      bpm: 60 / o.period,
      period: o.period,
      nextBeat: o.nextBeat,
      beatIndex: 0,
      barLength: 4,
      downbeatOffset: 0,
      barsSinceChange: o.barsSinceChange,
      barInPhrase: o.barsSinceChange % 16,
      confidence: 0.9,
    }),
    predict: (count: number, now: number) => {
      const out: Array<{ t: number; downbeat: boolean }> = [];
      const first = Math.max(0, Math.floor((now - o.nextBeat) / o.period + 1e-6) + 1);
      for (let i = 0; i < count; i++) {
        const step = first + i;
        out.push({
          t: o.nextBeat + step * o.period,
          downbeat: step >= o.firstDownbeatStep && (step - o.firstDownbeatStep) % 4 === 0,
        });
      }
      return out;
    },
  };
}

function mood(over: Partial<MoodVector> = {}): MoodVector {
  return { ...NEUTRAL_MOOD, ...over };
}

describe('writeJevCues', () => {
  it('always writes the mood it was given at the moment it arrived', () => {
    const tl = new CueTimeline();
    writeJevCues(tl, mood({ valence: 0.8, dropImminent: 0.1 }), grid120(10), 10);

    expect(tl.at(10).mood.valence).toBeCloseTo(0.8, 6);
    expect(tl.cues().filter((c) => c.impact !== undefined)).toHaveLength(0);
    expect(tl.cues().filter((c) => c.build !== undefined)).toHaveLength(0);
  });

  it('puts the impact on the downbeat the beats count points at', () => {
    const tl = new CueTimeline();
    writeJevCues(
      tl,
      mood({ dropImminent: 0.9, beatsToChange: '8', impact: 0.8 }),
      grid120(10),
      10,
    );

    const impacts = tl.cues().filter((c) => c.impact !== undefined);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.t).toBeCloseTo(14, 6);
    expect(impacts[0]!.impact).toBeCloseTo(0.8, 6);
    expect(impacts[0]!.section).toBe('drop_climax');
    expect(impacts[0]!.source).toBe('jev');
  });

  it('ramps the build from nothing to all of it, every 0.2 s', () => {
    const tl = new CueTimeline();
    writeJevCues(tl, mood({ dropImminent: 0.9, beatsToChange: '8', impact: 0.8 }), grid120(10), 10);

    const builds = tl.cues().filter((c) => c.build !== undefined);
    expect(builds.length).toBeGreaterThanOrEqual(20);
    expect(builds[0]!.t).toBeCloseTo(10, 6);
    expect(builds[0]!.build).toBeCloseTo(0, 6);
    expect(builds[builds.length - 1]!.build).toBeCloseTo(1, 6);

    for (let i = 1; i < builds.length; i++) {
      expect(builds[i]!.build!).toBeGreaterThan(builds[i - 1]!.build!);
      expect(builds[i]!.t - builds[i - 1]!.t).toBeLessThanOrEqual(0.2 + 1e-9);
    }
    expect(tl.at(12).build).toBeCloseTo(0.5, 2);
  });

  it('snaps the target to a phrase boundary within two bars of it', () => {
    const tl = new CueTimeline();
    const grid = fakeGrid({ period: 0.5, nextBeat: 10.5, firstDownbeatStep: 3, barsSinceChange: 14 });

    // Four beats out is 12.0, a downbeat — but 14.0 starts the next phrase.
    writeJevCues(tl, mood({ dropImminent: 0.9, beatsToChange: '4', impact: 0.7 }), grid, 10);

    const impacts = tl.cues().filter((c) => c.impact !== undefined);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.t).toBeCloseTo(14, 6);
  });

  it('leaves the target alone when the phrase boundary is far off', () => {
    const tl = new CueTimeline();
    const grid = fakeGrid({ period: 0.5, nextBeat: 10.5, firstDownbeatStep: 3, barsSinceChange: 2 });

    writeJevCues(tl, mood({ dropImminent: 0.9, beatsToChange: '4', impact: 0.7 }), grid, 10);

    expect(tl.cues().filter((c) => c.impact !== undefined)[0]!.t).toBeCloseTo(12, 6);
  });

  it('predicts nothing when nothing is predicted to change', () => {
    const tl = new CueTimeline();
    writeJevCues(tl, mood({ dropImminent: 0.9, beatsToChange: 'none' }), grid120(10), 10);
    writeJevCues(tl, mood({ dropImminent: 0.5, beatsToChange: '8' }), grid120(10), 10);

    expect(tl.cues().filter((c) => c.impact !== undefined || c.build !== undefined)).toHaveLength(0);
  });

  it('replaces the last prediction instead of stacking ramps', () => {
    const tl = new CueTimeline();
    const drop = mood({ dropImminent: 0.9, beatsToChange: '8', impact: 0.8 });
    writeJevCues(tl, drop, grid120(10), 10);
    const first = tl.cues().length;
    writeJevCues(tl, drop, grid120(10.4), 10.4);

    expect(tl.cues().filter((c) => c.impact !== undefined)).toHaveLength(1);
    // A second ramp of the same length, stacked, would roughly double this.
    expect(tl.cues().length).toBeLessThan(first + 10);
  });

  it('marks a breakdown it is sure of', () => {
    const tl = new CueTimeline();
    writeJevCues(
      tl,
      mood({ section: 'breakdown', sectionP: { ...NEUTRAL_MOOD.sectionP, breakdown: 0.8 } }),
      grid120(10),
      10,
    );
    expect(tl.at(10).section).toBe('breakdown');
  });

  it('does not mark a breakdown it is guessing at', () => {
    const tl = new CueTimeline();
    writeJevCues(
      tl,
      mood({ section: 'breakdown', sectionP: { ...NEUTRAL_MOOD.sectionP, breakdown: 0.3 } }),
      grid120(10),
      10,
    );
    expect(tl.at(10).section).toBeUndefined();
  });

  it('keeps quiet about drops before there is a grid to put one on', () => {
    const tl = new CueTimeline();
    writeJevCues(tl, mood({ dropImminent: 0.9, beatsToChange: '8', impact: 0.8 }), new BeatGrid(), 10);

    expect(tl.cues().filter((c) => c.impact !== undefined)).toHaveLength(0);
    expect(tl.at(10).mood.valence).toBeCloseTo(NEUTRAL_MOOD.valence, 6);
  });
});

import { describe, expect, it } from 'vitest';
import { BeatGrid } from '../../src/analysis/grid';
import { CueTimeline } from '../../src/timeline/timeline';
import { writeGridCues } from '../../src/timeline/gridWriter';

/** A 120 BPM grid whose beats land on whole and half seconds from 2.0 on. */
function grid120(): BeatGrid {
  const grid = new BeatGrid();
  // A strong onset before the first tempo lands sets the phase the grid
  // re-anchors to, so the beats are where the test says they are.
  grid.onOnset(1.5, 1, 1);
  grid.setTempo({ bpm: 120, period: 0.5, confidence: 0.9, marking: 'allegro' }, 1.5);
  return grid;
}

describe('writeGridCues', () => {
  it('writes every predicted beat in the horizon, downbeats marked', () => {
    const tl = new CueTimeline();
    const grid = grid120();
    grid.tick(10);

    writeGridCues(tl, grid, 10, 8);

    const beats = tl.cues().filter((c) => c.source === 'grid');
    expect(beats).toHaveLength(16);
    expect(beats.every((c) => c.beat === true)).toBe(true);
    expect(beats[0]!.t).toBeCloseTo(10.5, 6);
    expect(beats[15]!.t).toBeCloseTo(18, 6);
    expect(beats.filter((c) => c.downbeat).map((c) => Number(c.t.toFixed(3)))).toEqual([12, 14, 16, 18]);
  });

  it('replaces the last prediction rather than stacking on it', () => {
    const tl = new CueTimeline();
    const grid = grid120();
    grid.tick(10);

    writeGridCues(tl, grid, 10, 8);
    grid.tick(11);
    writeGridCues(tl, grid, 11, 8);

    const beats = tl.cues().filter((c) => c.source === 'grid');
    // Beats already gone by stay (they are what `prune` is for); the future is
    // written once.
    expect(beats.filter((c) => c.t > 11)).toHaveLength(16);
    expect(new Set(beats.map((c) => c.t)).size).toBe(beats.length);
  });

  it('writes nothing, and clears nothing else, before there is a tempo', () => {
    const tl = new CueTimeline();
    tl.add({ t: 12, source: 'jev', impact: 1 });

    writeGridCues(tl, new BeatGrid(), 10, 8);

    expect(tl.cues().filter((c) => c.source === 'grid')).toHaveLength(0);
    expect(tl.cues()).toHaveLength(1);
  });
});

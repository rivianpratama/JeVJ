import { describe, expect, it } from 'vitest';
import { BeatGrid } from '../../src/analysis/grid';
import { tempoMarking, type TempoEstimate } from '../../src/analysis/tempo';

function tempo(bpm: number, confidence = 0.9): TempoEstimate {
  return { bpm, period: 60 / bpm, confidence, marking: tempoMarking(bpm) };
}

/** A grid locked to 120 BPM with beats on 0.5, 1.0, 1.5, ... */
function locked(offsetSec = 0, low: (beat: number) => number = () => 1): BeatGrid {
  const grid = new BeatGrid();
  grid.setTempo(tempo(120), 0);
  for (let beat = 1; beat <= 4; beat++) {
    const t = beat * 0.5;
    grid.onOnset(t + offsetSec, 1, low(beat));
  }
  return grid;
}

describe('BeatGrid', () => {
  it('starts its grid one period after the first tempo', () => {
    const grid = new BeatGrid();
    grid.setTempo(tempo(120), 0);

    expect(grid.state().period).toBeCloseTo(0.5, 6);
    expect(grid.state().nextBeat).toBeCloseTo(0.5, 6);
    expect(grid.state().barLength).toBe(4);
  });

  it('predicts the next four beats of a locked grid', () => {
    const beats = locked().predict(4, 2.0);

    expect(beats.map((b) => b.t)).toHaveLength(4);
    const expected = [2.5, 3.0, 3.5, 4.0];
    for (let i = 0; i < expected.length; i++) {
      expect(beats[i]!.t).toBeCloseTo(expected[i]!, 2); // within 5 ms
    }
  });

  it('pulls the grid earlier when onsets run consistently early', () => {
    const grid = new BeatGrid();
    grid.setTempo(tempo(120), 0);
    for (let beat = 1; beat <= 12; beat++) grid.onOnset(beat * 0.5 - 0.02, 1, 0);

    const drifted = grid.predict(1, 2.0)[0]!.t;
    const onTime = locked().predict(1, 2.0)[0]!.t;

    expect(drifted).toBeLessThan(onTime);
    expect(onTime - drifted).toBeGreaterThan(0.005);
    expect(onTime - drifted).toBeLessThanOrEqual(0.021);
  });

  it('ignores onsets that fall outside the pull-in window', () => {
    const grid = new BeatGrid();
    grid.setTempo(tempo(120), 0);
    const before = grid.state().nextBeat;
    grid.onOnset(0.7, 1, 0); // 200 ms late: not this beat

    expect(grid.state().nextBeat).toBeCloseTo(before, 6);
  });

  it('finds the downbeat from the low energy of every fourth beat', () => {
    const grid = new BeatGrid();
    grid.setTempo(tempo(120), 0);
    // Beat index 0 is at 0.5 s, so the loud beats below are indices 1, 5, 9...
    for (let beat = 1; beat <= 16; beat++) {
      const t = beat * 0.5;
      grid.onOnset(t, 1, beat % 4 === 2 ? 1 : 0.05);
    }

    expect(grid.state().downbeatOffset).toBe(1);
    expect(grid.predict(4, 0.6).filter((b) => b.downbeat)).toHaveLength(1);
  });

  it('emits the beats that have passed, and counts bars', () => {
    const grid = locked();
    const beats = grid.tick(2.6);

    expect(beats.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < beats.length; i++) {
      expect(beats[i]!.t).toBeCloseTo(0.5 + 0.5 * i, 2);
    }
    expect(beats.filter((b) => b.downbeat)).toHaveLength(2); // indices 0 and 4
    expect(grid.state().beatIndex).toBe(5);
    expect(grid.state().barsSinceChange).toBe(2);

    grid.markSectionChange(2.6);
    expect(grid.state().barsSinceChange).toBe(0);
    expect(grid.state().barInPhrase).toBe(0);
  });

  it('emits nothing twice', () => {
    const grid = locked();
    grid.tick(2.6);

    expect(grid.tick(2.6)).toHaveLength(0);
  });

  it('reports the position inside the current beat', () => {
    const grid = locked();

    expect(grid.phase(0.5)).toBeCloseTo(0, 3);
    expect(grid.phase(0.75)).toBeCloseTo(0.5, 3);
    expect(grid.phase(2.25)).toBeCloseTo(0.5, 3);
    expect(grid.phase(2.0)).toBeCloseTo(0, 3);
    for (const t of [0, 0.31, 1.7, 3.9]) {
      expect(grid.phase(t)).toBeGreaterThanOrEqual(0);
      expect(grid.phase(t)).toBeLessThan(1);
    }
  });

  it('keeps its phase when the tempo barely moves', () => {
    const grid = locked();
    const before = grid.state().nextBeat;
    grid.setTempo(tempo(123), 2.0); // 2.5% — the same tempo, re-measured

    expect(grid.state().nextBeat).toBeCloseTo(before, 6);
    expect(grid.state().bpm).toBe(123);
  });

  it('re-anchors to the last strong onset when the tempo really changes', () => {
    const grid = new BeatGrid();
    grid.setTempo(tempo(120), 0);
    grid.onOnset(2.0, 1, 0.5);
    grid.setTempo(tempo(160), 2.1); // +33%

    const period = 60 / 160;
    expect(grid.state().period).toBeCloseTo(period, 6);
    expect(grid.state().nextBeat).toBeGreaterThan(2.1);
    // Anchored on the 2.0 s onset, so every beat sits on that phase.
    const offset = (grid.state().nextBeat - 2.0) / period;
    expect(offset - Math.round(offset)).toBeCloseTo(0, 6);
  });

  it('takes its bar length from the meter', () => {
    const grid = locked();
    grid.setMeter('triple');
    expect(grid.state().barLength).toBe(3);

    grid.setMeter('duple');
    expect(grid.state().barLength).toBe(4);

    grid.setMeter('unclear');
    expect(grid.state().barLength).toBe(4);
  });

  it('counts bars in sixteens for the phrase position', () => {
    const grid = locked();
    grid.tick(40); // 80 beats: 20 bars

    expect(grid.state().barsSinceChange).toBe(20);
    expect(grid.state().barInPhrase).toBe(4);
  });

  it('does nothing until it has a tempo', () => {
    const grid = new BeatGrid();
    grid.onOnset(1, 1, 1);

    expect(grid.tick(10)).toHaveLength(0);
    expect(grid.predict(4, 1)).toHaveLength(0);
    expect(grid.phase(1)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { phraseBoundaryIn } from '../../src/app/moodLink';
import type { GridState } from '../../src/analysis/grid';

function grid(over: Partial<GridState> = {}): GridState {
  return {
    bpm: 120,
    period: 0.5,
    nextBeat: 10.2,
    beatIndex: 100,
    barLength: 4,
    downbeatOffset: 0,
    barsSinceChange: 3,
    barInPhrase: 14,
    confidence: 0.9,
    ...over,
  };
}

describe('phraseBoundaryIn', () => {
  it('counts the next downbeat plus the whole bars left in the phrase', () => {
    // Beat 100 is a downbeat (100 % 4 === 0), 0.2 s away; bar 14 of 16 leaves
    // two bars, so one whole bar plays after that downbeat.
    expect(phraseBoundaryIn(grid(), 10)).toBeCloseTo(0.2 + 4 * 0.5, 10);
  });

  it('walks forward to the next downbeat when mid-bar', () => {
    // Beat 101 is one past the downbeat, so three beats to the next one.
    expect(phraseBoundaryIn(grid({ beatIndex: 101, barInPhrase: 15 }), 10)).toBeCloseTo(
      0.2 + 3 * 0.5,
      10,
    );
  });

  it('spans the whole phrase from its first bar', () => {
    expect(phraseBoundaryIn(grid({ barInPhrase: 0 }), 10)).toBeCloseTo(0.2 + 15 * 4 * 0.5, 10);
  });

  it('says nothing when the grid has no period to count with', () => {
    expect(phraseBoundaryIn(grid({ period: 0 }), 10)).toBeNull();
    expect(phraseBoundaryIn(grid({ nextBeat: Number.NaN }), 10)).toBeNull();
  });
});

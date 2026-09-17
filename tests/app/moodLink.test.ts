import { describe, expect, it } from 'vitest';
import { MoodLink, phraseBoundaryIn } from '../../src/app/moodLink';
import { BeatGrid, type GridState } from '../../src/analysis/grid';
import { Summarizer } from '../../src/analysis/summarizer';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { CueTimeline } from '../../src/timeline/timeline';
import { writeJevCues } from '../../src/timeline/jevWriter';
import type { AnalysisSnapshot } from '../../src/app/analysisLoop';
import type { MoodFeed } from '../../src/app/moodFeed';
import type { MoodClient } from '../../src/mood/moodClient';
import type { MoodResponse } from '../../src/shared/types';

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

function snapshot(t: number): AnalysisSnapshot {
  const bands = Float32Array.from([0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7, 0.5]);
  return {
    features: {
      t,
      rms: 0.3,
      db: -10,
      bands,
      bandsRaw: bands,
      centroid: 2400,
      flatness: 0.3,
      rolloff: 8000,
      flux: 0.2,
      zcr: 1500,
      chroma: new Float32Array(12).fill(1 / 12),
      sub: 0.5,
      pitch: 0.2,
      f0: 220,
      formant: 0.15,
    },
    onset: 0,
    grid: grid({ nextBeat: t + 0.2 }),
    tempo: { bpm: 120, period: 0.5, confidence: 0.8, marking: 'allegro' },
    phase: 0.25,
    beats: [],
    key: { key: 'F#', mode: 'minor', modeConf: 0.7, fit: 0.6, modal: 'aeolian', tonic: 6 },
    rhythm: { sync: 0.3, regular: 0.9, meter: 'duple', onsetsPerSec: 4.2, onsetRatio: 1 },
    dynamics: { loud: 'f', range: 0.2, trend: 'building', crest: 0.3, slope4: 1, slope8: 2, gap: false },
    timbre: { consonance: 0.6, bright: 0.7, noise: 0.4, attack: 'sharp', sub: 0.8, centroidSlope: 0.4 },
    speech: 0.05,
    vocal: 0.2,
    harsh: 0.45,
    drop: null,
  };
}

/** A feed that just summarizes, so the link's own arithmetic is what is under test. */
function fakeFeed(): MoodFeed {
  return {
    update: (snap: AnalysisSnapshot) => ({
      input: Summarizer.fromSnapshot(snap, snap.features.t, 200),
      novelty: 1,
      sectionChanged: false,
    }),
    markSent: () => undefined,
  } as unknown as MoodFeed;
}

describe('MoodLink', () => {
  it('schedules an answer at the moment it was asked, not the moment it landed', async () => {
    const tl = new CueTimeline();
    // A real 120 BPM grid, downbeats two seconds apart, ticked past the answer.
    const beatGrid = new BeatGrid();
    beatGrid.onOnset(1.5, 1, 1);
    beatGrid.setTempo({ bpm: 120, period: 0.5, confidence: 0.9, marking: 'allegro' }, 1.5);
    beatGrid.tick(10.6);

    let settle: (r: MoodResponse | null) => void = () => undefined;
    const answer = new Promise<MoodResponse | null>((r) => {
      settle = r;
    });
    let asked = 0;
    const client = {
      maybeRequest: () => (asked++ === 0 ? answer : null),
      stats: () => ({ calls: 1, tokens: 0, lastLatencyMs: 600, errors: 0, backoffUntil: 0 }),
      nextAllowedAt: () => 0,
    } as unknown as MoodClient;

    const link = new MoodLink({
      feed: fakeFeed(),
      client,
      onMood: (mood, now) => writeJevCues(tl, mood, beatGrid, now),
    });

    // Asked at 10; the round trip takes 0.6 s, three HUD ticks.
    for (const t of [10, 10.2, 10.4, 10.6]) link.update(snapshot(t), t, 200, true, true);
    settle({
      mood: { ...NEUTRAL_MOOD, dropImminent: 0.9, beatsToChange: '8', impact: 0.8 },
      usage: { input_tokens: 10, output_tokens: 10 },
      latencyMs: 600,
    });
    await answer;
    await Promise.resolve();

    // The mood describes the music at 10, and the eight beats it counted are
    // eight beats from 10 — four seconds, snapped to the downbeat at 14.
    expect(tl.cues().filter((c) => c.mood !== undefined).map((c) => c.t)).toEqual([10]);
    const impacts = tl.cues().filter((c) => c.impact !== undefined);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.t).toBeCloseTo(14, 6);
    // And the ramp starts where the question was asked, not where it landed.
    expect(tl.cues().filter((c) => c.build !== undefined)[0]!.t).toBeCloseTo(10, 6);
  });
});

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

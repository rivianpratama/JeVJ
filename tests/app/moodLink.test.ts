import { describe, expect, it } from 'vitest';
import { MoodLink } from '../../src/app/moodLink';
import { type GridState } from '../../src/analysis/grid';
import { Summarizer } from '../../src/analysis/summarizer';
import { MoodState } from '../../src/mood/moodState';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import type { AnalysisSnapshot } from '../../src/app/analysisLoop';
import type { MoodFeed } from '../../src/app/moodFeed';

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
    pause: 0,
    pitchVar: 0,
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
  it('summarizes every tick and advances the slew off the audio clock', () => {
    // What is left of the layer in v2: the feed still runs, because the HUD
    // reads its payload and the grid counts phrases from the boundaries only
    // the feed hears, and the state still slews toward whatever the timeline
    // last pointed it at.
    const state = new MoodState();
    const link = new MoodLink({ feed: fakeFeed(), state });
    state.setTarget({ ...NEUTRAL_MOOD, arousal: 1 }, 0);

    const first = link.update(snapshot(0), 0, 200);
    expect(first.reading.input.pos).toBeDefined();
    const later = link.update(snapshot(4), 4, 200);
    // Slewed toward the target rather than snapped onto it, and moving.
    expect(later.mood.arousal).toBeGreaterThan(first.mood.arousal);
    expect(later.mood.arousal).toBeLessThan(1);
    expect(link.mood().arousal).toBe(later.mood.arousal);
  });

  it('asks nothing at all: there is nothing left to ask with', () => {
    // v2 judges the whole track before it plays, so a live call could only
    // contradict a better-informed one. The client, the cadence and the phrase
    // look-ahead that fed it are gone rather than switched off — this is the
    // test that they stay gone.
    const fetches: string[] = [];
    const link = new MoodLink({ feed: fakeFeed() });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      fetches.push(String(url));
      return Promise.reject(new Error('nothing here should reach the network'));
    }) as unknown as typeof fetch;
    try {
      for (let i = 0; i < 400; i++) link.update(snapshot(i * 0.25), i * 0.25, 200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetches).toEqual([]);
  });
});

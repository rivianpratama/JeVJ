import { describe, expect, it } from 'vitest';
import { MoodFeed } from '../../src/app/moodFeed';
import type { AnalysisSnapshot } from '../../src/app/analysisLoop';
import { validateMoodInput } from '../../src/shared/moodSchema';

function snapshot(t: number, over: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
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
    },
    onset: 0,
    grid: {
      bpm: 128,
      period: 60 / 128,
      nextBeat: t + 0.2,
      beatIndex: 100,
      barLength: 4,
      downbeatOffset: 0,
      barsSinceChange: 8,
      barInPhrase: 4,
      confidence: 0.9,
    },
    tempo: { bpm: 128, period: 60 / 128, confidence: 0.8, marking: 'allegro' },
    phase: 0.25,
    beats: [],
    key: { key: 'F#', mode: 'minor', modeConf: 0.7, fit: 0.6, modal: 'aeolian', tonic: 6 },
    rhythm: { sync: 0.3, regular: 0.9, meter: 'duple', onsetsPerSec: 4.2, onsetRatio: 1 },
    dynamics: { loud: 'f', range: 0.2, trend: 'building', crest: 0.3, slope4: 1, slope8: 2, gap: false },
    timbre: { consonance: 0.6, bright: 0.7, noise: 0.4, attack: 'sharp', sub: 0.8, centroidSlope: 0.4 },
    speech: 0.05,
    drop: null,
    ...over,
  };
}

/** The same music, but duller: a change no boundary rule reacts to. */
function duller(t: number): AnalysisSnapshot {
  const base = snapshot(t);
  return {
    ...base,
    features: { ...base.features, bands: Float32Array.from([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.2, 0.1]) },
    timbre: { ...base.timbre, bright: 0.1, noise: 0.9, sub: 0.1 },
  };
}

/** The same music, turned around: a payload every rule should react to. */
function turned(t: number): AnalysisSnapshot {
  const base = snapshot(t);
  return {
    ...base,
    dynamics: { ...base.dynamics, trend: 'fading', slope4: -9 },
    rhythm: { ...base.rhythm, onsetRatio: 0.2, onsetsPerSec: 0.5 },
  };
}

describe('MoodFeed', () => {
  it('builds a payload the schema accepts', () => {
    const r = new MoodFeed().update(snapshot(0), 92, 245);
    expect(validateMoodInput(r.input).ok).toBe(true);
    expect(r.input.pos).toBe('1:32/4:05');
  });

  it('has nothing to compare the first payload against', () => {
    const r = new MoodFeed().update(snapshot(0), 0, 245);
    expect(r.novelty).toBe(0);
    expect(r.sectionChanged).toBe(false);
    expect(r.input).toEqual(new MoodFeed().update(snapshot(0), 0, 245).input);
  });

  it('reports nothing new while nothing changes', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    expect(feed.update(snapshot(1), 1, 245).novelty).toBe(0);
    expect(feed.update(snapshot(2), 2, 245).novelty).toBe(0);
  });

  it('measures how far the music has moved from the reference', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    const r = feed.update(turned(1), 1, 245);
    expect(r.novelty).toBeGreaterThan(0);
  });

  it('re-takes the reference once it is four seconds old', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    const first = feed.lastSent();
    feed.update(snapshot(3), 3, 245);
    expect(feed.lastSent()).toBe(first); // still inside the window

    const moved = feed.update(turned(5), 5, 245);
    expect(moved.novelty).toBeGreaterThan(0); // measured against the old one
    // ...which it then replaces, so the same music is no longer news.
    expect(feed.update(turned(5.1), 5.1, 245).novelty).toBe(0);
  });

  it('calls a boundary once, not on every frame of it', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    expect(feed.update(turned(1), 1, 245).sectionChanged).toBe(true);
    expect(feed.update(turned(1.1), 1.1, 245).sectionChanged).toBe(false);
    // Back to building at 2.5 s is a trend flip, but it is inside the cooldown.
    expect(feed.update(snapshot(2.5), 2.5, 245).sectionChanged).toBe(false);
  });

  it('can call another boundary once the cooldown has passed', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    expect(feed.update(turned(1), 1, 245).sectionChanged).toBe(true);
    // Back to where it started, a cooldown later: that is a boundary too.
    expect(feed.update(snapshot(3.5), 3.5, 245).sectionChanged).toBe(true);
  });

  it('latches what was sent when the client says it went', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    // A change too mild to be a boundary, so only `markSent` can re-latch it.
    expect(feed.update(duller(1), 1, 245).sectionChanged).toBe(false);
    expect(feed.update(duller(1.2), 1.2, 245).novelty).toBeGreaterThan(0);

    feed.markSent(1.2);
    expect(feed.lastSent()).toEqual(feed.latest());
    expect(feed.update(duller(1.5), 1.5, 245).novelty).toBe(0);
  });
});

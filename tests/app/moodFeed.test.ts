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

/**
 * A long slow slide from the opening snapshot to something else entirely,
 * complete at 16 s. Nothing it moves is a boundary rule's business — the trend,
 * `slope4`, the onset density and the key all hold — so the only thing it can
 * be read by is novelty.
 */
function drifting(t: number): AnalysisSnapshot {
  const base = snapshot(t);
  const k = Math.min(1, Math.max(0, t / 16));
  const to = (from: number, dest: number) => from + (dest - from) * k;
  const bands = Float32Array.from(
    [0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7, 0.5].map((b) => to(b, 0.1)),
  );
  return {
    ...base,
    features: { ...base.features, bands, bandsRaw: bands },
    grid: { ...base.grid, bpm: to(128, 160), confidence: to(0.9, 0.3) },
    key: { ...base.key, modeConf: to(0.7, 0.1) },
    rhythm: { ...base.rhythm, sync: to(0.3, 0.9), regular: to(0.9, 0.3) },
    dynamics: {
      ...base.dynamics,
      loud: k > 0.5 ? 'p' : 'f',
      range: to(0.2, 0.8),
      crest: to(0.3, 0.8),
      slope8: to(2, -10),
    },
    timbre: {
      ...base.timbre,
      consonance: to(0.6, 0.1),
      bright: to(0.7, 0.1),
      noise: to(0.4, 0.9),
      sub: to(0.8, 0.1),
      centroidSlope: to(0.4, -0.4),
    },
    speech: to(0.05, 0.6),
  };
}

describe('MoodFeed', () => {
  it('builds a payload the schema accepts', () => {
    const r = new MoodFeed().update(snapshot(0), 92, 245);
    expect(validateMoodInput(r.input).ok).toBe(true);
    expect(r.input.pos).toBe('1:32/4:05');
  });

  it('has everything to say before anything has been said', () => {
    const r = new MoodFeed().update(snapshot(0), 0, 245);
    expect(r.novelty).toBe(1);
    expect(r.sectionChanged).toBe(false);
    expect(r.input).toEqual(new MoodFeed().update(snapshot(0), 0, 245).input);
    expect(new MoodFeed().lastSent()).toBe(null);
  });

  it('reports nothing new while nothing changes', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    feed.markSent(feed.latest()!);
    expect(feed.update(snapshot(1), 1, 245).novelty).toBe(0);
    expect(feed.update(snapshot(2), 2, 245).novelty).toBe(0);
  });

  it('measures how far the music has moved from what was sent', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    feed.markSent(feed.latest()!);
    const r = feed.update(turned(1), 1, 245);
    expect(r.novelty).toBeGreaterThan(0);
  });

  it('accumulates a slow drift instead of resetting every four seconds', () => {
    const feed = new MoodFeed();
    feed.update(drifting(0), 0, 245);
    const sent = feed.latest()!;
    feed.markSent(sent);

    let last = -1;
    for (let t = 1; t <= 12; t++) {
      const n = feed.update(drifting(t), t, 245).novelty;
      expect(n).toBeGreaterThan(last); // never re-based, so never resets
      last = n;
    }
    expect(last).toBeGreaterThan(0.3);
    expect(feed.lastSent()).toBe(sent);
  });

  it('starts over from what actually went out, then builds again', () => {
    const feed = new MoodFeed();
    feed.update(drifting(0), 0, 245);
    feed.markSent(feed.latest()!);
    feed.update(drifting(12), 12, 245);

    feed.markSent(feed.latest()!);
    expect(feed.update(drifting(12), 12, 245).novelty).toBe(0);
    expect(feed.update(drifting(16), 16, 245).novelty).toBeGreaterThan(0);
  });

  it('leaves what was sent alone across a section boundary', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    const sent = feed.latest()!;
    feed.markSent(sent);

    expect(feed.update(turned(1), 1, 245).sectionChanged).toBe(true);
    expect(feed.lastSent()).toBe(sent);
    expect(feed.update(turned(1.2), 1.2, 245).novelty).toBeGreaterThan(0);
  });

  it('tells its owner about a boundary once, with the audio time', () => {
    const heard: number[] = [];
    const feed = new MoodFeed({ onSectionChange: (now) => heard.push(now) });
    feed.update(snapshot(0), 0, 245);

    expect(feed.update(turned(1), 1, 245).sectionChanged).toBe(true);
    expect(heard).toEqual([1]);
    // The same fading, still fading, is the same section.
    feed.update(turned(1.1), 1.1, 245);
    feed.update(turned(1.6), 1.6, 245);
    expect(heard).toEqual([1]);
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
    feed.markSent(feed.latest()!);
    // A change too mild to be a boundary: only `markSent` can re-base novelty.
    expect(feed.update(duller(1), 1, 245).sectionChanged).toBe(false);
    expect(feed.update(duller(1.2), 1.2, 245).novelty).toBeGreaterThan(0);

    feed.markSent(feed.latest()!);
    expect(feed.lastSent()).toEqual(feed.latest());
    expect(feed.update(duller(1.5), 1.5, 245).novelty).toBe(0);
  });
});

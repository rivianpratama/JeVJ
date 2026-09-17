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
      pitch: 0.2,
      f0: 220,
      formant: 0.15,
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
    pause: 0,
    pitchVar: 0,
    vocal: 0.2,
    harsh: 0.45,
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
    vocal: to(0.2, 0.3),
    harsh: to(0.45, 0.5),
  };
}

describe('MoodFeed', () => {
  it('builds a payload the schema accepts', () => {
    const r = new MoodFeed().update(snapshot(0), 92, 245);
    expect(validateMoodInput(r.input).ok).toBe(true);
    expect(r.input.pos).toBe('1:32/4:05');
  });

  it('calls no boundary on the very first payload it ever sees', () => {
    // There is nothing to have changed *from*. v1 also reported a novelty of 1
    // here, which was its way of saying "everything is news"; nothing asks any
    // more, because nothing is sent while a track plays.
    const r = new MoodFeed().update(snapshot(0), 0, 245);
    expect(r.sectionChanged).toBe(false);
    expect(r.input).toEqual(new MoodFeed().update(snapshot(0), 0, 245).input);
  });

  it('keeps the latest payload, which is what the HUD reads', () => {
    const feed = new MoodFeed();
    feed.update(snapshot(0), 0, 245);
    const second = feed.update(snapshot(1), 1, 245).input;
    expect(feed.latest()).toBe(second);
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

  it('judges a boundary against a few seconds ago, not against the top of the track', () => {
    // A drift that never turns a corner is not a boundary however far it has
    // gone: the reference ages forward with it.
    const feed = new MoodFeed();
    for (let t = 0; t <= 12; t++) {
      expect(feed.update(drifting(t), t, 245).sectionChanged, `t=${t}`).toBe(false);
    }
  });
});

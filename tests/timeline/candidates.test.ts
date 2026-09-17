import { describe, expect, it } from 'vitest';

import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { analyzeOffline, findCandidates, type OfflineResult } from '../../src/timeline/offlineAnalyzer';
import { songFixture } from '../helpers/synth';
import type { MoodInput, MoodVector } from '../../src/shared/types';

const SR = 44100;

const fixture = songFixture(SR);
let swept: OfflineResult | null = null;

/**
 * The song fixture, swept once and reused.
 *
 * Sixty seconds of audio through the whole chain is a second or two of CPU,
 * and every test in this file asks a different question of the same sweep.
 */
async function analysis(): Promise<OfflineResult> {
  if (swept === null) {
    swept = await analyzeOffline(fixture.signal, SR, async (_input: MoodInput): Promise<MoodVector> => NEUTRAL_MOOD);
  }
  return swept;
}

/** The candidate nearest `t`, and how far off it is. */
function nearest(times: readonly number[], t: number): number {
  return times.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity);
}

describe('findCandidates on the song fixture', () => {
  it('finds a moment within half a second of everything the track does', async () => {
    const { candidates } = await analysis();
    const times = candidates.map((c) => c.t);
    for (const [name, t] of Object.entries(fixture.truth)) {
      const found = nearest(times, t);
      expect(
        Math.abs(found - t),
        `${name} at ${t}s: nearest candidate ${found.toFixed(2)}s`,
      ).toBeLessThanOrEqual(0.5);
    }
  }, 30_000);

  it('stays inside the sixty-candidate budget', async () => {
    const { candidates } = await analysis();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(60);
  }, 30_000);

  it('hands back candidates in time order, with no two on the same moment', async () => {
    const { candidates } = await analysis();
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.t).toBeGreaterThan(candidates[i - 1]!.t);
    }
  }, 30_000);

  it('keeps the detector instant on the moments a detector found', async () => {
    const { candidates } = await analysis();
    const slam = candidates.find((c) => c.reason === 'impact' && Math.abs(c.t - fixture.truth.drop) <= 0.5);
    expect(slam?.detectorT).toBeDefined();
    // One frame of reporting lag, and nothing else: this is the instant the
    // whole two-bar ramp is aimed at.
    expect(Math.abs((slam?.detectorT ?? 0) - fixture.truth.drop)).toBeLessThanOrEqual(0.03);
  }, 30_000);

  it('keeps the hole and the slam that follows it apart', async () => {
    const { candidates } = await analysis();
    const around = candidates.filter((c) => Math.abs(c.t - fixture.truth.drop) <= 0.5);
    expect(around.map((c) => c.reason)).toEqual(['gap', 'impact']);
  }, 30_000);

  it('measures vocal and harsh for every frame of the sweep', async () => {
    const r = await analysis();
    expect(r.vocal).toHaveLength(r.features.length);
    expect(r.harsh).toHaveLength(r.features.length);
    // The scream section is the harshest thing in the track by construction.
    const harshAt = (t: number): number => r.harsh[Math.round(t / 0.0167)] ?? 0;
    expect(harshAt(50)).toBeGreaterThan(harshAt(44));
  }, 30_000);

  it('takes a payload every half second, each with what was true then', async () => {
    const { samples } = await analysis();
    expect(samples.length).toBeGreaterThan(100);
    expect(samples[0]?.novelty).toBe(0);
    for (const s of samples) {
      expect(s.barSec).toBeGreaterThan(0);
      expect(s.novelty).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);
});

describe('findCandidates rules', () => {
  const sample = (t: number, over: Partial<MoodInput> = {}, rest: Partial<{ novelty: number; tonic: number; fit: number }> = {}) => ({
    t,
    input: { ...base, ...over },
    novelty: 0,
    tonic: 0,
    fit: 0,
    barSec: 2,
    ...rest,
  });

  const base: MoodInput = {
    pos: '0:00/1:00', bpm: 120, tempo: 'allegro', beatConf: 0.9, meter: 'duple', sync: 0.2,
    regular: 0.9, key: 'C', mode: 'minor', modeConf: 0.7, modal: 'aeolian', consonance: 0.6,
    loud: 'mf', range: 0.3, trend: 'steady', crest: 0.3, bright: 0.5, noise: 0.3, attack: 'sharp',
    sub: 0.5, bands: [5, 5, 5, 5, 5, 5, 5, 5], speech: 0.1, pause: 0, vocal: 0.1, harsh: 0.2,
    onsetsPerSec: 4, slope4: 0, slope8: 0, onsetRatio: 1, centroidSlope: 0, gap: false,
    barsSinceChange: 4, barInPhrase: 4,
  };

  it('calls a tempo that moved more than 6%', () => {
    const found = findCandidates({
      samples: [sample(0), sample(0.5, { bpm: 129 })],
      drops: [],
      frames: [],
      vocal: [],
      harsh: [],
    });
    expect(found.map((c) => c.reason)).toEqual(['tempo']);
    expect(found[0]?.t).toBe(0.5);
  });

  it('ignores a tempo that wobbled inside 6%', () => {
    const found = findCandidates({
      samples: [sample(0), sample(0.5, { bpm: 126 })],
      drops: [],
      frames: [],
      vocal: [],
      harsh: [],
    });
    expect(found).toEqual([]);
  });

  it('calls a new tonic only when the key fits', () => {
    const weak = findCandidates({
      samples: [sample(0), sample(0.5, {}, { tonic: 7, fit: 0.4 })],
      drops: [], frames: [], vocal: [], harsh: [],
    });
    expect(weak).toEqual([]);

    const strong = findCandidates({
      samples: [sample(0), sample(0.5, {}, { tonic: 7, fit: 0.8 })],
      drops: [], frames: [], vocal: [], harsh: [],
    });
    expect(strong.map((c) => c.reason)).toEqual(['key']);
  });

  it('takes every detector event, and keeps its exact instant', () => {
    const found = findCandidates({
      samples: [sample(0)],
      drops: [
        { t: 10.017, kind: 'impact', strength: 0.9 },
        { t: 20.5, kind: 'gap', strength: 0.4 },
      ],
      frames: [], vocal: [], harsh: [],
    });
    expect(found.map((c) => c.reason)).toEqual(['impact', 'gap']);
    expect(found[0]?.detectorT).toBe(10.017);
    expect(found[0]?.novelty).toBe(0.9);
  });

  it('calls a crossing that holds and ignores one that does not', () => {
    const frames = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.05 }) as never);
    // Up at frame 20 and back down at 21: a wobble. Up for good at frame 100.
    const vocal = Array.from({ length: 200 }, (_, i) => (i === 20 || i >= 100 ? 0.9 : 0.1));
    const found = findCandidates({ samples: [sample(0)], drops: [], frames, vocal, harsh: [] });
    expect(found.map((c) => c.reason)).toEqual(['vocal']);
    expect(found[0]?.t).toBeCloseTo(100 * 0.05, 6);
  });

  it('collapses several rules firing on one moment into one candidate', () => {
    const found = findCandidates({
      samples: [sample(0), sample(0.5, { bpm: 140 }, { tonic: 7, fit: 0.9, novelty: 0.4 })],
      drops: [{ t: 0.6, kind: 'impact', strength: 0.95 }],
      frames: [], vocal: [], harsh: [],
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.detectorT).toBe(0.6);
    expect(found[0]?.novelty).toBe(0.95);
  });

  it('keeps the highest-novelty sixty when there are more', () => {
    const drops = Array.from({ length: 120 }, (_, i) => ({
      t: i * 2,
      kind: 'impact' as const,
      strength: i / 120,
    }));
    const found = findCandidates({ samples: [sample(0)], drops, frames: [], vocal: [], harsh: [] });
    expect(found).toHaveLength(60);
    expect(found[0]!.t).toBe(60 * 2);
    expect(found.every((c) => c.novelty >= 0.5)).toBe(true);
  });
});

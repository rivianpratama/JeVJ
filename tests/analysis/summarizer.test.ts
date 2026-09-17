import { describe, expect, it } from 'vitest';
import { Summarizer, type MoodReadings, type SummarizerDeps } from '../../src/analysis/summarizer';
import { consonance } from '../../src/analysis/timbre';
import { validateMoodInput } from '../../src/shared/moodSchema';
import { estimateTokens } from '../../src/shared/tokens';
import type { FrameFeatures, MoodInput } from '../../src/shared/types';

/** The payload the plan pins the token budget to. */
const EXAMPLE: MoodInput = {
  pos: '1:32/4:05',
  bpm: 128,
  tempo: 'allegro',
  beatConf: 0.9,
  meter: 'duple',
  sync: 0.3,
  regular: 0.9,
  key: 'F#',
  mode: 'minor',
  modeConf: 0.7,
  modal: 'aeolian',
  consonance: 0.6,
  loud: 'f',
  range: 0.2,
  trend: 'building',
  crest: 0.3,
  bright: 0.7,
  noise: 0.4,
  attack: 'sharp',
  sub: 0.8,
  bands: [9, 8, 6, 5, 5, 6, 7, 5],
  speech: 0.05,
  onsetsPerSec: 4.2,
  slope4: 3.5,
  slope8: 6.1,
  onsetRatio: 2.1,
  centroidSlope: 0.4,
  gap: false,
  barsSinceChange: 14,
  barInPhrase: 14,
};

/** Band levels that round to the example's `bands`. */
const BAND_LEVELS = [1, 0.88, 0.65, 0.55, 0.55, 0.67, 0.75, 0.52];

/** A chroma leaning on F# minor, so the deps path has something to read. */
function chromaFsMinor(): Float32Array {
  const c = new Float32Array(12).fill(0.02);
  for (const pc of [6, 9, 1]) c[pc] = 0.25;
  return c;
}

function stubFrame(): FrameFeatures {
  return {
    t: 92,
    rms: 0.3,
    db: -10,
    bands: Float32Array.from(BAND_LEVELS),
    bandsRaw: Float32Array.from(BAND_LEVELS),
    centroid: 2400,
    flatness: 0.3,
    rolloff: 8000,
    flux: 0.2,
    zcr: 1500,
    chroma: chromaFsMinor(),
    sub: 0.8,
  };
}

/** Readings that build the example payload exactly. */
function exampleReadings(over: Partial<MoodReadings> = {}): MoodReadings {
  return {
    features: { bands: Float32Array.from(BAND_LEVELS) },
    grid: {
      bpm: 128,
      period: 60 / 128,
      nextBeat: 92.2,
      beatIndex: 196,
      barLength: 4,
      downbeatOffset: 0,
      barsSinceChange: 14,
      barInPhrase: 14,
      confidence: 0.9,
    },
    tempo: { bpm: 128, period: 60 / 128, confidence: 0.8, marking: 'allegro' },
    key: { key: 'F#', mode: 'minor', modeConf: 0.7, fit: 0.6, modal: 'aeolian', tonic: 6 },
    rhythm: { sync: 0.3, regular: 0.9, meter: 'duple', onsetsPerSec: 4.2, onsetRatio: 2.1 },
    dynamics: {
      loud: 'f',
      range: 0.2,
      trend: 'building',
      crest: 0.3,
      slope4: 3.5,
      slope8: 6.1,
      gap: false,
    },
    timbre: { consonance: 0.6, bright: 0.7, noise: 0.4, attack: 'sharp', sub: 0.8, centroidSlope: 0.4 },
    speech: 0.05,
    ...over,
  };
}

/** The same values again, but behind the tracker methods the deps path calls. */
function stubDeps(r: MoodReadings = exampleReadings()): SummarizerDeps {
  return {
    grid: { state: () => r.grid },
    key: { estimate: () => r.key },
    rhythm: {
      syncopation: () => r.rhythm.sync,
      regularity: () => r.rhythm.regular,
      meter: () => r.rhythm.meter,
      onsetsPerSec: () => r.rhythm.onsetsPerSec,
      onsetRatio: () => r.rhythm.onsetRatio,
    },
    dyn: {
      loudClass: () => r.dynamics.loud,
      range: () => r.dynamics.range,
      trend: () => r.dynamics.trend,
      crest: () => r.dynamics.crest,
      slopeDb: (barsBack: number) => (barsBack === 4 ? r.dynamics.slope4 : r.dynamics.slope8),
      gap: () => r.dynamics.gap,
    },
    timbre: {
      brightness: () => r.timbre.bright,
      noisiness: () => r.timbre.noise,
      attack: () => r.timbre.attack,
      subWeight: () => r.timbre.sub,
      centroidSlope: () => r.timbre.centroidSlope,
    },
    speech: { score: () => r.speech },
    tempo: () => r.tempo,
    frame: stubFrame,
  };
}

describe('Summarizer.fromSnapshot', () => {
  it('builds the payload the plan pins', () => {
    expect(Summarizer.fromSnapshot(exampleReadings(), 92, 245)).toEqual(EXAMPLE);
  });

  it('builds something the schema accepts', () => {
    const input = Summarizer.fromSnapshot(exampleReadings(), 92, 245);
    expect(validateMoodInput(input).ok).toBe(true);
  });

  it('clamps and rounds whatever the trackers hand it', () => {
    const wild = exampleReadings({
      features: { bands: Float32Array.from([2, -1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]) },
      grid: { ...exampleReadings().grid, bpm: 480, confidence: 1.4, barsSinceChange: 4000, barInPhrase: 99 },
      rhythm: { sync: -0.2, regular: 1.9, meter: 'unclear', onsetsPerSec: 55, onsetRatio: 99 },
      dynamics: { ...exampleReadings().dynamics, slope4: -999, slope8: 999, range: NaN },
      timbre: { ...exampleReadings().timbre, centroidSlope: -4, consonance: Infinity },
      speech: NaN,
      key: { key: 'H#', mode: 'unclear', modeConf: -3, fit: 0, modal: 'unclear', tonic: -1 },
    });

    const input = Summarizer.fromSnapshot(wild, 0, null);
    const check = validateMoodInput(input);
    expect(check.ok ? 'ok' : check.error).toBe('ok');
    expect(input.bands).toEqual([9, 0, 5, 5, 5, 5, 5, 5]);
    expect(input.bpm).toBe(300);
    expect(input.barsSinceChange).toBe(999);
    expect(input.key).toBe('?');
    expect(input.range).toBe(0);
  });

  it('falls back to the grid when no tempo has been measured', () => {
    const input = Summarizer.fromSnapshot(exampleReadings({ tempo: null }), 92, 245);
    expect(input.bpm).toBe(128);
    expect(input.tempo).toBe('allegro');
  });

  it('writes the position as m:ss over the length, or over "live"', () => {
    expect(Summarizer.fromSnapshot(exampleReadings(), 92, 245).pos).toBe('1:32/4:05');
    expect(Summarizer.fromSnapshot(exampleReadings(), 92, null).pos).toBe('1:32/live');
    expect(Summarizer.fromSnapshot(exampleReadings(), 0, 0).pos).toBe('0:00/live');
    expect(Summarizer.fromSnapshot(exampleReadings(), -5, NaN).pos).toBe('0:00/live');
    expect(Summarizer.fromSnapshot(exampleReadings(), 3599, 3600).pos).toBe('59:59/60:00');
  });
});

describe('Summarizer.snapshot', () => {
  it('reads the trackers into the same payload the readings path builds', () => {
    const readings = exampleReadings();
    const expected = Summarizer.fromSnapshot(
      exampleReadings({
        timbre: { ...readings.timbre, consonance: consonance(chromaFsMinor()) },
      }),
      92,
      245,
    );

    expect(new Summarizer(stubDeps()).snapshot(92, 92, 245)).toEqual(expected);
  });
});

describe('Summarizer.serialize', () => {
  it('stays inside the token budget', () => {
    expect(estimateTokens(Summarizer.serialize(EXAMPLE))).toBeLessThanOrEqual(160);
  });

  it('stays inside the budget at the worst values the schema allows', () => {
    const worst: MoodInput = {
      pos: '199:59/199:59',
      bpm: 200,
      tempo: 'moderato',
      beatConf: 0.99,
      meter: 'unclear',
      sync: 0.99,
      regular: 0.99,
      key: 'F#',
      mode: 'unclear',
      modeConf: 0.99,
      modal: 'mixolydian',
      consonance: 0.99,
      loud: 'mp',
      range: 0.99,
      trend: 'building',
      crest: 0.99,
      bright: 0.99,
      noise: 0.99,
      attack: 'mixed',
      sub: 0.99,
      bands: [9, 9, 9, 9, 9, 9, 9, 9],
      speech: 0.99,
      onsetsPerSec: 19.9,
      slope4: -59.9,
      slope8: -59.9,
      onsetRatio: 19.9,
      centroidSlope: -0.99,
      gap: true,
      barsSinceChange: 999,
      barInPhrase: 31,
    };
    expect(estimateTokens(Summarizer.serialize(worst))).toBeLessThanOrEqual(160);
  });

  it('round-trips into something the schema accepts', () => {
    const noisy: MoodInput = { ...EXAMPLE, beatConf: 0.8765432, sync: 1.4, slope4: 3.14159, bands: [9, 8, 6, 5, 5, 6, 7, 5] };
    const parsed: unknown = JSON.parse(Summarizer.serialize(noisy));
    const check = validateMoodInput(parsed);
    expect(check.ok ? 'ok' : check.error).toBe('ok');
    expect(check.ok && check.value.beatConf).toBe(0.88);
    expect(check.ok && check.value.sync).toBe(1);
    expect(check.ok && check.value.slope4).toBe(3.1);
  });
});

describe('Summarizer.novelty', () => {
  it('is nothing at all against itself', () => {
    expect(Summarizer.novelty(EXAMPLE, EXAMPLE)).toBe(0);
  });

  it('notices a different tempo over inverted bands', () => {
    const other: MoodInput = {
      ...EXAMPLE,
      bpm: 180,
      bands: EXAMPLE.bands.map((b) => 9 - b),
    };
    expect(Summarizer.novelty({ ...EXAMPLE, bpm: 60 }, other)).toBeGreaterThan(0.3);
  });

  it('stays inside 0..1 however far apart the inputs are', () => {
    const quiet: MoodInput = {
      ...EXAMPLE,
      bpm: 0,
      beatConf: 0,
      sync: 0,
      regular: 0,
      modeConf: 0,
      consonance: 0,
      range: 0,
      bright: 0,
      noise: 0,
      sub: 0,
      speech: 0,
      bands: [0, 0, 0, 0, 0, 0, 0, 0],
      slope4: -60,
      slope8: -60,
      onsetRatio: 0,
      centroidSlope: -1,
      loud: 'pp',
      trend: 'fading',
    };
    const loud: MoodInput = {
      ...quiet,
      bpm: 300,
      beatConf: 1,
      sync: 1,
      regular: 1,
      modeConf: 1,
      consonance: 1,
      range: 1,
      bright: 1,
      noise: 1,
      sub: 1,
      speech: 1,
      bands: [9, 9, 9, 9, 9, 9, 9, 9],
      slope4: 60,
      slope8: 60,
      onsetRatio: 20,
      centroidSlope: 1,
      loud: 'ff',
      trend: 'building',
    };
    const n = Summarizer.novelty(quiet, loud);
    expect(n).toBeGreaterThan(0.8);
    expect(n).toBeLessThanOrEqual(1);
    expect(Summarizer.novelty(loud, quiet)).toBe(n);
  });
});

describe('Summarizer.sectionChanged', () => {
  const s = new Summarizer(stubDeps());

  it('says nothing about a payload that has not moved', () => {
    expect(s.sectionChanged(EXAMPLE, EXAMPLE)).toBe(false);
  });

  it('has nothing to compare against before the first reference', () => {
    expect(s.sectionChanged(null, EXAMPLE)).toBe(false);
  });

  it('hears the music turn around', () => {
    expect(s.sectionChanged(EXAMPLE, { ...EXAMPLE, trend: 'fading' })).toBe(true);
  });

  it('hears a bar that jumps in level', () => {
    expect(s.sectionChanged({ ...EXAMPLE, slope4: 0 }, { ...EXAMPLE, slope4: -6.2 })).toBe(true);
    expect(s.sectionChanged({ ...EXAMPLE, slope4: 0 }, { ...EXAMPLE, slope4: 5.9 })).toBe(false);
  });

  it('hears the onsets double or halve', () => {
    const calm = { ...EXAMPLE, onsetRatio: 1 };
    expect(s.sectionChanged(calm, { ...calm, onsetRatio: 2.2 })).toBe(true);
    expect(s.sectionChanged(calm, { ...calm, onsetRatio: 0.5 })).toBe(true);
    expect(s.sectionChanged(calm, { ...calm, onsetRatio: 1.4 })).toBe(false);
  });

  it('does not re-report a reading that was already extreme', () => {
    const busy = { ...EXAMPLE, onsetRatio: 2.2, slope4: 9 };
    expect(s.sectionChanged(busy, busy)).toBe(false);
  });

  it('hears the key move, when it is sure of the mode', () => {
    const sure = { ...EXAMPLE, modeConf: 0.7 };
    expect(s.sectionChanged(sure, { ...sure, key: 'A' })).toBe(true);
    expect(s.sectionChanged({ ...sure, modeConf: 0.2 }, { ...sure, key: 'A', modeConf: 0.2 })).toBe(false);
    expect(s.sectionChanged(sure, { ...sure, key: '?' })).toBe(false);
  });
});

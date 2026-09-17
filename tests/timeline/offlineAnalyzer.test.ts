import { describe, expect, it } from 'vitest';
import { ONSET_REPORT_LAG_SEC } from '../../src/analysis/onset';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { analyzeOffline, mergeSegments } from '../../src/timeline/offlineAnalyzer';
import { clickTrack, concatSignals } from '../helpers/synth';
import { EXAMPLE_INPUT } from '../helpers/moodFixture';
import type { MoodInput, MoodVector } from '../../src/shared/types';

const SR = 44100;
/** Where the quiet half ends, the hole opens and the loud half slams in. */
const SWITCH_SEC = 10;
const GAP_SEC = 0.3;
const TOTAL_SEC = 30;

/** `signal` scaled in place — how loud a section is, is the point here. */
function gain(signal: Float32Array, g: number): Float32Array {
  for (let i = 0; i < signal.length; i++) signal[i] = signal[i]! * g;
  return signal;
}

/** A decaying two-octave thump on every beat: the low end a drop lands with. */
function bassOn(signal: Float32Array, bpm: number, sr: number): Float32Array {
  const period = (60 / bpm) * sr;
  const length = Math.round(0.15 * sr);
  for (let beat = 0; beat * period < signal.length; beat++) {
    const start = Math.round(beat * period);
    for (let i = 0; i < length; i++) {
      const at = start + i;
      if (at >= signal.length) break;
      const env = Math.exp((-5 * i) / length);
      const phase = (2 * Math.PI * i) / sr;
      signal[at] = signal[at]! + 0.45 * env * (Math.sin(45 * phase) + Math.sin(90 * phase));
    }
  }
  return signal;
}

/**
 * Ten seconds of quiet, bass-free 90 BPM clicks, a 0.3 s hole, then twenty
 * seconds of loud 128 BPM clicks with a kick under every beat.
 *
 * `beatsPerBar` is set past the end of the section so the fixture's own accent
 * thump never fires: the only low end in the first half would otherwise be a
 * drop waiting to be called.
 */
function twoHalves(sr = SR): Float32Array {
  const quiet = gain(clickTrack(90, SWITCH_SEC - GAP_SEC, sr, 10_000), 0.12);
  const hole = new Float32Array(Math.round(GAP_SEC * sr));
  const loud = bassOn(clickTrack(128, TOTAL_SEC - SWITCH_SEC, sr, 10_000), 128, sr);
  return concatSignals(quiet, hole, loud);
}

function fakeJev(): { ask: (i: MoodInput) => Promise<MoodVector>; inputs: MoodInput[] } {
  const inputs: MoodInput[] = [];
  return {
    inputs,
    ask: async (input: MoodInput): Promise<MoodVector> => {
      inputs.push(input);
      return { ...NEUTRAL_MOOD, arousal: Math.min(1, input.bpm / 200) };
    },
  };
}

describe('analyzeOffline', () => {
  it('sweeps a track into features, segments and a timeline', { timeout: 120_000 }, async () => {
    const jev = fakeJev();
    const progress: number[] = [];
    const result = await analyzeOffline(twoHalves(), SR, jev.ask, (p) => progress.push(p));

    // ~60 frames a second of the whole track.
    expect(result.features.length).toBeGreaterThan(TOTAL_SEC * 55);
    expect(result.features.length).toBeLessThan(TOTAL_SEC * 65);
    expect(result.features[result.features.length - 1]!.t).toBeGreaterThan(TOTAL_SEC - 0.2);

    // The track turns over at ten seconds, so there is more than one section.
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    expect(result.segments.length).toBeLessThanOrEqual(40);
    expect(result.segments[0]!.start).toBe(0);
    expect(result.segments[result.segments.length - 1]!.end).toBeCloseTo(TOTAL_SEC, 1);
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i]!.start).toBe(result.segments[i - 1]!.end);
      // Every segment but the last one earned its minimum length.
      expect(result.segments[i - 1]!.end - result.segments[i - 1]!.start).toBeGreaterThanOrEqual(8);
    }
    // One boundary is the switch itself.
    expect(result.segments.some((s) => Math.abs(s.start - SWITCH_SEC) < 2)).toBe(true);

    // One call per segment, and a mood cue where each one starts.
    expect(jev.inputs).toHaveLength(result.segments.length);
    const moods = result.timeline.filter((c) => c.mood !== undefined);
    expect(moods).toHaveLength(result.segments.length);
    for (const s of result.segments) {
      expect(moods.some((c) => Math.abs(c.t - s.start) <= 0.005)).toBe(true);
    }
    expect(result.timeline.every((c) => c.source === 'offline')).toBe(true);

    // The slam is on the timeline at the frame the detector called it on —
    // analysis time, one reporting lag after the sound. The reader takes that
    // off once, for every source at once.
    const impacts = result.timeline.filter((c) => c.impact !== undefined);
    expect(impacts.some((c) => Math.abs(c.t - (SWITCH_SEC + ONSET_REPORT_LAG_SEC)) <= 0.03)).toBe(
      true,
    );

    // Every hole lets go again rather than pinning the build at 1.
    const builds = result.timeline.filter((c) => c.build !== undefined);
    for (const held of builds.filter((c) => c.build === 1)) {
      expect(builds.some((c) => c.build === 0 && c.t > held.t && c.t - held.t <= 1.5)).toBe(true);
    }

    // Beats cover the track — including the part that played before the tempo
    // was measurable, back-filled at the period the grid settled on.
    const beats = result.timeline.filter((c) => c.beat === true);
    expect(beats.length).toBeGreaterThan(40);
    // The first beat is inside the first period: nothing before it is missing.
    const firstPeriod = beats[1]!.t - beats[0]!.t;
    expect(firstPeriod).toBeGreaterThan(0.2);
    expect(beats[0]!.t).toBeLessThan(firstPeriod);
    expect(beats.some((c) => c.t < 5 && c.downbeat === true)).toBe(true);
    expect(beats[beats.length - 1]!.t).toBeGreaterThan(TOTAL_SEC - 1.5);
    expect(beats.some((c) => c.downbeat === true)).toBe(true);
    // Sorted, and nothing before the track started.
    expect(result.timeline.map((c) => c.t)).toEqual(
      [...result.timeline.map((c) => c.t)].sort((a, b) => a - b),
    );
    expect(result.timeline[0]!.t).toBeGreaterThanOrEqual(0);

    // Progress runs forward and finishes.
    expect(progress.length).toBeGreaterThan(5);
    expect(progress[progress.length - 1]).toBeCloseTo(1, 6);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
  });

  it('asks nothing of a track with no audio in it', { timeout: 60_000 }, async () => {
    const jev = fakeJev();
    const result = await analyzeOffline(new Float32Array(SR * 5), SR, jev.ask);

    expect(result.segments).toHaveLength(1);
    expect(jev.inputs).toHaveLength(1);
    expect(result.timeline.filter((c) => c.impact !== undefined)).toHaveLength(0);
  });

  it('back-fills the beats before the tempo was known', { timeout: 60_000 }, async () => {
    const jev = fakeJev();
    const result = await analyzeOffline(twoHalves(), SR, jev.ask);
    const beats = result.timeline.filter((c) => c.beat === true).map((c) => c.t);

    // The grid cannot lock until it has heard a few seconds, but the track
    // started at 0 and the visuals have to have something to hit before then.
    expect(beats[0]!).toBeGreaterThanOrEqual(0);
    expect(beats[0]!).toBeLessThan(1);
    // Evenly spaced from the start: the back-fill uses the settled period.
    const early = beats.filter((t) => t < 5);
    expect(early.length).toBeGreaterThan(4);
    for (let i = 2; i < early.length; i++) {
      expect(early[i]! - early[i - 1]!).toBeCloseTo(early[1]! - early[0]!, 3);
    }
  });

  it('has nothing to say about an empty buffer', { timeout: 10_000 }, async () => {
    const jev = fakeJev();
    const result = await analyzeOffline(new Float32Array(0), SR, jev.ask);

    expect(result.features).toHaveLength(0);
    expect(result.segments).toHaveLength(0);
    expect(result.timeline).toHaveLength(0);
    expect(jev.inputs).toHaveLength(0);
  });
});

describe('mergeSegments', () => {
  /** Payloads every half second, as the sweep takes them. */
  function samplesTo(duration: number): Array<{ t: number; input: MoodInput }> {
    const out: Array<{ t: number; input: MoodInput }> = [];
    for (let t = 0; t < duration; t += 0.5) out.push({ t, input: { ...EXAMPLE_INPUT } });
    return out;
  }

  /** `count` spans, every `runtEvery`-th of them a one-second runt. */
  function spans(count: number, runtEvery: number): Array<{ start: number; end: number }> {
    const out: Array<{ start: number; end: number }> = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      const length = i > 0 && i % runtEvery === 0 ? 1 : 9;
      out.push({ start: at, end: at + length });
      at += length;
    }
    return out;
  }

  it('folds the shortest span into its shorter neighbour until the ceiling', () => {
    const raw = spans(45, 8);
    const duration = raw[raw.length - 1]!.end;
    const samples = samplesTo(duration);
    const takenAt = (input: MoodInput): number => samples.find((s) => s.input === input)!.t;
    const out = mergeSegments(raw, samples);

    expect(out).toHaveLength(40);
    // Still one unbroken cover of the track, in order.
    expect(out[0]!.start).toBe(0);
    expect(out[out.length - 1]!.end).toBe(duration);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBe(out[i - 1]!.end);
    // The runts are what went: the five shortest spans, and only those.
    expect(out.filter((s) => s.end - s.start === 1)).toHaveLength(0);
    // And each one is described by a payload from inside it.
    for (const s of out) {
      expect(takenAt(s.input)).toBeGreaterThanOrEqual(s.start - 0.5);
      expect(takenAt(s.input)).toBeLessThanOrEqual(s.end + 0.5);
    }
  });

  it('leaves a list already inside the ceiling alone', () => {
    const raw = spans(12, 8);
    const out = mergeSegments(raw, samplesTo(raw[raw.length - 1]!.end));

    expect(out.map((s) => [s.start, s.end])).toEqual(raw.map((s) => [s.start, s.end]));
  });

  it('drops a span it has no payload for', () => {
    const out = mergeSegments([{ start: 0, end: 10 }], []);
    expect(out).toHaveLength(0);
  });
});

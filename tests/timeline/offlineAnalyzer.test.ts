import { describe, expect, it } from 'vitest';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { analyzeOffline } from '../../src/timeline/offlineAnalyzer';
import { clickTrack, concatSignals } from '../helpers/synth';
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

    // The slam is on the timeline at the instant it happened.
    const impacts = result.timeline.filter((c) => c.impact !== undefined);
    expect(impacts.some((c) => Math.abs(c.t - SWITCH_SEC) <= 0.03)).toBe(true);

    // Beats cover the track from the moment the tempo is first measurable.
    const beats = result.timeline.filter((c) => c.beat === true);
    expect(beats.length).toBeGreaterThan(40);
    expect(beats[0]!.t).toBeLessThan(12);
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

  it('has nothing to say about an empty buffer', { timeout: 10_000 }, async () => {
    const jev = fakeJev();
    const result = await analyzeOffline(new Float32Array(0), SR, jev.ask);

    expect(result.features).toHaveLength(0);
    expect(result.segments).toHaveLength(0);
    expect(result.timeline).toHaveLength(0);
    expect(jev.inputs).toHaveLength(0);
  });
});

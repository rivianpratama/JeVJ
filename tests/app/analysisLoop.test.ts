import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisLoop } from '../../src/app/analysisLoop';
import { BeatGrid } from '../../src/analysis/grid';
import type { AudioGraph } from '../../src/source/audioGraph';
import { clickTrack, windowsFrom } from '../helpers/synth';

/** A metronome that accents every third beat. */
function waltz(bpm: number, seconds: number, sr: number): Float32Array {
  return clickTrack(bpm, seconds, sr, 3);
}

const FS = 44100;
const FFT = 4096;

/** An `AudioGraph` that plays a pre-rendered signal, one frame per read. */
function fakeGraph(signal: Float32Array): AudioGraph {
  const frames = windowsFrom(signal, FS, FFT);
  let i = 0;
  return {
    ctx: { sampleRate: FS } as AudioContext,
    analyser: { fftSize: FFT } as AnalyserNode,
    connectSource: () => {},
    disconnectSource: () => {},
    readFrame: () => frames[Math.min(i++, frames.length - 1)]!,
  };
}

/** Nothing here waits on the display, but `start` schedules against it. */
beforeEach(() => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
});

describe('AnalysisLoop', () => {
  it('has nothing to report before it has run', () => {
    expect(new AnalysisLoop().latest()).toBeNull();
  });

  it('finds the tempo and phase of a click track', () => {
    const loop = new AnalysisLoop();
    const signal = clickTrack(120, 12, FS);
    loop.start(fakeGraph(signal));
    for (let i = 0; i < Math.floor((12 * FS) / 735); i++) loop.step();

    const snap = loop.latest();
    expect(snap).not.toBeNull();
    expect(snap!.tempo?.bpm).toBeGreaterThanOrEqual(118);
    expect(snap!.tempo?.bpm).toBeLessThanOrEqual(122);
    expect(snap!.grid.bpm).toBe(snap!.tempo?.bpm);
    expect(snap!.grid.confidence).toBeGreaterThan(0.5);
    expect(snap!.phase).toBeGreaterThanOrEqual(0);
    expect(snap!.phase).toBeLessThan(1);
    // Beats keep coming, and the grid stays near the real ones.
    expect(snap!.grid.beatIndex).toBeGreaterThan(8);
    const offset = Math.abs(snap!.grid.nextBeat % 0.5);
    expect(Math.min(offset, 0.5 - offset)).toBeLessThan(0.05);
  });

  it('measures no tempo before it has a window of audio to measure', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 12, FS)));
    for (let i = 0; i < 60; i++) loop.step(); // one second

    expect(loop.latest()!.tempo).toBeNull();
    expect(loop.latest()!.grid.confidence).toBe(0);
  });

  it('reports onsets as they pass', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 8, FS)));
    let onsets = 0;
    for (let i = 0; i < Math.floor((8 * FS) / 735); i++) {
      loop.step();
      if (loop.latest()!.onset > 0) onsets += 1;
    }

    expect(onsets).toBeGreaterThanOrEqual(14);
    expect(onsets).toBeLessThanOrEqual(18);
  });

  it('keeps quiet, and keeps its grid, when the audio is silent', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(new Float32Array(8 * FS)));
    for (let i = 0; i < Math.floor((8 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(snap.onset).toBe(0);
    expect(snap.tempo?.confidence).toBe(0);
    expect(snap.grid.confidence).toBe(0); // never anchored to noise
    expect(snap.beats).toHaveLength(0);
  });

  it('carries every tracker in its snapshot', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 12, FS)));
    for (let i = 0; i < Math.floor((12 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(['duple', 'triple', 'unclear']).toContain(snap.rhythm.meter);
    expect(snap.rhythm.regular).toBeGreaterThan(0.5); // a metronome, after all
    expect(snap.rhythm.sync).toBeLessThan(0.3);
    expect(snap.rhythm.onsetsPerSec).toBeGreaterThan(1);
    expect(snap.timbre.attack).toBe('sharp');
    expect(snap.timbre.consonance).toBeGreaterThanOrEqual(0);
    expect(snap.timbre.consonance).toBeLessThanOrEqual(1);
    expect(snap.dynamics.trend).toBe('steady');
    // A bare metronome is silence with clicks in it, so it genuinely reports
    // a hole in every beat. Only the type is worth asserting here; what a gap
    // is gets decided in the dynamics tests, on music-shaped loudness.
    expect(typeof snap.dynamics.gap).toBe('boolean');
    expect(snap.speech).toBeLessThan(0.5);
    expect(snap.key.tonic).toBeGreaterThanOrEqual(-1);
  });

  it('carries the last drop it heard, and nothing before one', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 12, FS)));
    loop.step();
    expect(loop.latest()!.drop).toBeNull();

    const kinds = new Set<string>();
    let lastAt = -1;
    for (let i = 0; i < Math.floor((12 * FS) / 735); i++) {
      loop.step();
      const d = loop.latest()!.drop;
      if (d && d.t !== lastAt) {
        lastAt = d.t;
        kinds.add(d.kind);
        expect(d.strength).toBeGreaterThan(0);
        expect(d.t).toBeLessThanOrEqual(loop.latest()!.features.t);
      }
    }

    // A bare metronome is silence with 5 ms of noise in it, so what it
    // reports is the hole rather than the slam — the clicks carry too little
    // of the low end to pass for a drop. What matters here is that the events
    // reach the snapshot and stay in it; which events a click track earns is
    // settled against synthetic loudness in the detector's own tests.
    expect([...kinds]).toEqual(['gap']);
    expect(loop.latest()!.drop).not.toBeNull();
  });

  it('hears no drop in silence', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(new Float32Array(8 * FS)));
    for (let i = 0; i < Math.floor((8 * FS) / 735); i++) loop.step();
    expect(loop.latest()!.drop).toBeNull();
  });

  it('has nothing to say about a key it has not heard', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(new Float32Array(4 * FS)));
    for (let i = 0; i < Math.floor((4 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(snap.key.key).toBe('?');
    expect(snap.key.mode).toBe('unclear');
    expect(snap.rhythm.meter).toBe('unclear');
    expect(snap.dynamics.slope4).toBe(0);
  });

  it('hands the meter it hears to the grid, and counts in three for it', () => {
    const loop = new AnalysisLoop();
    // A waltz: a strong beat then two weak ones, at 90 BPM.
    const signal = waltz(90, 20, FS);
    loop.start(fakeGraph(signal));
    for (let i = 0; i < Math.floor((20 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(snap.rhythm.meter).toBe('triple');
    expect(snap.grid.barLength).toBe(3);
  });

  it('does not churn the grid over a steady four-four click track', () => {
    // Every reading the loop forwards costs the grid its downbeat evidence, so
    // a meter that flickers costs it repeatedly. Un-debounced this track drew
    // two calls in twenty seconds — a spurious triple and the retraction of it
    // — and the spurious one left the grid counting in three.
    const spy = vi.spyOn(BeatGrid.prototype, 'setMeter');
    try {
      const loop = new AnalysisLoop();
      loop.start(fakeGraph(clickTrack(120, 20, FS)));
      const lengths = new Set<number>();
      for (let i = 0; i < Math.floor((20 * FS) / 735); i++) {
        loop.step();
        // Before the first tempo estimate the phase is fiction and no meter
        // evidence is counted at all; from there on the bar stays four.
        if (loop.latest()!.tempo !== null) lengths.add(loop.latest()!.grid.barLength);
      }

      // A 4 → 4 call is a no-op inside the grid, so one is tolerated.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      expect([...lengths]).toEqual([4]);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops reading once stopped', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 4, FS)));
    loop.step();
    const first = loop.latest()!.features.t;
    loop.stop();
    loop.step();

    expect(loop.latest()!.features.t).toBe(first);
  });
});

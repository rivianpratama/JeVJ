import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisLoop } from '../../src/app/analysisLoop';
import type { AudioGraph } from '../../src/source/audioGraph';
import { clickTrack, windowsFrom } from '../helpers/synth';

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

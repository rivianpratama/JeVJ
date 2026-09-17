import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisLoop } from '../../src/app/analysisLoop';
import { hudRows, phaseBar } from '../../src/app/hudRows';
import type { AudioGraph } from '../../src/source/audioGraph';
import { clickTrack, windowsFrom } from '../helpers/synth';

const FS = 44100;
const FFT = 4096;

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

beforeEach(() => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
});

/** The snapshot after `seconds` of `signal`. */
function after(signal: Float32Array, seconds: number) {
  const loop = new AnalysisLoop();
  loop.start(fakeGraph(signal));
  for (let i = 0; i < Math.floor((seconds * FS) / 735); i++) loop.step();
  return loop.latest()!;
}

describe('hudRows', () => {
  it('prints what the trackers found', () => {
    const rows = hudRows(after(clickTrack(120, 12, FS), 12));

    expect(rows.bpm).toBe(120);
    expect(typeof rows.key).toBe('string');
    expect(['major', 'minor', 'unclear']).toContain(rows.mode);
    expect(['pp', 'p', 'mp', 'mf', 'f', 'ff']).toContain(rows.loud);
    expect(rows.speech).toBeGreaterThanOrEqual(0);
    expect(rows.speech).toBeLessThanOrEqual(1);

    const mood = rows.mood!;
    for (const field of ['modal', 'consonance', 'meter', 'sync', 'regular', 'range', 'trend', 'attack']) {
      expect(mood[field]).toBeDefined();
    }
  });

  it('prints what the mood feed knows, once it knows it', () => {
    const snap = after(clickTrack(120, 12, FS), 12);
    const quiet = after(new Float32Array(2 * FS), 2);

    // A dash until there is something to print. Nothing ever happens in
    // silence, so that is where "no drop yet" can be read honestly.
    expect(hudRows(snap).mood!['novelty']).toBe('—');
    expect(hudRows(snap).mood!['tokens']).toBe('—');
    expect(hudRows(quiet).mood!['drop']).toBe('—');

    const mood = hudRows({ ...snap, drop: { t: 3, strength: 0.75, kind: 'impact' } }, {
      novelty: 0.4267,
      tokens: 142,
    }).mood!;
    expect(mood['novelty']).toBe('0.43');
    expect(mood['tokens']).toBe(142);
    expect(mood['drop']).toBe('impact 0.75');
  });

  it('says nothing has been measured before anything has', () => {
    const rows = hudRows(after(new Float32Array(2 * FS), 2));

    expect(rows.bpm).toBe('—');
    expect(rows.beatConf).toBe('—');
    expect(rows.key).toBe('?');
    expect(rows.mood!['meter']).toBe('unclear');
  });
});

describe('phaseBar', () => {
  it('slides one mark along a ten-cell track', () => {
    expect(phaseBar(0)).toBe('|·········');
    expect(phaseBar(0.95)).toBe('·········|');
    expect(phaseBar(0.5)).toHaveLength(10);
  });
});

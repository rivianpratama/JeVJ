import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisLoop } from '../../src/app/analysisLoop';
import { hudRows, phaseBar } from '../../src/app/hudRows';
import type { AudioGraph } from '../../src/source/audioGraph';
import { clickTrack, windowsFrom } from '../helpers/synth';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';

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
    expect(hudRows(snap).mood!['payload']).toBe('—');
    expect(hudRows(quiet).mood!['drop']).toBe('—');

    const now = snap.features.t;
    const mood = hudRows({ ...snap, drop: { t: now - 1, strength: 0.75, kind: 'impact' } }, {
      novelty: 0.4267,
      tokens: 142,
    }).mood!;
    expect(mood['novelty']).toBe('0.43');
    expect(mood['payload']).toBe(142);
    expect(mood['drop']).toBe('impact 0.75');
  });

  it('prints the mood the director is actually drawing with, and where it came from', () => {
    // Not Jev's last answer: the renderer draws with the live mood merged with
    // whatever the timeline overrides, and a HUD that prints the other one is
    // a diagnostic that lies. The `mood src` row says which layer had the last
    // word, so a disagreement is readable rather than mysterious.
    const snap = after(clickTrack(120, 12, FS), 12);
    const effective = { ...NEUTRAL_MOOD, arousal: 0.9375, motion: 'shatter' as const };

    const live = hudRows(snap, { novelty: 0.2, tokens: 1, mood: NEUTRAL_MOOD, moodSrc: 'live' });
    expect(live.mood!['mood src']).toBe('live');

    const timeline = hudRows(snap, {
      novelty: 0.2,
      tokens: 1,
      mood: effective,
      moodSrc: 'timeline',
    });
    expect(timeline.mood!['arousal']).toBe('0.94');
    expect(timeline.mood!['motion']).toBe('shatter');
    expect(timeline.mood!['mood src']).toBe('timeline');

    const idle = hudRows(snap, { novelty: 0.2, tokens: 1, mood: NEUTRAL_MOOD, moodSrc: 'idle' });
    expect(idle.mood!['mood src']).toBe('idle');
  });

  it('prints jev\'s judgment and what it has cost, once there is one', () => {
    const snap = after(clickTrack(120, 12, FS), 12);
    const rows = hudRows(snap, {
      novelty: 0.2,
      tokens: 142,
      mood: { ...NEUTRAL_MOOD, valence: 0.8125, genre: 'jazz', motion: 'swarm', dropImminent: 0.5 },
      jev: { calls: 3, tokens: 5400, lastLatencyMs: 212, nextIn: 1.25 },
    });

    expect(rows.mood!['valence']).toBe('0.81');
    expect(rows.mood!['genre']).toBe('jazz');
    expect(rows.mood!['motion']).toBe('swarm');
    expect(rows.mood!['dropImminent']).toBe('0.50');
    expect(rows.mood!['next in']).toBe('1.3s');
    expect(rows.calls).toBe(3);
    expect(rows.tokensTotal).toBe(5400);
    expect(rows.lastLatencyMs).toBe(212);
  });

  it('leaves the jev rows out entirely before the first answer', () => {
    const rows = hudRows(after(clickTrack(120, 12, FS), 12), { novelty: 0.2, tokens: 142 });
    expect(rows.mood!['valence']).toBeUndefined();
    expect(rows.mood!['mood src']).toBeUndefined();
    expect(rows.calls).toBeUndefined();
    expect(rows.tokensTotal).toBeUndefined();
  });

  it('holds a drop for two seconds and then lets it go', () => {
    const snap = after(clickTrack(120, 12, FS), 12);
    const now = snap.features.t;
    const at = (age: number) =>
      hudRows({ ...snap, drop: { t: now - age, strength: 0.75, kind: 'impact' } }).mood!['drop'];

    // The detector's event is sticky so nobody misses it; the row is not, or
    // the HUD would still be announcing a drop from a minute ago.
    expect(at(1.9)).toBe('impact 0.75');
    expect(at(2.5)).toBe('—');
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

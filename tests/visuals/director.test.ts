import { describe, expect, it } from 'vitest';
import { IDLE_MOOD, direct, type FastFrame, type RenderParams } from '../../src/visuals/director';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import type { MoodVector } from '../../src/shared/types';

const FRAME = 1 / 60;

function fast(over: Partial<FastFrame> = {}): FastFrame {
  return {
    rms: 0,
    bands: new Float32Array(8),
    sub: 0,
    onset: 0,
    beatPhase: 0,
    downbeatPulse: 0,
    impact: 0,
    build: 0,
    ...over,
  };
}

function mood(over: Partial<MoodVector>): MoodVector {
  return { ...NEUTRAL_MOOD, ...over };
}

/** Run `frames` frames of the director, returning every params object. */
function run(
  frames: number,
  m: MoodVector,
  f: (i: number) => FastFrame,
  reduced = false,
): RenderParams[] {
  const out: RenderParams[] = [];
  let prev: RenderParams | null = null;
  for (let i = 0; i < frames; i++) {
    prev = direct(m, f(i), FRAME, prev, reduced);
    out.push(prev);
  }
  return out;
}

describe('direct', () => {
  it('puts everything into the ink scene for now', () => {
    const p = direct(IDLE_MOOD, fast(), FRAME, null, false);
    expect(p.weights.ink).toBe(1);
    const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('opens the flow and the bloom up at full arousal', () => {
    const p = direct(mood({ arousal: 1 }), fast(), FRAME, null, false);
    expect(p.flowAmt).toBeGreaterThan(0.7);
    expect(p.bloomStrength).toBeGreaterThan(1.0);
  });

  it('closes the flow down at zero arousal', () => {
    const p = direct(mood({ arousal: 0 }), fast(), FRAME, null, false);
    expect(p.flowAmt).toBeLessThan(0.2);
  });

  it('turns the kaleidoscope on only for hypnotic or hypnotic dance music', () => {
    expect(direct(mood({ hypnotic: 0.8, tension: 1 }), fast(), FRAME, null, false).mirrorFolds).toBe(8);
    expect(
      direct(mood({ hypnotic: 0.5, tension: 1, genre: 'electronic_dance' }), fast(), FRAME, null, false)
        .mirrorFolds,
    ).toBe(8);
    expect(direct(mood({ hypnotic: 0.5, tension: 1, genre: 'pop' }), fast(), FRAME, null, false).mirrorFolds).toBe(0);
  });

  it('honours reduced motion', () => {
    const m = mood({ hypnotic: 1, tension: 1, arousal: 1, synthetic: 1 });
    const loud = fast({ impact: 1, sub: 1 });
    const full = direct(m, loud, FRAME, null, false);
    const calm = direct(m, loud, FRAME, null, true);
    expect(calm.mirrorFolds).toBe(0);
    expect(calm.flowAmt).toBeCloseTo(full.flowAmt / 2, 6);
    expect(calm.pushKick).toBeCloseTo(full.pushKick / 2, 6);
    expect(calm.chroma).toBeCloseTo(full.chroma / 2, 6);
    expect(calm.exposure).toBeLessThanOrEqual(1.1);
  });

  it('lifts exposure on an impact', () => {
    const p = direct(mood({}), fast({ impact: 1 }), FRAME, null, false);
    expect(p.exposure).toBeGreaterThanOrEqual(1.2);
  });

  it('kicks the ink outward on an impact without waiting for the slew', () => {
    const quiet = direct(mood({}), fast(), FRAME, null, false);
    const hit = direct(mood({}), fast({ impact: 1 }), FRAME, quiet, false);
    expect(hit.pushKick).toBeGreaterThan(quiet.pushKick + 0.07);
  });

  it('slews the slow scalars rather than jumping', () => {
    const still = direct(mood({ arousal: 0 }), fast(), FRAME, null, false);
    const next = direct(mood({ arousal: 1 }), fast(), FRAME, still, false);
    // One frame of a 0.8 s time constant moves about 2% of the way.
    expect(next.flowAmt).toBeGreaterThan(still.flowAmt);
    expect(next.flowAmt).toBeLessThan(still.flowAmt + 0.1);
  });

  it('caps luminance direction flips at 3 per second', () => {
    // A frame-alternating impact would strobe at 30 Hz if nothing stopped it.
    const frames = run(60, mood({}), (i) => fast({ impact: i % 2 === 0 ? 1 : 0 }));
    let flips = 0;
    let dir = 0;
    for (let i = 1; i < frames.length; i++) {
      const d = Math.sign(frames[i]!.exposure - frames[i - 1]!.exposure);
      if (d !== 0) {
        if (dir !== 0 && d !== dir) flips++;
        dir = d;
      }
    }
    expect(flips).toBeLessThanOrEqual(3);
  });

  it('still lets exposure move when the music is not strobing', () => {
    // A single hit that decays over half a second must be followed, not held.
    const frames = run(60, mood({}), (i) => fast({ impact: Math.max(0, 1 - i / 30) }));
    expect(frames[0]!.exposure).toBeGreaterThan(1.2);
    expect(frames[59]!.exposure).toBeCloseTo(1, 2);
  });

  it('follows the motion label as the flow style', () => {
    expect(direct(mood({ motion: 'swarm' }), fast(), FRAME, null, false).flowStyle).toBe('swarm');
  });

  it('holds the ink longer in a build', () => {
    const flat = direct(mood({ hypnotic: 0 }), fast({ build: 0 }), FRAME, null, false);
    const rising = direct(mood({ hypnotic: 0 }), fast({ build: 1 }), FRAME, null, false);
    expect(rising.decay).toBeGreaterThan(flat.decay);
    expect(rising.decay).toBeLessThan(1);
  });

  it('turns posterize on only for hard synthetic peaks', () => {
    expect(direct(mood({ synthetic: 1, arousal: 1 }), fast(), FRAME, null, false).posterize).toBe(6);
    expect(direct(mood({ synthetic: 1, arousal: 0.5 }), fast(), FRAME, null, false).posterize).toBe(0);
  });

  it('is idle-safe: IDLE_MOOD is a drifting ambient intro', () => {
    expect(IDLE_MOOD.genre).toBe('ambient_drone');
    expect(IDLE_MOOD.section).toBe('intro');
    expect(IDLE_MOOD.motion).toBe('drift');
    const p = direct(IDLE_MOOD, fast(), FRAME, null, false);
    expect(p.mirrorFolds).toBe(0);
    expect(p.posterize).toBe(0);
    expect(p.exposure).toBeCloseTo(1, 6);
  });
});

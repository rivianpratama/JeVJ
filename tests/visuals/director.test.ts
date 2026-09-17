import { describe, expect, it } from 'vitest';
import {
  IDLE_MOOD,
  createDirector,
  direct,
  type FastFrame,
  type RenderParams,
} from '../../src/visuals/director';
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
  const state = createDirector();
  let prev: RenderParams | null = null;
  for (let i = 0; i < frames; i++) {
    prev = direct(state, m, f(i), FRAME, prev, reduced);
    out.push(prev);
  }
  return out;
}

/** One frame from a director that has never run before. */
function once(m: MoodVector, f: FastFrame = fast(), reduced = false): RenderParams {
  return direct(createDirector(), m, f, FRAME, null, reduced);
}

describe('direct', () => {
  it('puts everything into the ink scene for now', () => {
    const p = once(IDLE_MOOD, fast());
    expect(p.weights.ink).toBe(1);
    const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('opens the flow and the bloom up at full arousal', () => {
    const p = once(mood({ arousal: 1 }), fast());
    expect(p.flowAmt).toBeGreaterThan(0.7);
    expect(p.bloomStrength).toBeGreaterThan(1.0);
  });

  it('closes the flow down at zero arousal', () => {
    const p = once(mood({ arousal: 0 }), fast());
    expect(p.flowAmt).toBeLessThan(0.2);
  });

  it('turns the kaleidoscope on only for hypnotic music, and never past six folds', () => {
    // Eight folds read as sharp static spokes rather than as a figure; the
    // range is 2..6, and hypnotic is the only thing that opens it. Dance music
    // that is merely repetitive is not asking to be kaleidoscoped.
    expect(once(mood({ hypnotic: 0.8, tension: 1 }), fast()).mirrorFolds).toBe(6);
    expect(once(mood({ hypnotic: 0.8, tension: 0 }), fast()).mirrorFolds).toBe(2);
    expect(
      once(mood({ hypnotic: 0.5, tension: 1, genre: 'electronic_dance' }), fast()).mirrorFolds,
    ).toBe(0);
    expect(once(mood({ hypnotic: 0.5, tension: 1, genre: 'pop' }), fast()).mirrorFolds).toBe(0);
  });

  it('holds the fold count until a different one has been wanted for half a second', () => {
    // Tension wobbling across a rounding boundary would otherwise re-fold the
    // whole screen several times a second.
    const state = createDirector();
    let prev = direct(state, mood({ hypnotic: 1, tension: 0 }), fast(), FRAME, null, false);
    expect(prev.mirrorFolds).toBe(2);

    const wanted = mood({ hypnotic: 1, tension: 1 });
    // A quarter of a second of wanting six is not enough.
    for (let i = 0; i < 15; i++) prev = direct(state, wanted, fast(), FRAME, prev, false);
    expect(prev.mirrorFolds).toBe(2);
    // Another half second is.
    for (let i = 0; i < 30; i++) prev = direct(state, wanted, fast(), FRAME, prev, false);
    expect(prev.mirrorFolds).toBe(6);
  });

  it('honours reduced motion', () => {
    const m = mood({ hypnotic: 1, tension: 1, arousal: 1, synthetic: 1 });
    const loud = fast({ impact: 1, sub: 1 });
    const full = once(m, loud);
    const calm = once(m, loud, true);
    expect(calm.mirrorFolds).toBe(0);
    expect(calm.flowAmt).toBeCloseTo(full.flowAmt / 2, 6);
    expect(calm.pushKick).toBeCloseTo(full.pushKick / 2, 6);
    expect(calm.chroma).toBeCloseTo(full.chroma / 2, 6);
    expect(calm.exposure).toBeLessThanOrEqual(1.1);
  });

  it('lifts exposure on an impact', () => {
    const p = once(mood({}), fast({ impact: 1 }));
    expect(p.exposure).toBeGreaterThanOrEqual(1.2);
  });

  it('kicks the ink outward on an impact without waiting for the slew', () => {
    const state = createDirector();
    const quiet = direct(state, mood({}), fast(), FRAME, null, false);
    const hit = direct(state, mood({}), fast({ impact: 1 }), FRAME, quiet, false);
    expect(hit.pushKick).toBeGreaterThan(quiet.pushKick + 0.07);
  });

  it('slews the slow scalars rather than jumping', () => {
    const state = createDirector();
    const still = direct(state, mood({ arousal: 0 }), fast(), FRAME, null, false);
    const next = direct(state, mood({ arousal: 1 }), fast(), FRAME, still, false);
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
    expect(once(mood({ motion: 'swarm' }), fast()).flowStyle).toBe('swarm');
  });

  it('holds the ink longer in a build', () => {
    const flat = once(mood({ hypnotic: 0 }), fast({ build: 0 }));
    const rising = once(mood({ hypnotic: 0 }), fast({ build: 1 }));
    expect(rising.decay).toBeGreaterThan(flat.decay);
    expect(rising.decay).toBeLessThan(1);
  });

  it('turns posterize on only for hard synthetic peaks', () => {
    expect(once(mood({ synthetic: 1, arousal: 1 }), fast()).posterize).toBe(6);
    expect(once(mood({ synthetic: 1, arousal: 0.5 }), fast()).posterize).toBe(0);
  });

  it('reads the grain from the noisiness proxy', () => {
    // The mood vector carries no "noisiness", so grit and the absence of
    // machine-made stand in for it: 0.5·aggression + 0.5·(1 − synthetic),
    // mapped onto 0.03..0.12 so the grain is always visible.
    expect(once(mood({ aggression: 1, synthetic: 0 }), fast()).grain).toBeCloseTo(0.12, 6);
    expect(once(mood({ aggression: 0, synthetic: 1 }), fast()).grain).toBeCloseTo(0.03, 6);
    expect(once(mood({ aggression: 1, synthetic: 1 }), fast()).grain).toBeCloseTo(0.075, 6);
  });

  it('keeps its state per director, so two of them cannot interfere', () => {
    // The strobe limiter's clock used to be module-level: a second consumer —
    // a test, a second canvas — silently shared it.
    const a = createDirector();
    const b = createDirector();
    let pa: RenderParams | null = null;
    let pb: RenderParams | null = null;
    for (let i = 0; i < 30; i++) {
      pa = direct(a, mood({}), fast({ impact: i % 2 === 0 ? 1 : 0 }), FRAME, pa, false);
      pb = direct(b, mood({}), fast({ impact: i % 2 === 0 ? 1 : 0 }), FRAME, pb, false);
    }
    expect(pb!.exposure).toBeCloseTo(pa!.exposure, 12);
    expect(pb!.mirrorFolds).toBe(pa!.mirrorFolds);
  });

  it('is idle-safe: IDLE_MOOD is a drifting, violet-blue ambient intro', () => {
    expect(IDLE_MOOD.genre).toBe('ambient_drone');
    expect(IDLE_MOOD.section).toBe('intro');
    expect(IDLE_MOOD.motion).toBe('drift');
    // Violet-blue, not magenta, and awake enough for the field to breathe.
    expect(IDLE_MOOD.warmth).toBeCloseTo(0.15, 6);
    expect(IDLE_MOOD.arousal).toBeCloseTo(0.3, 6);
    const p = once(IDLE_MOOD, fast());
    expect(p.mirrorFolds).toBe(0);
    expect(p.posterize).toBe(0);
    expect(p.exposure).toBeCloseTo(1, 6);
  });
});

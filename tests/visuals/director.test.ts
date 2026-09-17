import { describe, expect, it } from 'vitest';
import {
  IDLE_MOOD,
  createDirector,
  direct,
  type FastFrame,
  type RenderParams,
} from '../../src/visuals/director';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { GENRES, MOTIONS, SECTIONS } from '../../src/shared/types';
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
  it('always mixes to exactly one, with the ink as the bed', () => {
    for (const m of [IDLE_MOOD, mood({}), mood({ arousal: 1 }), mood({ arousal: 0, tension: 1 })]) {
      const p = once(m, fast());
      const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 6);
      expect(p.weights.ink).toBeGreaterThan(0);
      for (const w of Object.values(p.weights)) expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it('mixes to one for every combination the mood layer can produce', () => {
    // The five-layer normalisation has two ways to go wrong that four layers
    // did not: a genre bonus that survives `spoken`, and a speech frame where
    // every other layer is zero. Both are covered by sweeping the corners.
    for (const genre of GENRES) {
      for (const section of SECTIONS) {
        for (const spoken of [0, 0.49, 0.5, 0.75, 1]) {
          for (const extreme of [0, 1]) {
            const p = once(
              mood({
                genre,
                section,
                spoken,
                arousal: extreme,
                tension: extreme,
                melancholy: extreme,
                aggression: extreme,
              }),
              fast({ impact: extreme, rms: extreme, sub: extreme }),
            );
            const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
            expect(sum).toBeCloseTo(1, 6);
            for (const w of Object.values(p.weights)) expect(w).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('gives the frame to the particles when the music is loud and not spoken', () => {
    const p = once(mood({ arousal: 1, spoken: 0 }), fast());
    expect(p.weights.particles).toBeGreaterThan(p.weights.strands);
    expect(p.weights.particles).toBeGreaterThan(0.3);
  });

  it('gives the frame to the strands when the music is quiet and tense', () => {
    const p = once(mood({ arousal: 0.1, tension: 0.9, spoken: 0 }), fast());
    expect(p.weights.strands).toBeGreaterThan(p.weights.particles);
    expect(p.weights.strands).toBeGreaterThan(0.3);
  });

  it('clears the frame for the voice: speech leaves only the breath', () => {
    // Dust, silk and terrain all read as *decoration* over a talking voice.
    // Task 10 left the ink carrying a podcast; Task 11 has a layer built for it.
    for (const motion of MOTIONS) {
      for (const genre of GENRES) {
        const p = once(mood({ spoken: 1, arousal: 1, tension: 1, motion, genre }), fast());
        expect(p.weights.particles).toBeCloseTo(0, 6);
        expect(p.weights.strands).toBeCloseTo(0, 6);
        expect(p.weights.relief).toBeCloseTo(0, 6);
        expect(p.weights.ink).toBeCloseTo(0, 6);
        expect(p.weights.breath).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  it('is safe under the breath: no mirror, no chroma, no posterize, no flash', () => {
    // The speech scene must never flash, so everything that can flash it is
    // switched off at the source rather than trusted to be quiet.
    const loud = fast({ impact: 1, sub: 1, downbeatPulse: 1 });
    const p = once(
      mood({ spoken: 1, arousal: 1, tension: 1, synthetic: 1, hypnotic: 1 }),
      loud,
    );
    expect(p.weights.breath).toBeGreaterThan(0.5);
    expect(p.mirrorFolds).toBe(0);
    expect(p.chroma).toBe(0);
    expect(p.posterize).toBe(0);
    expect(p.bloomStrength).toBeLessThanOrEqual(0.4);
    expect(p.exposure).toBeCloseTo(1, 6);

    // And it holds frame after frame, not only on the first one.
    const frames = run(120, mood({ spoken: 1, arousal: 1, synthetic: 1, hypnotic: 1 }), (i) =>
      fast({ impact: i % 2 === 0 ? 1 : 0, downbeatPulse: 1 }),
    );
    for (const f of frames) {
      expect(f.mirrorFolds).toBe(0);
      expect(f.chroma).toBe(0);
      expect(f.posterize).toBe(0);
      expect(f.bloomStrength).toBeLessThanOrEqual(0.4);
      expect(f.exposure).toBeCloseTo(1, 6);
    }
  });

  it('raises the relief for melancholy and for aggression, and not for a voice', () => {
    const sad = once(mood({ melancholy: 1, aggression: 0, spoken: 0 }), fast());
    expect(sad.weights.relief).toBeGreaterThan(0.3);
    const angry = once(mood({ melancholy: 0, aggression: 1, spoken: 0 }), fast());
    expect(angry.weights.relief).toBeGreaterThan(0.3);
    // `max`, not a sum: both at once is not twice as much terrain.
    const both = once(mood({ melancholy: 1, aggression: 1, spoken: 0 }), fast());
    expect(both.weights.relief).toBeCloseTo(angry.weights.relief, 6);
    // Flat mood, no terrain worth drawing.
    const flat = once(mood({ melancholy: 0, aggression: 0, spoken: 0, genre: 'pop' }), fast());
    expect(flat.weights.relief).toBeCloseTo(0, 6);
  });

  it('gives metal more terrain than pop at the same mood, and only metal', () => {
    // The drone bonus was dropped: `IDLE_MOOD` is an ambient drone, so it put a
    // fifth of the frame under a terrain on a page that had heard nothing.
    const m = { melancholy: 0.5, aggression: 0.5, spoken: 0 };
    const pop = once(mood({ ...m, genre: 'pop' }), fast());
    expect(once(mood({ ...m, genre: 'rock_metal' }), fast()).weights.relief).toBeGreaterThan(
      pop.weights.relief,
    );
    for (const genre of ['ambient_drone', 'jazz'] as const) {
      expect(once(mood({ ...m, genre }), fast()).weights.relief).toBeCloseTo(
        pop.weights.relief,
        6,
      );
    }
  });

  it('folds the mirror for dominant relief even when nothing is hypnotic', () => {
    // Terrain wants a mirror line; the reference is a mirrored ridge.
    const m = mood({
      melancholy: 1,
      aggression: 1,
      hypnotic: 0,
      arousal: 0,
      tension: 0,
      spoken: 0,
      genre: 'rock_metal',
      motion: 'flow',
    });
    const p = once(m, fast());
    expect(p.weights.relief).toBeGreaterThan(0.5);
    expect(p.mirrorFolds).toBeGreaterThanOrEqual(2);
    // Reduced motion still wins.
    expect(once(m, fast(), true).mirrorFolds).toBe(0);
  });

  it('reads the relief height off the mood and the contrast off the tension', () => {
    expect(once(mood({ aggression: 0, melancholy: 0 }), fast()).reliefHeight).toBeCloseTo(0.3, 6);
    expect(once(mood({ aggression: 1, melancholy: 1 }), fast()).reliefHeight).toBeCloseTo(1.2, 6);
    expect(once(mood({ aggression: 1, melancholy: 0 }), fast()).reliefHeight).toBeCloseTo(0.75, 6);
    expect(once(mood({ tension: 0 }), fast()).reliefContrast).toBeCloseTo(1, 6);
    expect(once(mood({ tension: 1 }), fast()).reliefContrast).toBeCloseTo(3, 6);
  });

  it('holds the ink longer and injects harder through a build', () => {
    const steady = once(mood({ section: 'verse_steady' }), fast());
    const building = once(mood({ section: 'build' }), fast());
    expect(building.decay).toBeCloseTo(steady.decay + 0.02, 6);
    expect(building.injectGain).toBeCloseTo(steady.injectGain * 1.3, 6);
    expect(building.particleDolly).toBeGreaterThan(0);
    expect(steady.particleDolly).toBe(0);
  });

  it('dissolves the ink and slows the dust through a breakdown', () => {
    const steady = once(mood({ section: 'verse_steady' }), fast());
    const down = once(mood({ section: 'breakdown' }), fast());
    expect(down.decay).toBeCloseTo(steady.decay - 0.03, 6);
    expect(down.particleSpeed).toBeCloseTo(steady.particleSpeed * 0.5, 6);
  });

  it('flares the bloom for a second after an impact in the climax', () => {
    const state = createDirector();
    const m = mood({ section: 'drop_climax' });
    let prev = direct(state, m, fast(), FRAME, null, false);
    const quiet = prev.bloomStrength;
    prev = direct(state, m, fast({ impact: 1 }), FRAME, prev, false);
    expect(prev.bloomStrength).toBeGreaterThan(quiet * 1.25);
    // Still lifted half a second later...
    for (let i = 0; i < 30; i++) prev = direct(state, m, fast(), FRAME, prev, false);
    expect(prev.bloomStrength).toBeGreaterThan(quiet * 1.25);
    // ...and back down after the second is up.
    for (let i = 0; i < 40; i++) prev = direct(state, m, fast(), FRAME, prev, false);
    expect(prev.bloomStrength).toBeCloseTo(quiet, 3);

    // Only in the climax: the same hit in a verse does nothing to the bloom.
    const verse = createDirector();
    let vp = direct(verse, mood({ section: 'verse_steady' }), fast(), FRAME, null, false);
    const before = vp.bloomStrength;
    vp = direct(verse, mood({ section: 'verse_steady' }), fast({ impact: 1 }), FRAME, vp, false);
    expect(vp.bloomStrength).toBeCloseTo(before, 3);
  });

  it('reads the attractor off the motion label', () => {
    expect(once(mood({ motion: 'swarm' }), fast()).attractor).toBe('swarm');
    expect(once(mood({ motion: 'pulse' }), fast()).attractor).toBe('sphere');
    expect(once(mood({ motion: 'shatter' }), fast()).attractor).toBe('explode');
    expect(once(mood({ motion: 'flow' }), fast()).attractor).toBe('plane');
    expect(once(mood({ motion: 'drift' }), fast()).attractor).toBe('plane');
  });

  it('swarms harder and drifts wider than the base weights ask', () => {
    const m = { arousal: 0.5, tension: 0.5, spoken: 0 };
    const base = once(mood({ ...m, motion: 'flow' }), fast());
    const swarm = once(mood({ ...m, motion: 'swarm' }), fast());
    const drift = once(mood({ ...m, motion: 'drift' }), fast());
    expect(swarm.weights.particles).toBeGreaterThan(base.weights.particles);
    expect(drift.weights.strands).toBeGreaterThan(base.weights.strands);

    // The exact sizes, pinned: a swarm is a takeover, a drift is a lean. At
    // arousal 1 the base strand weight is zero, so what is left of the drifting
    // silk is the bonus alone, against ink 0.55 and particles 1·1·(0.6+0.4·0.5).
    const onlyBonus = once(
      mood({ arousal: 1, spoken: 0, motion: 'drift', melancholy: 0, aggression: 0, genre: 'pop' }),
      fast(),
    );
    expect(onlyBonus.weights.strands).toBeCloseTo(0.1 / (0.55 + 0.8 + 0.1), 6);
  });

  it('opens on a mix, not on a takeover, for a page that has heard nothing', () => {
    // IDLE_MOOD drifts, and the drift bonus once put the strands *far* over the
    // ink before a note had been played — a curtain with no music behind it.
    //
    // Task 11 adds `(1 − spoken)` to the ink bed, which at IDLE_MOOD's spoken
    // 0.1 costs the ink the 10% every other layer was already paying, so the
    // silk now draws level with it. That is the brief's formula and it is left
    // alone: what stopped the curtain was never this ordering but the
    // visibility window in the strand shader, which at a 0.32 weight lights
    // about forty ribbons where the old one lit a hundred and sixty. The
    // invariant that still means something is that no layer runs away with an
    // idle frame.
    const p = once(IDLE_MOOD, fast());
    expect(p.weights.ink).toBeGreaterThan(p.weights.particles);
    expect(p.weights.ink).toBeGreaterThan(p.weights.relief);
    expect(p.weights.strands).toBeLessThan(0.42);
    expect(Math.abs(p.weights.strands - p.weights.ink)).toBeLessThan(0.02);
    expect(p.weights.breath).toBe(0);
    // And barely any terrain: `IDLE_MOOD` is calm, so the only bid the relief
    // has is melancholy and aggression at 0.1, which the blend's own
    // `w²·1.6` opacity then renders all but invisible.
    expect(p.weights.relief).toBeLessThan(0.07);
  });

  it('blooms into a soft explosion on the downbeat and settles back', () => {
    const m = mood({ motion: 'bloom' });
    const onIt = once(m, fast({ downbeatPulse: 1 }));
    const after = once(m, fast({ downbeatPulse: 0 }));
    expect(onIt.attractor).toBe('explode');
    // A bloom is not a shatter: the force is a fraction of a real burst.
    expect(onIt.attractorForce).toBeLessThan(0.5);
    expect(after.attractor).toBe('vortex');
    expect(after.attractorForce).toBeCloseTo(1, 6);
  });

  it('breathes the sphere radius across the bar when the motion is a pulse', () => {
    const m = mood({ motion: 'pulse' });
    expect(once(m, fast({ beatPhase: 0 })).attractorRadius).toBeCloseTo(1.2, 6);
    expect(once(m, fast({ beatPhase: 0.25 })).attractorRadius).toBeCloseTo(1.45, 6);
    expect(once(m, fast({ beatPhase: 0.75 })).attractorRadius).toBeCloseTo(0.95, 6);
    // Every other motion holds the shell still.
    expect(once(mood({ motion: 'flow' }), fast({ beatPhase: 0.25 })).attractorRadius).toBeCloseTo(
      1.2,
      6,
    );
  });

  it('shatters into bigger, more fringed points', () => {
    const calmly = once(mood({ motion: 'flow', synthetic: 1, arousal: 1 }), fast({ impact: 1 }));
    const hard = once(mood({ motion: 'shatter', synthetic: 1, arousal: 1 }), fast({ impact: 1 }));
    expect(hard.pointSize).toBeCloseTo(calmly.pointSize * 1.6, 6);
    expect(hard.chroma).toBeCloseTo(calmly.chroma * 2, 6);
  });

  it('scales the particle speed and the strands with the music', () => {
    expect(once(mood({ arousal: 1 }), fast()).particleSpeed).toBeCloseTo(2.2, 6);
    expect(once(mood({ arousal: 0 }), fast()).particleSpeed).toBeCloseTo(0.2, 6);
    expect(once(mood({ tension: 1 }), fast()).strandBend).toBeCloseTo(1.4, 6);
    expect(once(mood({ tension: 0 }), fast()).strandBend).toBeCloseTo(0.2, 6);
    // Ribbons, not hairlines: the creative note's thickness range.
    expect(once(mood({}), fast({ sub: 1 })).strandThickness).toBeCloseTo(0.035, 6);
    expect(once(mood({}), fast({ sub: 0 })).strandThickness).toBeCloseTo(0.012, 6);
  });

  it('halves the particle motion and drops the dolly snap under reduced motion', () => {
    const m = mood({ arousal: 1 });
    const full = once(m, fast({ impact: 1 }));
    const calm = once(m, fast({ impact: 1 }), true);
    expect(calm.particleSpeed).toBeCloseTo(full.particleSpeed / 2, 6);
    expect(calm.particleImpulse).toBeCloseTo(full.particleImpulse / 2, 6);
    expect(full.dollySnap).toBeGreaterThan(0);
    expect(calm.dollySnap).toBe(0);
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

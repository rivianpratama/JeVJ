import { describe, expect, it } from 'vitest';
import {
  IDLE_MOOD,
  createDirector,
  direct,
  type FastFrame,
  type RenderParams,
} from '../../src/visuals/director';
import {
  SPIN_REVERSE_SEC,
  pushOutFor,
  spinBaseRate,
  strandWaveFor,
  striateFor,
} from '../../src/visuals/smokeMath';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { GENRES, MOTIONS, SECTIONS } from '../../src/shared/types';
import type { MoodVector, TransitionKind } from '../../src/shared/types';

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
    // No beat and no rhythm by default: a frame that has not said otherwise is
    // a frame with nothing findable in it, and the rotation is driven by both.
    beatConf: 0,
    regular: 0,
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

  it('never cuts a scene weight, whatever the mood does', () => {
    // Moods crossfade over seconds. Every weight is slewed toward its target
    // before the mix is normalised, so no layer can appear or vanish between
    // two frames however hard the mood layer steps.
    const quiet = mood({ spoken: 0, arousal: 0.2, tension: 0.2 });
    const talking = mood({ spoken: 1, arousal: 1, tension: 1, motion: 'swarm' });
    const state = createDirector();
    let prev = direct(state, quiet, fast(), FRAME, null, false);

    const walk = (m: MoodVector, frames: number): void => {
      for (let i = 0; i < frames; i++) {
        const next = direct(state, m, fast(), FRAME, prev, false);
        for (const k of Object.keys(next.weights) as (keyof RenderParams['weights'])[]) {
          expect(Math.abs(next.weights[k] - prev!.weights[k])).toBeLessThan(0.05);
        }
        prev = next;
      }
    };
    // Into speech, and back out again: both directions.
    walk(talking, 240);
    expect(prev.weights.breath).toBeGreaterThan(0.9);
    walk(quiet, 240);
    expect(prev.weights.breath).toBeLessThan(0.02);
  });

  it('crosses the speech gate smoothly rather than at a step', () => {
    // `spoken ≥ 0.5 ? spoken : 0` put a whole layer on screen between two
    // frames when Jev's answer moved by a hundredth. The gate is a smoothstep.
    const state = createDirector();
    let prev = direct(state, mood({ spoken: 0.49 }), fast(), FRAME, null, false);
    for (let i = 0; i < 300; i++) {
      const next = direct(state, mood({ spoken: 0.51 }), fast(), FRAME, prev, false);
      expect(Math.abs(next.weights.breath - prev.weights.breath)).toBeLessThan(0.05);
      prev = next;
    }
    // And below the gate's foot there is no voice layer at all.
    expect(once(mood({ spoken: 0.3 }), fast()).weights.breath).toBe(0);
    expect(once(mood({ spoken: 0.5 }), fast()).weights.breath).toBeGreaterThan(0);
  });

  it('fades the mirror rather than switching it', () => {
    // `mirrorFolds` is an integer and cannot be crossfaded, so the *mix* is
    // what moves: the figure fades out, the count changes while nobody can see
    // it, and it fades back in.
    const state = createDirector();
    let prev = direct(state, mood({ hypnotic: 1, tension: 0 }), fast(), FRAME, null, false);
    expect(prev.mirrorFolds).toBe(2);
    expect(prev.mirrorMix).toBeCloseTo(1, 6);

    const wanted = mood({ hypnotic: 1, tension: 1 });
    let sawFade = false;
    for (let i = 0; i < 300; i++) {
      const next = direct(state, wanted, fast(), FRAME, prev, false);
      expect(Math.abs(next.mirrorMix - prev.mirrorMix)).toBeLessThanOrEqual(0.04);
      // The count may only move while the mirror is invisible.
      if (next.mirrorFolds !== prev.mirrorFolds) expect(next.mirrorMix).toBeLessThan(0.05);
      if (next.mirrorMix < 0.05) sawFade = true;
      prev = next;
    }
    expect(sawFade).toBe(true);
    expect(prev.mirrorFolds).toBe(6);
    expect(prev.mirrorMix).toBeCloseTo(1, 2);
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
    // The *mix* is what goes to zero, not the fold count: a count that snapped
    // would be a cut, which is the one thing a safety rule must not introduce.
    expect(p.mirrorMix).toBe(0);
    expect(p.chroma).toBe(0);
    expect(p.posterize).toBe(0);
    expect(p.bloomStrength).toBeLessThanOrEqual(0.4);
    expect(p.exposure).toBeCloseTo(1, 6);

    // And it holds frame after frame, not only on the first one.
    const frames = run(120, mood({ spoken: 1, arousal: 1, synthetic: 1, hypnotic: 1 }), (i) =>
      fast({ impact: i % 2 === 0 ? 1 : 0, downbeatPulse: 1 }),
    );
    for (const f of frames) {
      expect(f.mirrorMix).toBe(0);
      expect(f.chroma).toBe(0);
      expect(f.posterize).toBe(0);
      expect(f.bloomStrength).toBeLessThanOrEqual(0.4);
      expect(f.exposure).toBeCloseTo(1, 6);
    }
  });

  it('lets no flourish touch the smoke under a talking voice', () => {
    // The safety used to be applied to the flourish *after* every smoke target
    // had already been built from it, so over speech a drop still burst the
    // field outward, a hole still froze the decay and a scream still doubled
    // the grain. Everything a flourish can reach is checked against the same
    // frame with no cue at all.
    const talking = mood({ spoken: 1, arousal: 0.6, synthetic: 0.5 });
    const keys = ['pushOut', 'flowAmt', 'decay', 'injectGain', 'grain'] as const;
    for (const kind of ['drop', 'break_silence', 'quiet_fall', 'scream_peak'] as const) {
      // 200 frames of speech first, so the safety has fully engaged before the
      // cue lands; then the cue, then the whole of its window.
      const quiet = run(260, talking, () => fast());
      const fired = runWithCue(260, talking, [kind], 200);
      for (let i = 200; i < 260; i++) {
        for (const key of keys) {
          expect(fired[i]![key]).toBeCloseTo(quiet[i]![key], 6);
        }
      }
    }
  });

  it('engages the safety on the same number the blend composites with', () => {
    // The blend is already half breath at a weight of 0.25, so that is where
    // the clamp comes down — not at the 0.5 the old gate used, which left a
    // quarter of the range where the voice layer was visibly on screen and the
    // kaleidoscope was still running over it.
    const m = mood({
      spoken: 0.5,
      arousal: 1,
      synthetic: 0,
      tension: 1,
      hypnotic: 1,
      melancholy: 0,
      aggression: 0,
      genre: 'pop',
    });
    const state = createDirector();
    let prev = direct(state, m, fast({ impact: 1 }), FRAME, null, false);
    expect(prev.weights.breath).toBeGreaterThanOrEqual(0.25);
    expect(prev.weights.breath).toBeLessThan(0.5);
    expect(prev.mirrorMix).toBe(0);
    expect(prev.chroma).toBe(0);

    // Unclamped, that same hit would have put chroma on screen.
    const loose = once(mood({ ...m, spoken: 0 }), fast({ impact: 1 }));
    expect(loose.chroma).toBeGreaterThan(0.01);
    expect(loose.mirrorMix).toBeGreaterThan(0.5);

    // And it holds as the frames go by.
    for (let i = 0; i < 120; i++) {
      prev = direct(state, m, fast({ impact: i % 2 === 0 ? 1 : 0 }), FRAME, prev, false);
      expect(prev.mirrorMix).toBe(0);
      expect(prev.chroma).toBe(0);
    }
  });

  it('picks the grain accent by warmth: fire above 0.4, the complement below', () => {
    expect(once(mood({ warmth: 0.4 }), fast()).warmGrains).toBe(true);
    expect(once(mood({ warmth: 1 }), fast()).warmGrains).toBe(true);
    expect(once(mood({ warmth: 0.39 }), fast()).warmGrains).toBe(false);
    expect(once(mood({ warmth: 0 }), fast()).warmGrains).toBe(false);
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
    expect(p.mirrorMix).toBeCloseTo(1, 6);
    // Reduced motion still wins — through the mix, which is the lever that can
    // be moved without cutting.
    expect(once(m, fast(), true).mirrorMix).toBe(0);
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
    // The design rule, stated as a rule rather than as the arithmetic of the
    // day: the silk may draw level with the ink but never lead it by enough to
    // read as the subject, and a page that has heard nothing has no landscape
    // on it. Pinning the gap to a hundredth made this test a tripwire on every
    // future weight change rather than a statement about the picture.
    expect(p.weights.strands).toBeLessThanOrEqual(p.weights.ink + 0.05);
    expect(p.weights.relief).toBeLessThanOrEqual(0.1);
    expect(p.weights.ink).toBeGreaterThan(p.weights.particles);
    expect(p.weights.breath).toBe(0);
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
    // Ribbons, not hairlines: the creative note's thickness range, widened
    // again by 1.8 after the real-music pass — at 1440x900 the old range still
    // read as scratches rather than as silk.
    expect(once(mood({}), fast({ sub: 1 })).strandThickness).toBeCloseTo(0.06, 6);
    expect(once(mood({}), fast({ sub: 0 })).strandThickness).toBeCloseTo(0.022, 6);
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
    // whole screen several times a second. The debounce is the first of two
    // guards; the second is the fade in `fades the mirror rather than
    // switching it`, which is why a full second here still shows two folds.
    const state = createDirector();
    let prev = direct(state, mood({ hypnotic: 1, tension: 0 }), fast(), FRAME, null, false);
    expect(prev.mirrorFolds).toBe(2);

    const wanted = mood({ hypnotic: 1, tension: 1 });
    // A quarter of a second of wanting six is not enough to start the fade.
    for (let i = 0; i < 15; i++) prev = direct(state, wanted, fast(), FRAME, prev, false);
    expect(prev.mirrorFolds).toBe(2);
    expect(prev.mirrorMix).toBeCloseTo(1, 2);
    // Half a second later the fade has begun, and the count has not moved yet.
    for (let i = 0; i < 30; i++) prev = direct(state, wanted, fast(), FRAME, prev, false);
    expect(prev.mirrorFolds).toBe(2);
    expect(prev.mirrorMix).toBeLessThan(0.9);
  });

  it('honours reduced motion', () => {
    const m = mood({ hypnotic: 1, tension: 1, arousal: 1, synthetic: 1 });
    const loud = fast({ impact: 1, sub: 1 });
    const full = once(m, loud);
    const calm = once(m, loud, true);
    // The mirror goes out through its mix, not by snapping the fold count.
    expect(calm.mirrorMix).toBe(0);
    expect(full.mirrorMix).toBeGreaterThan(0.5);
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

  it('turns posterize on for hypnotic machine music and for a seam, not for loudness', () => {
    // The window narrowed in the v2.1 tuning pass. Hard colour steps sustained
    // through a whole section read as banding rather than as a look, so "loud
    // and synthetic" — which is most of a dance track — no longer qualifies on
    // its own. What does: repetition that is the point, and the first second
    // and a half of a drop or a scream.
    expect(once(mood({ synthetic: 1, arousal: 1, hypnotic: 0.8 }), fast()).posterize).toBe(6);
    expect(once(mood({ synthetic: 1, arousal: 1, hypnotic: 0.2 }), fast()).posterize).toBe(0);
    expect(once(mood({ synthetic: 1, arousal: 0.5, hypnotic: 0.2 }), fast()).posterize).toBe(0);
    // Acoustic music never gets it, however hypnotic.
    expect(once(mood({ synthetic: 0.3, arousal: 1, hypnotic: 0.9 }), fast()).posterize).toBe(0);
  });

  it('posterizes for the window after a drop and then stops', () => {
    const m = mood({ synthetic: 1, arousal: 1, hypnotic: 0.2 });
    const seen = runWithCue(200, m, ['drop'], 5);
    // The seam itself, and still a fraction of a second later.
    expect(seen[5]!.posterize).toBe(6);
    expect(seen[20]!.posterize).toBe(6);
    // The drop flourish is 0.6 s long; once it is over the banding is gone.
    expect(seen[150]!.posterize).toBe(0);
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

  it('snaps the mirror all the way off rather than leaving a trace of it', () => {
    // A mix of 1e-9 is a kaleidoscope nobody can see and a shader that runs
    // anyway: the pass early-outs on exactly zero, and an exponential approach
    // never gets there.
    const state = createDirector();
    let p: RenderParams | null = null;
    const hypnotic = mood({ hypnotic: 1, tension: 1 });
    for (let i = 0; i < 300; i++) p = direct(state, hypnotic, fast(), FRAME, p, false);
    expect(p!.mirrorMix).toBeCloseTo(1, 6);

    const plain = mood({ hypnotic: 0, tension: 0 });
    for (let i = 0; i < 600; i++) p = direct(state, plain, fast(), FRAME, p, false);
    expect(p!.mirrorMix).toBe(0);
    expect(state.mirrorMix).toBe(0);
  });

  it('does not flip posterize on and off around the safety threshold', () => {
    // `spoken` arrives as a step every few seconds and the safety slews through
    // it, so a bare threshold puts the banding on and off at about 1 Hz while
    // the reading crosses. The clamp engages at 0.6 and lets go at 0.4, and
    // between the two it holds whatever it was doing.
    const state = createDirector();
    const acid = { synthetic: 1, arousal: 1, hypnotic: 0.8 };
    const talking = mood({ ...acid, spoken: 0.9 });
    const music = mood({ ...acid, spoken: 0 });
    let p: RenderParams | null = null;
    const seen: { safety: number; posterize: number }[] = [];

    for (let i = 0; i < 900; i++) {
      p = direct(state, i < 300 || i >= 600 ? music : talking, fast(), FRAME, p, false);
      seen.push({ safety: state.safety, posterize: p.posterize });
    }

    for (const f of seen) {
      if (f.safety > 0.6) expect(f.posterize).toBe(0);
      if (f.safety < 0.4) expect(f.posterize).toBe(6);
    }
    // And inside the band it never changes its mind.
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1]!;
      const b = seen[i]!;
      if (a.safety >= 0.4 && a.safety <= 0.6 && b.safety >= 0.4 && b.safety <= 0.6) {
        expect(b.posterize).toBe(a.posterize);
      }
    }
    // The whole excursion happened: both states were reached.
    expect(seen.some((f) => f.posterize === 0)).toBe(true);
    expect(seen.some((f) => f.posterize === 6)).toBe(true);
  });

  it('keeps the dust cool on metal, however warm the palette is', () => {
    // Terrain, embers and warm dust on one frame is a monochrome orange field:
    // the one genre that gets terrain for its own sake keeps the complement in
    // its dust for contrast.
    expect(once(mood({ warmth: 1, genre: 'rock_metal' }), fast()).warmGrains).toBe(false);
    expect(once(mood({ warmth: 1, genre: 'electronic_dance' }), fast()).warmGrains).toBe(true);
  });
});

/** Run `frames` frames, firing `transitions` on the frame at index `at`. */
function runWithCue(
  frames: number,
  m: MoodVector,
  kinds: readonly TransitionKind[],
  at: number,
  o: { reduced?: boolean; f?: (i: number) => FastFrame } = {},
): RenderParams[] {
  const out: RenderParams[] = [];
  const state = createDirector();
  let prev: RenderParams | null = null;
  for (let i = 0; i < frames; i++) {
    prev = direct(
      state,
      m,
      o.f?.(i) ?? fast(),
      FRAME,
      prev,
      o.reduced === true,
      i === at ? kinds : [],
    );
    out.push(prev);
  }
  return out;
}

/** A frame with a beat in it, which is what the rotation is driven by. */
const METRED = { beatConf: 1, regular: 1 };

describe('the smoke rotates', () => {
  it('turns at the rate the direction specifies, and faster the louder it is', () => {
    const drive = (arousal: number): Parameters<typeof spinBaseRate>[0] => ({
      arousal,
      beatConf: 1,
      regular: 1,
      spoken: 0,
      section: 'other',
    });
    const calm = run(60, mood({ arousal: 0, spoken: 0 }), () => fast(METRED));
    const loud = run(60, mood({ arousal: 1, spoken: 0 }), () => fast(METRED));
    expect(calm[59]!.spinRate).toBeCloseTo(spinBaseRate(drive(0)), 6);
    expect(loud[59]!.spinRate).toBeCloseTo(spinBaseRate(drive(1)), 6);
    // And the angle is an integral of it, not a function of the frame index.
    expect(loud[59]!.spin).toBeGreaterThan(calm[59]!.spin);
    expect(loud[59]!.spin).toBeCloseTo(spinBaseRate(drive(1)), 2);
  });

  it('barely turns at all under a talking voice', () => {
    // The whole point of the v2.1 drive: a podcast is not a thing that spins.
    const spoken = run(60, mood({ arousal: 0.6, spoken: 1 }), () => fast(METRED));
    expect(Math.abs(spoken[59]!.spinRate)).toBeLessThanOrEqual(0.01);
  });

  it('barely turns on music with no findable beat', () => {
    const beatless = run(60, mood({ arousal: 0.9 }), () => fast({ beatConf: 0, regular: 0 }));
    expect(Math.abs(beatless[59]!.spinRate)).toBeLessThanOrEqual(0.01);
    // And it is never exactly still: a frozen field reads as a screenshot.
    expect(Math.abs(beatless[59]!.spinRate)).toBeGreaterThan(0);
  });

  it('kicks on an onset and lets the kick go', () => {
    const hit = run(40, mood({ arousal: 0.5, spoken: 0, motion: 'pulse' }), (i) =>
      fast({ ...METRED, onset: i === 10 ? 1 : 0 }),
    );
    const base = hit[9]!.spinRate;
    expect(hit[10]!.spinRate).toBeGreaterThan(base + 0.5);
    expect(hit[39]!.spinRate).toBeLessThan(hit[10]!.spinRate);
    expect(hit[39]!.spinRate).toBeGreaterThan(base);
  });

  it('reverses on a drop and on a breakdown, over a second and a half', () => {
    for (const kind of ['drop', 'breakdown'] as const) {
      const seen = runWithCue(200, mood({ arousal: 0.5 }), [kind], 5, {
        f: () => fast(METRED),
      });
      expect(seen[4]!.spinRate).toBeGreaterThan(0);
      expect(seen[199]!.spinRate).toBeLessThan(0);
      // Through a standstill rather than between two frames.
      const mid = seen[5 + Math.round(SPIN_REVERSE_SEC / 2 / FRAME)]!;
      expect(Math.abs(mid.spinRate)).toBeLessThan(0.02);
    }
  });

  it('will not turn the field round more than once every four seconds', () => {
    // The real-track pass: pass 2 on a talk named nine drops and five
    // breakdowns in four minutes — applause reads as a slam — and the field
    // spent the whole recording turning itself round. A reversal is the largest
    // gesture the picture has and it needs a cooldown, not only a lock while
    // one is in flight.
    const state = createDirector();
    let p: RenderParams | null = null;
    const rates: number[] = [];
    // A `drop` every second for twelve seconds.
    for (let i = 0; i < 720; i++) {
      p = direct(
        state,
        mood({ arousal: 0.5, spoken: 0 }),
        fast(METRED),
        FRAME,
        p,
        false,
        i % 60 === 0 && i > 0 ? ['drop'] : [],
      );
      rates.push(p.spinRate);
    }
    // Twelve cues, at most three reversals: count the sign changes.
    let flips = 0;
    for (let i = 1; i < rates.length; i++) {
      if (Math.sign(rates[i]!) !== Math.sign(rates[i - 1]!)) flips++;
    }
    expect(flips).toBeLessThanOrEqual(3);
    expect(flips).toBeGreaterThan(0);
  });

  it('does not reverse on the kinds that are not a seam in the flow', () => {
    for (const kind of ['vocal_entry', 'quiet_fall', 'build_start', 'none'] as const) {
      const seen = runWithCue(200, mood({ arousal: 0.5 }), [kind], 5, {
        f: () => fast(METRED),
      });
      expect(seen[199]!.spinRate).toBeGreaterThan(0);
    }
  });

  it('takes the kicks away under reduced motion but keeps turning', () => {
    const seen = run(
      40,
      mood({ arousal: 0.5 }),
      (i) => fast({ ...METRED, onset: i === 10 ? 1 : 0 }),
      true,
    );
    const full = spinBaseRate({ arousal: 0.5, beatConf: 1, regular: 1, spoken: 0 });
    for (const p of seen) {
      expect(p.spinRate).toBeGreaterThan(0);
      expect(p.spinRate).toBeLessThanOrEqual(full);
    }
  });
});

describe('the smoke spreads', () => {
  it('pushes outward always, harder when it is loud and hardest on a hit', () => {
    expect(once(mood({ arousal: 0 }), fast()).pushOut).toBeCloseTo(pushOutFor(0, 0), 9);
    expect(once(mood({ arousal: 1 }), fast()).pushOut).toBeGreaterThan(
      once(mood({ arousal: 0 }), fast()).pushOut,
    );
    expect(once(mood({ arousal: 1 }), fast({ impact: 1 })).pushOut).toBeGreaterThan(
      once(mood({ arousal: 1 }), fast()).pushOut,
    );
    // Never zero: a standing creep is what fills the frame outside the card.
    for (const m of [IDLE_MOOD, mood({}), mood({ arousal: 0, spoken: 1 })]) {
      expect(once(m, fast()).pushOut).toBeGreaterThan(0);
    }
  });

  it('halves the push under reduced motion', () => {
    const p = once(mood({ arousal: 1 }), fast({ impact: 1 }), true);
    const q = once(mood({ arousal: 1 }), fast({ impact: 1 }));
    expect(p.pushOut).toBeCloseTo(q.pushOut / 2, 9);
  });

  it('combs the sheets finer the more synthetic the music is', () => {
    expect(once(mood({ synthetic: 0 }), fast()).striate).toBeCloseTo(striateFor(0), 6);
    expect(once(mood({ synthetic: 1 }), fast()).striate).toBeCloseTo(striateFor(1), 6);
  });
});

describe('flourishes', () => {
  it('bursts on a drop: more push, more exposure, more fringing', () => {
    const m = mood({ arousal: 0.5, synthetic: 0.8 });
    const quiet = run(10, m, () => fast());
    const burst = runWithCue(10, m, ['drop'], 5);
    expect(burst[5]!.pushOut).toBeGreaterThan(4 * quiet[5]!.pushOut);
    expect(burst[5]!.exposure).toBeGreaterThan(quiet[5]!.exposure + 0.2);
    expect(burst[5]!.chroma).toBeGreaterThan(quiet[5]!.chroma);
    // And it is over well inside a second.
    const after = runWithCue(120, m, ['drop'], 5);
    expect(after[119]!.pushOut).toBeCloseTo(quiet[9]!.pushOut, 3);
  });

  it('freezes the smoke in a hole and lets it fall away', () => {
    const m = mood({ arousal: 0.6 });
    const quiet = run(90, m, () => fast());
    const hole = runWithCue(90, m, ['break_silence'], 5);
    expect(hole[89]!.flowAmt).toBeLessThan(quiet[89]!.flowAmt);
    expect(hole[89]!.decay).toBeLessThan(quiet[89]!.decay);
  });

  it('flares on a scream and opens a mirror over music that never wanted one', () => {
    const m = mood({ arousal: 0.5, hypnotic: 0 });
    const quiet = run(30, m, () => fast());
    const scream = runWithCue(30, m, ['scream_peak'], 2);
    expect(quiet[29]!.mirrorMix).toBe(0);
    expect(scream[29]!.mirrorMix).toBeGreaterThan(0.2);
    expect(scream[29]!.mirrorFolds).toBeGreaterThanOrEqual(2);
    expect(scream[29]!.grain).toBeGreaterThan(quiet[29]!.grain);
    // The flare itself is in the exposure, and the limiter still owns it.
    expect(scream[2]!.exposure).toBeGreaterThan(quiet[2]!.exposure);
  });

  it('swells the bloom and the silk on a vocal entry', () => {
    const m = mood({ arousal: 0.5 });
    const quiet = run(40, m, () => fast());
    const vocal = runWithCue(40, m, ['vocal_entry'], 0);
    expect(vocal[30]!.bloomStrength).toBeGreaterThan(quiet[30]!.bloomStrength);
    expect(vocal[30]!.strandGlow).toBeGreaterThan(0);
    expect(quiet[30]!.strandGlow).toBe(0);
  });

  it('fades out slowly on a quiet fall', () => {
    const m = mood({ arousal: 0.5 });
    const quiet = run(90, m, () => fast());
    const fall = runWithCue(90, m, ['quiet_fall'], 0);
    expect(fall[89]!.injectGain).toBeLessThan(quiet[89]!.injectGain);
    expect(fall[89]!.decay).toBeGreaterThan(quiet[89]!.decay);
  });

  it('never fires the same seam twice for one cue', () => {
    // A re-anchored prediction and the detector's confirmation of it are two
    // cues about one instant, and a cue on a frame boundary can be read twice.
    const m = mood({ arousal: 0.5 });
    const once_ = runWithCue(10, m, ['drop'], 2);
    const twice = runWithCue(10, m, ['drop', 'drop'], 2);
    expect(twice[5]!.pushOut).toBeCloseTo(once_[5]!.pushOut, 9);
  });

  it('holds back every flourish over a talking voice', () => {
    // The breath safety takes the frame; a white flare over a person talking
    // is exactly what it exists to prevent.
    const m = mood({ spoken: 1, arousal: 0.5 });
    const quiet = run(120, m, () => fast());
    const scream = runWithCue(120, m, ['scream_peak'], 100);
    expect(scream[100]!.exposure).toBeCloseTo(quiet[100]!.exposure, 3);
    expect(scream[119]!.mirrorMix).toBeLessThan(0.05);
  });

  it('keeps half of a flourish under reduced motion', () => {
    const m = mood({ arousal: 0.5 });
    const full = runWithCue(10, m, ['drop'], 2);
    const half = runWithCue(10, m, ['drop'], 2, { reduced: true });
    const quiet = run(10, m, () => fast(), true);
    expect(half[2]!.pushOut).toBeGreaterThan(quiet[2]!.pushOut);
    expect(half[2]!.pushOut).toBeLessThan(full[2]!.pushOut);
  });
});

describe('the afterimage', () => {
  it('smears more the more hypnotic the music is', () => {
    expect(once(mood({ hypnotic: 0, motion: 'flow' }), fast()).afterimage).toBeCloseTo(0.85, 6);
    expect(once(mood({ hypnotic: 1, motion: 'flow' }), fast()).afterimage).toBeCloseTo(0.95, 6);
  });

  it('cuts it short when the motion shatters', () => {
    expect(once(mood({ hypnotic: 1, motion: 'shatter' }), fast()).afterimage).toBeCloseTo(0.6, 6);
  });

  it('is off entirely under reduced motion', () => {
    for (const motion of MOTIONS) {
      for (const hypnotic of [0, 1]) {
        expect(once(mood({ hypnotic, motion }), fast(), true).afterimage).toBe(0);
      }
    }
  });
});

describe('the strands are wavy', () => {
  it('reads its wave off the low-mid band, the tension and the arousal', () => {
    const bands = new Float32Array(8);
    bands[3] = 1;
    const p = once(mood({ tension: 1, arousal: 1 }), fast({ bands }));
    const want = strandWaveFor(1, 1, 1);
    expect(p.strandWaveAmp).toBeCloseTo(want.amp, 9);
    expect(p.strandWaveFreq).toBeCloseTo(want.freq, 9);
    expect(p.strandWaveSpeed).toBeCloseTo(want.speed, 9);
  });

  it('never hands the silk a wave that stands still', () => {
    for (const arousal of [0, 0.5, 1]) {
      for (const tension of [0, 0.5, 1]) {
        const p = once(mood({ arousal, tension }), fast());
        expect(p.strandWaveAmp * p.strandWaveSpeed).toBeGreaterThan(0);
      }
    }
  });
});

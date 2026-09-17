import { describe, expect, it } from 'vitest';
import {
  ANNULUS_BAND,
  FLOURISH_COOLDOWN,
  FLOURISH_SEC,
  SPIN_KICK_MAX,
  SPIN_KICK_TAU,
  SPIN_REVERSE_SEC,
  VIRTUAL_CARD_MAX_PX,
  VIRTUAL_CARD_VW,
  activeFlourish,
  afterimageDamp,
  annulusFor,
  applyFlourish,
  createFlourishes,
  createSpin,
  fireFlourish,
  neutralFlourish,
  pushOutFor,
  spinBaseRate,
  stepSpin,
  strandOffsetX,
  strandWaveFor,
  striateFor,
  wrapDrift,
} from '../../src/visuals/smokeMath';
import { TRANSITION_KINDS } from '../../src/shared/types';

const FRAME = 1 / 60;

/** Run `sec` seconds of spin at 60 Hz, returning the final state. */
function spinFor(
  sec: number,
  o: { arousal?: number; onset?: (t: number) => number; reverseAt?: number; reduced?: boolean } = {},
): ReturnType<typeof createSpin> {
  const s = createSpin();
  const frames = Math.round(sec / FRAME);
  for (let i = 0; i < frames; i++) {
    const t = i * FRAME;
    stepSpin(s, {
      dt: FRAME,
      arousal: o.arousal ?? 0.5,
      onset: o.onset?.(t) ?? 0,
      reverse: o.reverseAt !== undefined && t <= o.reverseAt && t + FRAME > o.reverseAt,
      reducedMotion: o.reduced === true,
    });
  }
  return s;
}

describe('spinBaseRate', () => {
  it('is the direction: a full turn every ~35 s at mid arousal', () => {
    // ω = 0.18·(0.4 + arousal). At arousal 0.5 that is 0.162 rad/s, and a turn
    // is 2π/0.162 ≈ 38.8 s — the "~35 s" of the brief.
    expect(spinBaseRate(0.5)).toBeCloseTo(0.18 * 0.9, 9);
    const turnSec = (2 * Math.PI) / spinBaseRate(0.5);
    expect(turnSec).toBeGreaterThan(30);
    expect(turnSec).toBeLessThan(45);
  });

  it('turns faster the louder it gets, and never stops', () => {
    expect(spinBaseRate(1)).toBeGreaterThan(spinBaseRate(0));
    expect(spinBaseRate(0)).toBeGreaterThan(0);
  });
});

describe('stepSpin', () => {
  it('integrates the base rate: the angle after a second is the rate', () => {
    const s = spinFor(1, { arousal: 0.5 });
    expect(s.angle).toBeCloseTo(spinBaseRate(0.5), 3);
    expect(s.rate).toBeCloseTo(spinBaseRate(0.5), 6);
  });

  it('kicks on an onset and decays the kick with τ = 0.4 s', () => {
    const s = createSpin();
    stepSpin(s, { dt: FRAME, arousal: 0.5, onset: 1, reverse: false, reducedMotion: false });
    // The whole kick, less one frame of decay.
    expect(s.kick).toBeGreaterThan(0.85);
    expect(s.kick).toBeLessThanOrEqual(0.9);

    const at0 = s.kick;
    for (let i = 0; i < Math.round(SPIN_KICK_TAU / FRAME); i++) {
      stepSpin(s, { dt: FRAME, arousal: 0.5, onset: 0, reverse: false, reducedMotion: false });
    }
    expect(s.kick / at0).toBeCloseTo(Math.exp(-1), 2);
  });

  it('caps the kick, so a sustained transient cannot spin the frame', () => {
    // `onset` is a level the analyser reports every frame, not an event: a
    // cymbal roll reads high for a hundred frames, and each of them adds its
    // own kick against a 0.4 s decay. Unclamped that sums to about 22 rad/s.
    const s = createSpin();
    for (let i = 0; i < 300; i++) {
      stepSpin(s, { dt: FRAME, arousal: 1, onset: 1, reverse: false, reducedMotion: false });
      expect(Math.abs(s.kick)).toBeLessThanOrEqual(SPIN_KICK_MAX + 1e-9);
    }
    expect(s.kick).toBeCloseTo(SPIN_KICK_MAX, 6);
    // And one hit on its own is nowhere near the cap, so the cap is a limit and
    // not the behaviour.
    const one = createSpin();
    stepSpin(one, { dt: FRAME, arousal: 1, onset: 1, reverse: false, reducedMotion: false });
    expect(one.kick).toBeLessThan(SPIN_KICK_MAX);
  });

  it('kicks in the direction it is already turning', () => {
    const forward = createSpin();
    stepSpin(forward, { dt: FRAME, arousal: 0.5, onset: 1, reverse: false, reducedMotion: false });
    expect(forward.rate).toBeGreaterThan(spinBaseRate(0.5));

    // Reversed and settled, then hit: the kick goes the other way too, so a
    // beat never fights the direction the smoke is visibly turning.
    const back = spinFor(SPIN_REVERSE_SEC + 0.5, { reverseAt: 0.1 });
    expect(back.rate).toBeLessThan(0);
    stepSpin(back, { dt: FRAME, arousal: 0.5, onset: 1, reverse: false, reducedMotion: false });
    expect(back.kick).toBeLessThan(0);
    expect(back.rate).toBeLessThan(-spinBaseRate(0.5));
  });

  it('reverses over 1.5 s, passing through a standstill halfway', () => {
    const s = createSpin();
    const rates: number[] = [];
    const frames = Math.round((SPIN_REVERSE_SEC + 0.5) / FRAME);
    for (let i = 0; i < frames; i++) {
      stepSpin(s, {
        dt: FRAME,
        arousal: 0.5,
        onset: 0,
        reverse: i === 0,
        reducedMotion: false,
      });
      rates.push(s.rate);
    }
    // It starts positive, ends fully negative, and crosses zero in the middle
    // rather than flipping between two frames.
    expect(rates[0]!).toBeGreaterThan(0);
    expect(rates[rates.length - 1]!).toBeCloseTo(-spinBaseRate(0.5), 6);
    const mid = rates[Math.round(SPIN_REVERSE_SEC / 2 / FRAME)]!;
    expect(Math.abs(mid)).toBeLessThan(0.02);
    // Monotone down: no frame of the flip is a cut.
    for (let i = 1; i < Math.round(SPIN_REVERSE_SEC / FRAME); i++) {
      expect(rates[i]!).toBeLessThanOrEqual(rates[i - 1]! + 1e-9);
    }
  });

  it('reverses again on a second cue, from wherever it had got to', () => {
    const s = spinFor(SPIN_REVERSE_SEC + 1, { reverseAt: 0.1 });
    expect(s.rate).toBeLessThan(0);
    stepSpin(s, { dt: FRAME, arousal: 0.5, onset: 0, reverse: true, reducedMotion: false });
    for (let i = 0; i < Math.round(SPIN_REVERSE_SEC / FRAME); i++) {
      stepSpin(s, { dt: FRAME, arousal: 0.5, onset: 0, reverse: false, reducedMotion: false });
    }
    expect(s.rate).toBeGreaterThan(0);
  });

  it('keeps the slow turn under reduced motion but takes the kicks away', () => {
    const s = createSpin();
    stepSpin(s, { dt: FRAME, arousal: 0.5, onset: 1, reverse: false, reducedMotion: true });
    expect(s.kick).toBe(0);
    expect(s.rate).toBeGreaterThan(0);
    expect(s.rate).toBeLessThan(spinBaseRate(0.5));
  });

  it('keeps the angle bounded however long the page is open', () => {
    const s = spinFor(120, { arousal: 1, onset: (t) => (Math.round(t * 2) === t * 2 ? 1 : 0) });
    expect(s.angle).toBeGreaterThanOrEqual(0);
    expect(s.angle).toBeLessThan(2 * Math.PI);
  });

  it('survives a nonsense frame without poisoning the angle', () => {
    const s = createSpin();
    stepSpin(s, { dt: Number.NaN, arousal: 0.5, onset: 0, reverse: false, reducedMotion: false });
    stepSpin(s, { dt: -1, arousal: Number.NaN, onset: 0, reverse: false, reducedMotion: false });
    expect(Number.isFinite(s.angle)).toBe(true);
    expect(Number.isFinite(s.rate)).toBe(true);
  });
});

describe('annulusFor', () => {
  it('puts the ring on the card: inner radius is the half-diagonal', () => {
    // A 440 px square centred in a 1440×900 viewport. Radii are in the
    // aspect-corrected space the inject shader works in, where the frame is
    // `aspect × 1` and a screen square is still a square: half-side is
    // 220/900, so the half-diagonal is that times √2.
    const a = annulusFor({ x: 500, y: 230, width: 440, height: 440 }, 1440, 900);
    expect(a.cx).toBeCloseTo(720 / 1440, 9);
    // uv y runs up from the bottom; the DOM rect's y runs down from the top.
    expect(a.cy).toBeCloseTo(1 - 450 / 900, 9);
    expect(a.inner).toBeCloseTo((220 / 900) * Math.SQRT2, 9);
    expect(a.outer).toBeCloseTo(a.inner + ANNULUS_BAND, 9);
  });

  it('follows a card that is not in the middle', () => {
    const a = annulusFor({ x: 0, y: 0, width: 300, height: 300 }, 1200, 800);
    expect(a.cx).toBeCloseTo(150 / 1200, 9);
    expect(a.cy).toBeCloseTo(1 - 150 / 800, 9);
  });

  it('is aspect-correct: the same card on a taller frame reads larger', () => {
    const wide = annulusFor({ x: 380, y: 130, width: 440, height: 440 }, 1200, 700);
    const tall = annulusFor({ x: 380, y: 530, width: 440, height: 440 }, 1200, 1500);
    expect(wide.inner).toBeGreaterThan(tall.inner);
    expect(tall.inner).toBeCloseTo((220 / 1500) * Math.SQRT2, 9);
  });

  it('falls back to a centred virtual square when there is no card', () => {
    // Audio-file mode draws no card, and the smoke still has to be born around
    // the hole where one would be. `min(30vw, 440px)`, exactly as the sheet.
    const narrow = annulusFor(null, 1000, 800);
    const side = VIRTUAL_CARD_VW * 1000;
    expect(side).toBeLessThan(VIRTUAL_CARD_MAX_PX);
    expect(narrow.cx).toBeCloseTo(0.5, 9);
    expect(narrow.cy).toBeCloseTo(0.5, 9);
    expect(narrow.inner).toBeCloseTo((side / 2 / 800) * Math.SQRT2, 9);

    const wide = annulusFor(null, 3000, 800);
    expect(wide.inner).toBeCloseTo((VIRTUAL_CARD_MAX_PX / 2 / 800) * Math.SQRT2, 9);
  });

  it('treats a collapsed or absurd rect as no card at all', () => {
    const none = annulusFor(null, 1000, 800);
    for (const rect of [
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
    ]) {
      expect(annulusFor(rect, 1000, 800)).toEqual(none);
    }
  });

  it('never reports a ring the frame cannot hold', () => {
    const a = annulusFor({ x: -500, y: -500, width: 4000, height: 4000 }, 1000, 800);
    expect(a.inner).toBeLessThan(2);
    expect(a.outer).toBeGreaterThan(a.inner);
  });
});

describe('the flourish scheduler', () => {
  it('has a length and a cooldown for every kind it fires', () => {
    for (const kind of TRANSITION_KINDS) {
      expect(FLOURISH_SEC[kind]).toBeGreaterThanOrEqual(0);
      expect(FLOURISH_COOLDOWN[kind]).toBeGreaterThanOrEqual(0);
      // A flourish must never outlive its own cooldown, or two would overlap.
      if (FLOURISH_SEC[kind] > 0) {
        expect(FLOURISH_COOLDOWN[kind]).toBeGreaterThanOrEqual(FLOURISH_SEC[kind]);
      }
    }
    expect(FLOURISH_SEC['none']).toBe(0);
    expect(FLOURISH_SEC['drop']).toBeCloseTo(0.6, 9);
    expect(FLOURISH_SEC['scream_peak']).toBeGreaterThanOrEqual(0.4);
    expect(FLOURISH_SEC['vocal_entry']).toBeCloseTo(1.2, 9);
    expect(FLOURISH_SEC['quiet_fall']).toBeCloseTo(3, 9);
  });

  it('fires once and then refuses until the cooldown is up', () => {
    const s = createFlourishes();
    expect(fireFlourish(s, 'drop', 10)).toBe(true);
    expect(fireFlourish(s, 'drop', 10.5)).toBe(false);
    expect(fireFlourish(s, 'drop', 10 + FLOURISH_COOLDOWN['drop'] - 0.01)).toBe(false);
    expect(fireFlourish(s, 'drop', 10 + FLOURISH_COOLDOWN['drop'])).toBe(true);
  });

  it('keeps a cooldown per kind, so one flourish does not mute another', () => {
    const s = createFlourishes();
    expect(fireFlourish(s, 'drop', 10)).toBe(true);
    expect(fireFlourish(s, 'scream_peak', 10.2)).toBe(true);
    expect(fireFlourish(s, 'drop', 10.2)).toBe(false);
  });

  it('never fires a kind that has no flourish', () => {
    const s = createFlourishes();
    for (const kind of ['none', 'build_start', 'tempo_change', 'key_change'] as const) {
      expect(fireFlourish(s, kind, 10)).toBe(false);
    }
    expect(activeFlourish(s, 10)).toBeNull();
  });

  it('is active for exactly its own length, as a 0..1 progress', () => {
    const s = createFlourishes();
    fireFlourish(s, 'drop', 10);
    expect(activeFlourish(s, 10)?.kind).toBe('drop');
    expect(activeFlourish(s, 10)?.t).toBeCloseTo(0, 9);
    expect(activeFlourish(s, 10.3)?.t).toBeCloseTo(0.5, 9);
    expect(activeFlourish(s, 10.59)?.t).toBeGreaterThan(0.9);
    expect(activeFlourish(s, 10 + FLOURISH_SEC['drop'] + 1e-9)).toBeNull();
    expect(activeFlourish(s, 99)).toBeNull();
  });

  it('lets the newer flourish take over rather than queueing', () => {
    const s = createFlourishes();
    fireFlourish(s, 'quiet_fall', 10);
    expect(activeFlourish(s, 11)?.kind).toBe('quiet_fall');
    fireFlourish(s, 'drop', 11);
    expect(activeFlourish(s, 11)?.kind).toBe('drop');
  });

  it('forgets everything when the clock restarts', () => {
    const s = createFlourishes();
    fireFlourish(s, 'drop', 200);
    // A director whose clock restarted at 0 must not be locked out for three
    // minutes by a cooldown stamped on the old one.
    expect(fireFlourish(s, 'drop', 0.5)).toBe(true);
  });
});

describe('applyFlourish', () => {
  it('leaves everything alone when nothing is firing', () => {
    const e = neutralFlourish();
    applyFlourish(e, null, 0);
    expect(e).toEqual(neutralFlourish());
  });

  it('bursts on a drop: six times the push, more exposure, more fringing', () => {
    const e = neutralFlourish();
    applyFlourish(e, 'drop', 0);
    expect(e.pushOutMul).toBeCloseTo(6, 6);
    expect(e.exposureAdd).toBeCloseTo(0.35, 6);
    expect(e.chromaAdd).toBeCloseTo(0.02, 6);
    // And it lets go rather than cutting.
    applyFlourish(e, 'drop', 1);
    expect(e.pushOutMul).toBeCloseTo(1, 6);
    expect(e.exposureAdd).toBeCloseTo(0, 6);
  });

  it('freezes the smoke in a hole and lets it fall away fast', () => {
    const e = neutralFlourish();
    applyFlourish(e, 'break_silence', 0);
    expect(e.flowAmt).toBeCloseTo(0.05, 6);
    expect(e.decay).toBeCloseTo(0.9, 6);
  });

  it('flares white on a scream, and holds the mirror longer than the flare', () => {
    const e = neutralFlourish();
    applyFlourish(e, 'scream_peak', 0);
    expect(e.exposureAdd).toBeCloseTo(0.5, 6);
    expect(e.grainMul).toBeCloseTo(2, 6);
    expect(e.mirrorMix).toBeCloseTo(0.6, 6);
    // 0.4 s of flare inside a 1 s mirror: the flare is over and the figure is
    // still at full strength, which is what "mirror mix 0.6 for 1 s" means.
    applyFlourish(e, 'scream_peak', 0.45);
    expect(e.exposureAdd).toBeCloseTo(0, 6);
    expect(e.mirrorMix).toBeCloseTo(0.6, 6);
    // And it leaves rather than being switched off at the end of the window.
    applyFlourish(e, 'scream_peak', 0.95);
    expect(e.mirrorMix).toBeGreaterThan(0);
    expect(e.mirrorMix).toBeLessThan(0.3);
  });

  it('swells the bloom and the silk on a vocal entry', () => {
    // A swell, not a hit: it arrives over the first third of its window.
    const e = neutralFlourish();
    applyFlourish(e, 'vocal_entry', 0);
    expect(e.bloomMul).toBeCloseTo(1, 6);
    applyFlourish(e, 'vocal_entry', 1 / 3);
    expect(e.bloomMul).toBeCloseTo(1.4, 6);
    expect(e.strandGlow).toBeCloseTo(1, 6);
    applyFlourish(e, 'vocal_entry', 0.99);
    expect(e.bloomMul).toBeGreaterThan(1);
    expect(e.bloomMul).toBeLessThan(1.05);
  });

  it('fades out slowly on a quiet fall', () => {
    const e = neutralFlourish();
    applyFlourish(e, 'quiet_fall', 0);
    expect(e.decay).toBeCloseTo(0.985, 6);
    expect(e.injectGainMul).toBeCloseTo(0.4, 6);
  });

  it('is an overwrite, not an accumulation', () => {
    // The director owns one of these for the life of the page and fills it
    // every frame; a field left over from the last flourish would ratchet.
    const e = neutralFlourish();
    applyFlourish(e, 'scream_peak', 0);
    applyFlourish(e, 'vocal_entry', 0);
    expect(e.grainMul).toBeCloseTo(1, 6);
    expect(e.mirrorMix).toBeCloseTo(0, 6);
  });
});

describe('pushOutFor and striateFor', () => {
  it('pushes harder the louder it is and hardest on a hit', () => {
    expect(pushOutFor(0, 0)).toBeCloseTo(0.012, 9);
    expect(pushOutFor(1, 0)).toBeCloseTo(0.032, 9);
    expect(pushOutFor(1, 1)).toBeCloseTo(0.132, 9);
    expect(pushOutFor(0.5, 0)).toBeGreaterThan(pushOutFor(0, 0));
  });

  it('combs the sheets finer the more synthetic the music is', () => {
    expect(striateFor(0)).toBeCloseTo(380, 9);
    expect(striateFor(1)).toBeCloseTo(600, 9);
  });
});

describe('afterimageDamp', () => {
  it('smears more the more hypnotic the music is', () => {
    expect(afterimageDamp(0, false, false)).toBeCloseTo(0.85, 9);
    expect(afterimageDamp(1, false, false)).toBeCloseTo(0.95, 9);
  });

  it('cuts the smear short when the motion shatters', () => {
    expect(afterimageDamp(1, true, false)).toBeCloseTo(0.6, 9);
  });

  it('is off entirely under reduced motion', () => {
    for (const h of [0, 0.5, 1]) {
      for (const shatter of [false, true]) {
        expect(afterimageDamp(h, shatter, true)).toBe(0);
      }
    }
  });
});

describe('the strands never stand still', () => {
  const PARAMS: { bass: number; tension: number; arousal: number }[] = [];
  for (const bass of [0, 0.5, 1]) {
    for (const tension of [0, 0.5, 1]) {
      for (const arousal of [0, 0.5, 1]) PARAMS.push({ bass, tension, arousal });
    }
  }

  it('reads its waves off the band, the tension and the arousal', () => {
    expect(strandWaveFor(0, 0, 0)).toEqual({ amp: 0.12, freq: 2.5, speed: 1.2 });
    const loud = strandWaveFor(1, 1, 1);
    expect(loud.amp).toBeCloseTo(0.47, 9);
    expect(loud.freq).toBeCloseTo(5.5, 9);
    expect(loud.speed).toBeCloseTo(5.2, 9);
  });

  it('has a time derivative that is nowhere identically zero', () => {
    // The whole point of the traveling wave: there is no setting of the mood,
    // no strand and no height at which the silk is a still picture. Sampled
    // rather than differentiated because the drift term wraps.
    for (const p of PARAMS) {
      const w = strandWaveFor(p.bass, p.tension, p.arousal);
      // amp·speed is the analytic bound on |dx/dt| from the wave alone.
      expect(w.amp * w.speed).toBeGreaterThan(0);
      for (const y of [-2, -0.7, 0, 1.3, 2]) {
        for (const phase of [0, 1.1, 3.9]) {
          for (const h of [0, 0.5, 1]) {
            let lo = Infinity;
            let hi = -Infinity;
            for (let i = 0; i <= 64; i++) {
              const x = strandOffsetX(y, 3 + (i / 64) * 1.2, phase, h, w);
              if (x < lo) lo = x;
              if (x > hi) hi = x;
            }
            expect(hi - lo).toBeGreaterThan(1e-3);
          }
        }
      }
    }
  });

  it('drifts sideways, and wraps rather than running away', () => {
    const w = strandWaveFor(0.5, 0.5, 0.5);
    // A strand whose hash is off centre keeps moving in one direction for
    // minutes; over an hour that is 90 units, and the camera sees 3.
    for (const h of [0, 0.2, 0.8, 1]) {
      for (let t = 0; t < 3600; t += 13.7) {
        const x = strandOffsetX(0.3, t, 1.7, h, w);
        expect(Math.abs(x)).toBeLessThan(3 + w.amp + 1e-6);
      }
    }
  });

  it('wraps the drift into [-3, 3] whichever way it is going', () => {
    expect(wrapDrift(0)).toBeCloseTo(0, 9);
    expect(wrapDrift(2.9)).toBeCloseTo(2.9, 9);
    expect(wrapDrift(3.5)).toBeCloseTo(-2.5, 9);
    expect(wrapDrift(-3.5)).toBeCloseTo(2.5, 9);
    expect(wrapDrift(15.5)).toBeCloseTo(3.5 - 6, 9);
  });
});

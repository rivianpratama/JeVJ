import { describe, expect, it } from 'vitest';
import {
  MAX_LEVEL_STEP,
  RMS_TAU,
  levelFor,
  slewLevel,
  smoothRms,
} from '../../src/visuals/breathLevel';

const FRAME = 1 / 60;

describe('slewLevel', () => {
  it('moves at most one step a frame, however far the target is', () => {
    expect(MAX_LEVEL_STEP).toBeCloseTo(0.08, 12);
    expect(slewLevel(0, 1)).toBeCloseTo(MAX_LEVEL_STEP, 12);
    expect(slewLevel(1, 0)).toBeCloseTo(1 - MAX_LEVEL_STEP, 12);
    expect(slewLevel(0.5, 1000)).toBeCloseTo(0.5 + MAX_LEVEL_STEP, 12);
  });

  it('lands exactly on a target inside one step, rather than overshooting', () => {
    expect(slewLevel(0.5, 0.52)).toBeCloseTo(0.52, 12);
    expect(slewLevel(0.5, 0.48)).toBeCloseTo(0.48, 12);
    expect(slewLevel(0.5, 0.5)).toBeCloseTo(0.5, 12);
  });

  it('never flashes: an alternating target cannot move the level far', () => {
    // The pathological case the cap exists for — a frame-alternating drive that
    // would otherwise strobe the whole screen at 30 Hz.
    let level = 0;
    let min = 1;
    let max = 0;
    for (let i = 0; i < 600; i++) {
      const before = level;
      level = slewLevel(level, i % 2 === 0 ? 1 : 0);
      expect(Math.abs(level - before)).toBeLessThanOrEqual(MAX_LEVEL_STEP + 1e-12);
      min = Math.min(min, level);
      max = Math.max(max, level);
    }
    expect(max - min).toBeLessThanOrEqual(MAX_LEVEL_STEP + 1e-12);
  });

  it('holds still on a non-finite target rather than going to NaN', () => {
    expect(slewLevel(0.4, Number.NaN)).toBeCloseTo(0.4, 12);
    expect(slewLevel(0.4, Number.POSITIVE_INFINITY)).toBeCloseTo(0.4 + MAX_LEVEL_STEP, 12);
  });

  it('reaches a full-scale target in at least a dozen frames', () => {
    let level = 0;
    let frames = 0;
    while (level < 1 - 1e-9 && frames < 1000) {
      level = slewLevel(level, 1);
      frames++;
    }
    expect(frames).toBeGreaterThanOrEqual(1 / MAX_LEVEL_STEP);
  });
});

describe('smoothRms', () => {
  it('covers about 63% of a step in one time constant', () => {
    expect(RMS_TAU).toBeCloseTo(0.15, 12);
    let v = 0;
    for (let t = 0; t < RMS_TAU - 1e-9; t += FRAME) v = smoothRms(v, 1, FRAME);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(0.68);
  });

  it('holds still on a zero step and clamps a huge one', () => {
    expect(smoothRms(0.3, 0.9, 0)).toBeCloseTo(0.3, 12);
    // A backgrounded tab returns an enormous dt. It is clamped to 0.1 s, like
    // every other step in the app, so the band cannot jump on the frame a tab
    // comes back — and it can never overshoot the target whatever dt says.
    expect(smoothRms(0, 1, 10)).toBeCloseTo(smoothRms(0, 1, 0.1), 12);
    expect(smoothRms(0, 1, 10)).toBeLessThan(1);
    expect(smoothRms(0, 1, 10)).toBeGreaterThan(0);
  });
});

describe('levelFor', () => {
  it('rises with the smoothed loudness and stays inside 0..1', () => {
    expect(levelFor(0)).toBeGreaterThan(0);
    expect(levelFor(0)).toBeLessThan(levelFor(0.3));
    expect(levelFor(1)).toBeLessThanOrEqual(1);
    expect(levelFor(-5)).toBeGreaterThanOrEqual(0);
    expect(levelFor(Number.NaN)).toBeGreaterThanOrEqual(0);
  });
});

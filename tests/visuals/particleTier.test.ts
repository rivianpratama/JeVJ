import { describe, expect, it } from 'vitest';
import {
  CHANGE_COOLDOWN_SEC,
  TIER_LARGE,
  TIER_SMALL,
  createTierState,
  stepTier,
  type TierInput,
  type TierState,
} from '../../src/visuals/particleTier';

const FRAME = 1 / 60;
const BIG_GPU = 16384;

function input(over: Partial<TierInput> = {}): TierInput {
  return {
    dt: FRAME,
    frameMs: 6,
    maxTextureSize: BIG_GPU,
    playing: true,
    reducedMotion: false,
    ...over,
  };
}

/** Run `seconds` of frames at one frame time, returning the tier at the end. */
function run(s: TierState, seconds: number, over: Partial<TierInput> = {}): number {
  let size = s.size;
  for (let i = 0; i < Math.round(seconds * 60); i++) size = stepTier(s, input(over));
  return size;
}

describe('stepTier', () => {
  it('starts small: nobody has measured anything yet', () => {
    expect(createTierState().size).toBe(TIER_SMALL);
  });

  it('promotes after three seconds of comfortable frames', () => {
    const s = createTierState();
    expect(run(s, 2.5, { frameMs: 6 })).toBe(TIER_SMALL);
    expect(run(s, 1.5, { frameMs: 6 })).toBe(TIER_LARGE);
  });

  it('will not promote on an idle page: no music is not a measurement', () => {
    const s = createTierState();
    expect(run(s, 30, { frameMs: 4, playing: false })).toBe(TIER_SMALL);
  });

  it('will not promote a GPU that cannot hold an 8192 texture', () => {
    const s = createTierState();
    expect(run(s, 30, { frameMs: 4, maxTextureSize: 4096 })).toBe(TIER_SMALL);
  });

  it('never promotes under reduced motion', () => {
    const s = createTierState();
    expect(run(s, 30, { frameMs: 3, reducedMotion: true })).toBe(TIER_SMALL);
  });

  it('wants the three seconds consecutive, not merely accumulated', () => {
    const s = createTierState();
    run(s, 2.5, { frameMs: 6 });
    // One slow stretch resets the run — the smoothed reading has to climb back
    // over the line and then hold it again from zero.
    run(s, 1, { frameMs: 13 });
    expect(run(s, 2.5, { frameMs: 6 })).toBe(TIER_SMALL);
    expect(run(s, 1.5, { frameMs: 6 })).toBe(TIER_LARGE);
  });

  it('demotes after two seconds of frames it cannot afford', () => {
    const s = createTierState();
    run(s, 4, { frameMs: 6 });
    expect(s.size).toBe(TIER_LARGE);
    expect(run(s, 1.5, { frameMs: 20 })).toBe(TIER_LARGE);
    expect(run(s, 1.5, { frameMs: 20 })).toBe(TIER_SMALL);
  });

  it('rides out a spike rather than rebuilding for it', () => {
    const s = createTierState();
    run(s, 4, { frameMs: 6 });
    // A second of jank — a garbage collection, a resize — is not a verdict.
    expect(run(s, 1, { frameMs: 40 })).toBe(TIER_LARGE);
    expect(run(s, 5, { frameMs: 6 })).toBe(TIER_LARGE);
  });

  it('holds a promotion back for thirty seconds after the last change', () => {
    const s = createTierState();
    run(s, 4, { frameMs: 6 });
    run(s, 3, { frameMs: 20 });
    expect(s.size).toBe(TIER_SMALL);

    // Comfortable again immediately, but the cooldown has not run out.
    expect(run(s, CHANGE_COOLDOWN_SEC - 6, { frameMs: 5 })).toBe(TIER_SMALL);
    expect(run(s, 8, { frameMs: 5 })).toBe(TIER_LARGE);
  });

  it('demotes without waiting for the cooldown, because it is the safety valve', () => {
    const s = createTierState();
    run(s, 4, { frameMs: 6 });
    expect(s.size).toBe(TIER_LARGE);
    // Only three seconds after the promotion, and it still gets out.
    expect(run(s, 3, { frameMs: 25 })).toBe(TIER_SMALL);
  });

  it('smooths the frame time with a half-second time constant', () => {
    const s = createTierState();
    stepTier(s, input({ frameMs: 5 }));
    // The first sample seeds the average rather than being eased into from 0,
    // which would read as a comfortably fast machine before anything is known.
    expect(s.frameMs).toBeCloseTo(5, 6);
    run(s, 0.5, { frameMs: 20 });
    // One time constant covers ~63% of the distance.
    expect(s.frameMs).toBeGreaterThan(5 + 0.6 * 15);
    expect(s.frameMs).toBeLessThan(5 + 0.68 * 15);
  });
});

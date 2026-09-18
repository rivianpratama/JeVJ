import { describe, expect, it } from 'vitest';

import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { CueTimeline } from '../../src/timeline/timeline';
import { writeTransitionCues, type TransitionContext } from '../../src/timeline/transitionWriter';
import type { Cue, MoodVector, TransitionKind, TransitionVerdict } from '../../src/shared/types';
import { exampleVerdict } from '../helpers/moodFixture';

const BAR = 2;
const AT = 24;

const MOOD: MoodVector = { ...NEUTRAL_MOOD, arousal: 0.8, tension: 0.4, space: 0.5, aggression: 0.1 };

function verdict(kind: TransitionKind, over: Partial<TransitionVerdict> = {}): TransitionVerdict {
  return exampleVerdict({ kind, dramatic: 0.2, intensity: 0.7, ...over });
}

function write(
  kind: TransitionKind,
  over: Partial<TransitionVerdict> = {},
  ctx: Partial<TransitionContext> = {},
): Cue[] {
  const tl = new CueTimeline();
  writeTransitionCues(tl, AT, verdict(kind, over), { barSec: BAR, mood: MOOD, ...ctx });
  return [...tl.cues()];
}

/** The cue at `t`, to within half a step. */
function at(cues: Cue[], t: number): Cue | undefined {
  return cues.find((c) => Math.abs(c.t - t) < 1e-6);
}

describe('writeTransitionCues: drop', () => {
  it('hits at the exact instant with the intensity as its impact', () => {
    const hit = at(write('drop'), AT);
    expect(hit?.impact).toBe(0.7);
    expect(hit?.section).toBe('drop_climax');
    expect(hit?.build).toBe(1);
    expect(hit?.source).toBe('jev');
    expect(hit?.transition).toBe('drop');
  });

  it('prefers the detector instant when there is one', () => {
    const cues = write('drop', {}, { detectorT: AT + 0.017 });
    expect(at(cues, AT + 0.017)?.impact).toBe(0.7);
    expect(at(cues, AT)?.impact).toBeUndefined();
  });

  it('lands on the strongest slam the detector stamped shortly before the candidate', () => {
    const slams = [
      { t: AT - 1.4, strength: 0.9 },
      { t: AT - 0.3, strength: 0.4 },
      { t: AT - 4, strength: 1 },
    ];
    const cues = write('drop', {}, { slams });
    expect(at(cues, AT - 1.4)?.impact).toBe(0.7);
    expect(at(cues, AT)?.impact).toBeUndefined();
    expect(at(cues, AT - 4)?.impact).toBeUndefined();
  });

  it('writes one hit when two candidates name the same slam', () => {
    const tl = new CueTimeline();
    const slams = [{ t: AT - 1.2, strength: 0.8 }];
    writeTransitionCues(tl, AT - 1.2, verdict('drop'), { barSec: BAR, mood: MOOD, detectorT: AT - 1.2 });
    writeTransitionCues(tl, AT, verdict('drop', { intensity: 0.5 }), { barSec: BAR, mood: MOOD, slams });
    const hits = [...tl.cues()].filter((c) => c.transition === 'drop' && c.impact !== undefined);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.impact).toBe(0.7);
  });

  it('ramps the build from 0 to 1 over the two bars before it', () => {
    const cues = write('drop');
    const start = AT - 2 * BAR;
    expect(at(cues, start)?.build).toBe(0);
    expect(at(cues, start + 2)?.build).toBeCloseTo(0.5, 6);
    expect(at(cues, AT - 0.2)?.build).toBeCloseTo(0.95, 6);
    // Every 0.2 s of the ramp, plus the hit and its release.
    expect(cues.filter((c) => c.build !== undefined)).toHaveLength(2 * BAR / 0.2 + 2);
  });

  it('releases the ramp one step after the hit', () => {
    expect(at(write('drop'), AT + 0.2)?.build).toBe(0);
  });

  it('cuts a ramp that would start before the top of the track', () => {
    const tl = new CueTimeline();
    writeTransitionCues(tl, 1, verdict('drop'), { barSec: BAR, mood: MOOD });
    const builds = [...tl.cues()].filter((c) => c.build !== undefined);
    expect(builds[0]?.t).toBe(0);
    expect(builds.every((c) => c.t >= 0)).toBe(true);
  });

  it('still draws a ramp when the grid never locked', () => {
    const cues = write('drop', {}, { barSec: 0 });
    expect(at(cues, AT - 4)?.build).toBe(0);
  });
});

describe('writeTransitionCues: sections', () => {
  it('declares a build at a build_start and nothing else', () => {
    const cues = write('build_start');
    expect(cues).toHaveLength(1);
    expect(cues[0]?.section).toBe('build');
    expect(cues[0]?.impact).toBeUndefined();
  });

  for (const kind of ['breakdown', 'quiet_fall'] as const) {
    it(`pulls the arousal down for two bars at a ${kind}`, () => {
      const cues = write(kind);
      expect(at(cues, AT)?.section).toBe('breakdown');
      expect(at(cues, AT)?.mood?.arousal).toBeCloseTo(0.5, 6);
      expect(at(cues, AT + 2 * BAR)?.mood?.arousal).toBe(0.8);
      expect(at(cues, AT + 2 * BAR)?.section).toBeUndefined();
    });
  }

  it('never lets an adjustment leave the 0..1 range', () => {
    const tl = new CueTimeline();
    writeTransitionCues(tl, AT, verdict('breakdown'), {
      barSec: BAR,
      mood: { ...MOOD, arousal: 0.1 },
    });
    expect([...tl.cues()][0]?.mood?.arousal).toBe(0);
  });
});

describe('writeTransitionCues: holes and screams', () => {
  it('opens full tension at a break_silence and closes it on the return', () => {
    const cues = write('break_silence', {}, { jumpDb: 2, returnT: AT + 1 });
    expect(at(cues, AT)?.build).toBe(1);
    expect(at(cues, AT + 1)?.build).toBe(0);
    expect(at(cues, AT + 1)?.impact).toBeUndefined();
  });

  it('hits on the return when the energy actually came back', () => {
    const cues = write('break_silence', {}, { jumpDb: 6, returnT: AT + 1 });
    expect(at(cues, AT + 1)?.impact).toBe(0.7);
  });

  it('closes a hole one bar later when nothing said when it ended', () => {
    expect(at(write('break_silence'), AT + BAR)?.build).toBe(0);
  });

  it('floors a scream at 0.8 however mild the model called it', () => {
    expect(at(write('scream_peak', { intensity: 0.2 }), AT)?.impact).toBe(0.8);
    expect(at(write('scream_peak', { intensity: 0.95 }), AT)?.impact).toBe(0.95);
  });

  it('holds full aggression for one bar after a scream, then puts it back', () => {
    const cues = write('scream_peak');
    expect(at(cues, AT)?.mood?.aggression).toBe(1);
    expect(at(cues, AT + BAR)?.mood?.aggression).toBe(0.1);
  });
});

describe('writeTransitionCues: the quieter kinds', () => {
  it('opens the space and marks a pulse when a voice enters', () => {
    const cues = write('vocal_entry');
    expect(cues).toHaveLength(1);
    expect(cues[0]?.mood?.space).toBeCloseTo(0.7, 6);
    expect(cues[0]?.mood?.motion).toBe('pulse');
    expect(cues[0]?.section).toBeUndefined();
  });

  for (const kind of ['tempo_change', 'key_change'] as const) {
    it(`raises tension for two bars at a ${kind} and leaves the section alone`, () => {
      const cues = write(kind);
      expect(at(cues, AT)?.mood?.tension).toBeCloseTo(0.6, 6);
      expect(at(cues, AT)?.section).toBeUndefined();
      expect(at(cues, AT + 2 * BAR)?.mood?.tension).toBe(0.4);
    });
  }

  it('writes nothing at all for none', () => {
    expect(write('none')).toEqual([]);
  });
});

describe('writeTransitionCues: flourish', () => {
  it('flags every cue it writes when the model called the moment a jolt', () => {
    for (const kind of ['drop', 'build_start', 'breakdown', 'vocal_entry', 'scream_peak'] as const) {
      const cues = write(kind, { dramatic: 0.6 });
      expect(cues.some((c) => c.flourish === true)).toBe(true);
    }
  });

  it('leaves the flag off below the threshold', () => {
    const cues = write('drop', { dramatic: 0.59 });
    expect(cues.every((c) => c.flourish === undefined)).toBe(true);
  });

  it('does not flourish on a return the energy never came back to', () => {
    const cues = write('break_silence', { dramatic: 0.9 }, { jumpDb: 0, returnT: AT + 1 });
    expect(at(cues, AT)?.flourish).toBe(true);
    expect(at(cues, AT + 1)?.flourish).toBeUndefined();
  });
});

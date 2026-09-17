import { describe, expect, it } from 'vitest';
import { ONSET_REPORT_LAG_SEC } from '../../src/analysis/onset';
import { CueTimeline } from '../../src/timeline/timeline';
import { applyDetectorEvent } from '../../src/timeline/detectorWriter';
import type { DropEvent } from '../../src/analysis/drop';

/** A detector event that, once its reporting lag is taken off, lands on `t`. */
function heardAt(t: number, o: Omit<Partial<DropEvent>, 't'> = {}): DropEvent {
  return { strength: 0.7, kind: 'impact', ...o, t: t + ONSET_REPORT_LAG_SEC };
}

describe('applyDetectorEvent', () => {
  it('re-anchors a predicted impact onto the instant it actually landed', () => {
    const tl = new CueTimeline();
    tl.add({ t: 14, source: 'jev', impact: 0.6, section: 'drop_climax' });
    tl.add({ t: 14.5, source: 'grid', beat: true });

    applyDetectorEvent(tl, heardAt(14.03), 14.05, { beatSec: 0.5 });

    const impacts = tl.cues().filter((c) => c.impact !== undefined);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.t).toBeCloseTo(14.03, 6);
    // The measurement was harder than the prediction, so it wins.
    expect(impacts[0]!.impact).toBeCloseTo(0.7, 6);
    expect(impacts[0]!.section).toBe('drop_climax');
    // The grid it was predicted against moves with it.
    expect(tl.cues().filter((c) => c.source === 'grid')[0]!.t).toBeCloseTo(14.53, 6);
  });

  it('keeps the prediction when the prediction was the stronger claim', () => {
    const tl = new CueTimeline();
    tl.add({ t: 14, source: 'jev', impact: 0.9 });

    applyDetectorEvent(tl, heardAt(14.03, { strength: 0.4 }), 14.05, { beatSec: 0.5 });

    expect(tl.cues()[0]!.impact).toBeCloseTo(0.9, 6);
    expect(tl.cues()[0]!.t).toBeCloseTo(14.03, 6);
  });

  it('writes its own cue when nothing predicted the hit', () => {
    const tl = new CueTimeline();
    tl.add({ t: 14, source: 'jev', impact: 0.6 });

    // Over a beat away from the prediction: a different event.
    applyDetectorEvent(tl, heardAt(20), 20.02, { beatSec: 0.5 });

    const detector = tl.cues().filter((c) => c.source === 'detector');
    expect(detector).toHaveLength(1);
    expect(detector[0]!.t).toBeCloseTo(20, 6);
    expect(detector[0]!.impact).toBeCloseTo(0.7, 6);
    // And the prediction it did not confirm is left where it was, to decay.
    expect(tl.cues().filter((c) => c.source === 'jev')[0]!.t).toBe(14);
  });

  it('subtracts the reporting lag and the capture latency from the cue time', () => {
    const tl = new CueTimeline();
    applyDetectorEvent(tl, { t: 20, strength: 0.5, kind: 'impact' }, 20.02, { latencySec: 0.04 });

    expect(tl.cues()[0]!.t).toBeCloseTo(20 - ONSET_REPORT_LAG_SEC - 0.04, 6);
  });

  it('turns a hole into a full build', () => {
    const tl = new CueTimeline();
    applyDetectorEvent(tl, heardAt(9.8, { kind: 'gap', strength: 0.6 }), 9.82);

    const cue = tl.cues()[0]!;
    expect(cue.source).toBe('detector');
    expect(cue.build).toBe(1);
    expect(cue.impact).toBeUndefined();
    expect(cue.t).toBeCloseTo(9.8, 6);
  });

  it('ignores an event from before the window the timeline keeps', () => {
    const tl = new CueTimeline();
    applyDetectorEvent(tl, heardAt(10), 30);
    expect(tl.cues()).toHaveLength(0);
  });
});

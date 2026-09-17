import { describe, expect, it } from 'vitest';
import { BeatGrid } from '../../src/analysis/grid';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { CueTimeline } from '../../src/timeline/timeline';
import { applyDetectorEvent } from '../../src/timeline/detectorWriter';
import { writeJevCues } from '../../src/timeline/jevWriter';
import type { DropEvent } from '../../src/analysis/drop';

/**
 * A detector event stamped at `t`.
 *
 * Every timestamp here is analysis time, the clock the frames themselves are
 * on: the writer does not compensate for anything, the reader does it once.
 */
function calledAt(t: number, o: Omit<Partial<DropEvent>, 't'> = {}): DropEvent {
  return { strength: 0.7, kind: 'impact', ...o, t };
}

describe('applyDetectorEvent', () => {
  it('re-anchors a predicted impact onto the instant it actually landed', () => {
    const tl = new CueTimeline();
    tl.add({ t: 14, source: 'jev', impact: 0.6, section: 'drop_climax' });
    tl.add({ t: 14.5, source: 'grid', beat: true });

    applyDetectorEvent(tl, calledAt(14.03), 14.05, { beatSec: 0.5 });

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

    applyDetectorEvent(tl, calledAt(14.03, { strength: 0.4 }), 14.05, { beatSec: 0.5 });

    expect(tl.cues()[0]!.impact).toBeCloseTo(0.9, 6);
    expect(tl.cues()[0]!.t).toBeCloseTo(14.03, 6);
  });

  it('writes its own cue when nothing predicted the hit', () => {
    const tl = new CueTimeline();
    tl.add({ t: 14, source: 'jev', impact: 0.6 });

    // Over a beat away from the prediction: a different event.
    applyDetectorEvent(tl, calledAt(20), 20.02, { beatSec: 0.5 });

    const detector = tl.cues().filter((c) => c.source === 'detector');
    expect(detector).toHaveLength(1);
    expect(detector[0]!.t).toBeCloseTo(20, 6);
    expect(detector[0]!.impact).toBeCloseTo(0.7, 6);
    // And the prediction it did not confirm is left where it was, to decay.
    expect(tl.cues().filter((c) => c.source === 'jev')[0]!.t).toBe(14);
  });

  it('writes the event at its own analysis time, compensating for nothing', () => {
    const tl = new CueTimeline();
    applyDetectorEvent(tl, { t: 20, strength: 0.5, kind: 'impact' }, 20.02);

    // The reporting lag and the capture latency are the reader's business:
    // the grid, the frames and Jev's cues are all on this same late clock, and
    // taking the lag off here would compare a measurement against predictions
    // written 15 ms later than it.
    expect(tl.cues()[0]!.t).toBe(20);
  });

  it('turns a hole into a full build that releases within a beat', () => {
    const tl = new CueTimeline();
    applyDetectorEvent(tl, calledAt(9.8, { kind: 'gap', strength: 0.6 }), 9.82, { beatSec: 0.6 });

    const builds = tl.cues().filter((c) => c.build !== undefined);
    expect(builds).toHaveLength(2);
    expect(builds[0]!.source).toBe('detector');
    expect(builds[0]!.build).toBe(1);
    expect(builds[0]!.impact).toBeUndefined();
    expect(builds[0]!.t).toBeCloseTo(9.8, 6);

    expect(tl.at(9.8).build).toBe(1);
    // A hole nobody follows up on lets go again rather than sticking at full
    // tension for the rest of the track.
    expect(tl.at(9.8 + 0.6).build).toBe(0);
    expect(tl.at(11).build).toBe(0);
  });

  it('releases a hole over half a second when there is no beat to use', () => {
    const tl = new CueTimeline();
    applyDetectorEvent(tl, calledAt(9.8, { kind: 'gap' }), 9.82);

    expect(tl.at(10).build).toBeGreaterThan(0);
    expect(tl.at(10.3).build).toBe(0);
  });

  it('does not notch the ramp it lands in the middle of', () => {
    const tl = new CueTimeline();
    // A 120 BPM grid, and a drop Jev has put at 14 with a ramp from 10.
    const grid = new BeatGrid();
    grid.onOnset(1.5, 1, 1);
    grid.setTempo({ bpm: 120, period: 0.5, confidence: 0.9, marking: 'allegro' }, 1.5);
    grid.tick(10);
    writeJevCues(
      tl,
      { ...NEUTRAL_MOOD, dropImminent: 0.9, beatsToChange: '8', impact: 0.8 },
      grid,
      10,
    );

    // Two bars in, the floor drops out for a moment: the visuals go to full
    // tension, and when the hole releases they fall back onto the ramp they
    // were already climbing — not through it.
    applyDetectorEvent(tl, { t: 12.03, strength: 0.6, kind: 'gap' }, 12.05, { beatSec: 0.5 });

    expect(tl.at(12.03).build).toBe(1);
    // Never below the ramp Jev drew: the hole's release ends the detector's
    // own ramp and nothing else. (It is not monotonic across the hole itself —
    // the spike to 1 falls back *onto* the ramp, which is the point.)
    for (let t = 12; t <= 14.0001; t += 0.01) {
      expect(tl.at(t).build).toBeGreaterThanOrEqual((t - 10) / 4 - 1e-9);
    }
    // And once the hole has let go, the climb continues undisturbed.
    let previous = -1;
    for (let t = 12.6; t <= 14.0001; t += 0.01) {
      const build = tl.at(t).build;
      expect(build).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = build;
    }
    expect(tl.at(14).build).toBeCloseTo(1, 6);
  });

  it('ignores an event from before the window the timeline keeps', () => {
    const tl = new CueTimeline();
    applyDetectorEvent(tl, calledAt(10), 30);
    expect(tl.cues()).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { CueTimeline, impactTau } from '../../src/timeline/timeline';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import type { Cue, TransitionKind } from '../../src/shared/types';

function jevMood(t: number, valence: number): Cue {
  return { t, source: 'jev', mood: { ...NEUTRAL_MOOD, valence } };
}

describe('CueTimeline', () => {
  it('keeps cues sorted however they arrive', () => {
    const tl = new CueTimeline();
    tl.add({ t: 3, source: 'grid', beat: true });
    tl.add({ t: 1, source: 'grid', beat: true });
    tl.add({ t: 2, source: 'grid', beat: true });

    expect(tl.cues().map((c) => c.t)).toEqual([1, 2, 3]);
  });

  it('interpolates mood linearly between the jev cues around it', () => {
    const tl = new CueTimeline();
    tl.add(jevMood(0, 0));
    tl.add(jevMood(4, 1));

    expect(tl.at(2).mood.valence).toBeCloseTo(0.5, 6);
    expect(tl.at(1).mood.valence).toBeCloseTo(0.25, 6);
    expect(tl.at(0).mood.valence).toBeCloseTo(0, 6);
    expect(tl.at(4).mood.valence).toBeCloseTo(1, 6);
    // Past the last cue the last answer stands.
    expect(tl.at(9).mood.valence).toBeCloseTo(1, 6);
  });

  it('interpolates across an offline cue too, and holds labels until they land', () => {
    const tl = new CueTimeline();
    tl.add({ t: 0, source: 'offline', mood: { ...NEUTRAL_MOOD, arousal: 0, genre: 'ambient_drone' } });
    tl.add({ t: 10, source: 'offline', mood: { ...NEUTRAL_MOOD, arousal: 1, genre: 'electronic_dance' } });

    expect(tl.at(5).mood.arousal).toBeCloseTo(0.5, 6);
    expect(tl.at(5).mood.genre).toBe('ambient_drone');
    expect(tl.at(10).mood.genre).toBe('electronic_dance');
  });

  it('fires on the sample and rings for as long as the hit was hard', () => {
    // The sustain is the hit's own: `0.25 + 0.5·intensity`, so a slam is still
    // half there three quarters of a second later and a tap is not.
    const slam = new CueTimeline();
    slam.add({ t: 3, source: 'jev', impact: 1 });
    expect(slam.at(3).impact).toBeCloseTo(1, 6);
    expect(slam.at(3 + impactTau(1)).impact).toBeCloseTo(Math.exp(-1), 6);
    expect(slam.at(2.9).impact).toBe(0);

    const tap = new CueTimeline();
    tap.add({ t: 3, source: 'jev', impact: 0.2 });
    expect(tap.at(3 + impactTau(1)).impact).toBeLessThan(0.2 * Math.exp(-1));

    // Half a second after both, the slam is worth more than three times the
    // tap — against 1.25 times if they decayed at one rate.
    expect(slam.at(3.5).impact / tap.at(3.5).impact).toBeGreaterThan(3);
  });

  it('takes the strongest impact still ringing', () => {
    const tl = new CueTimeline();
    tl.add({ t: 3, source: 'jev', impact: 1 });
    tl.add({ t: 3.2, source: 'detector', impact: 0.5 });

    // The older, louder one is still worth more than the new one at 3.2: it hit
    // harder and it rings for longer, which is the point of the scaling.
    expect(tl.at(3.2).impact).toBeCloseTo(Math.exp(-0.2 / impactTau(1)), 6);
    expect(tl.at(3.2).impact).toBeGreaterThan(0.5);
  });

  it('scales the sustain with the hit, and clamps a nonsense one', () => {
    expect(impactTau(0)).toBeCloseTo(0.25, 9);
    expect(impactTau(0.5)).toBeCloseTo(0.5, 9);
    expect(impactTau(1)).toBeCloseTo(0.75, 9);
    // Monotone in between, and nothing outside 0..1 can lengthen or shorten it.
    let previous = 0;
    for (let i = 0; i <= 1.0001; i += 0.1) {
      expect(impactTau(i)).toBeGreaterThan(previous);
      previous = impactTau(i);
    }
    expect(impactTau(-1)).toBe(impactTau(0));
    expect(impactTau(4)).toBe(impactTau(1));
    expect(impactTau(Number.NaN)).toBe(impactTau(0));
  });

  it('interpolates the build between the cues bracketing it', () => {
    const tl = new CueTimeline();
    expect(tl.at(0).build).toBe(0);

    tl.add({ t: 1, source: 'jev', build: 0 });
    tl.add({ t: 2, source: 'jev', build: 1 });

    expect(tl.at(1.5).build).toBeCloseTo(0.5, 6);
    expect(tl.at(1.9).build).toBeCloseTo(0.9, 6);
    expect(tl.at(2).build).toBe(1);
  });

  it('lets the build fall back to nothing once its ramp is over', () => {
    const tl = new CueTimeline();
    tl.add({ t: 1, source: 'jev', build: 0.75 });

    // One step of hold covers the gap between two samples of a live ramp…
    expect(tl.at(1.15).build).toBeCloseTo(0.75, 6);
    // …and past that, with nothing written after it, the ramp is over.
    expect(tl.at(1.5).build).toBe(0);
    expect(tl.at(50).build).toBe(0);
  });

  it('keeps each source on its own build channel and reads the loudest', () => {
    const tl = new CueTimeline();
    // A Jev ramp from 4 to 6…
    for (let t = 4; t < 6; t += 0.2) tl.add({ t, source: 'jev', build: (t - 4) / 2 });
    tl.add({ t: 6, source: 'jev', build: 1 });
    // …and a hole the detector found in the middle of it, with its release.
    tl.add({ t: 5, source: 'detector', build: 1 });
    tl.add({ t: 5.5, source: 'detector', build: 0 });

    // The hole is at full tension, and the release that follows it ends the
    // detector's own ramp — not Jev's, which keeps climbing under it.
    expect(tl.at(5).build).toBe(1);
    // Halfway between the detector's release and Jev's next sample: on Jev's
    // ramp, not dragged down toward the release that was never about it.
    expect(tl.at(5.55).build).toBeCloseTo(0.775, 6);
    expect(tl.at(6).build).toBe(1);
  });

  it('does not ramp across two build cues that are not one ramp', () => {
    const tl = new CueTimeline();
    tl.add({ t: 1, source: 'jev', build: 0 });
    tl.add({ t: 40, source: 'detector', build: 1 });

    // A hole 39 seconds away is not something to tighten into now.
    expect(tl.at(20).build).toBe(0);
    expect(tl.at(40).build).toBe(1);
  });

  it('reports the section last written', () => {
    const tl = new CueTimeline();
    expect(tl.at(0).section).toBeUndefined();

    tl.add({ t: 1, source: 'jev', section: 'build' });
    tl.add({ t: 2, source: 'jev', section: 'drop_climax' });

    expect(tl.at(1.5).section).toBe('build');
    expect(tl.at(2).section).toBe('drop_climax');
  });

  it('merges cues within 5 ms from the same source', () => {
    const tl = new CueTimeline();
    tl.add({ t: 3, source: 'jev', impact: 0.4, section: 'drop_climax' });
    tl.add({ t: 3.002, source: 'jev', impact: 0.9 });

    expect(tl.cues()).toHaveLength(1);
    expect(tl.cues()[0]!.impact).toBe(0.9);
    expect(tl.cues()[0]!.section).toBe('drop_climax');
  });

  it('keeps the hit where the hit is when a merge moves a cue', () => {
    const tl = new CueTimeline();
    // The last sample of a ramp, three milliseconds before the target…
    tl.add({ t: 13.997, source: 'jev', build: 0.999 });
    // …and the hit itself. One cue comes out, and it is at the hit.
    tl.add({ t: 14, source: 'jev', impact: 0.8, build: 1 });

    expect(tl.cues()).toHaveLength(1);
    expect(tl.cues()[0]!.t).toBe(14);
    expect(tl.at(14).impact).toBeCloseTo(0.8, 6);
  });

  it('keeps cues from different sources apart, however close', () => {
    const tl = new CueTimeline();
    tl.add({ t: 3, source: 'jev', impact: 0.4 });
    tl.add({ t: 3.001, source: 'detector', impact: 0.9 });

    expect(tl.cues()).toHaveLength(2);
  });

  it('prunes what has gone by', () => {
    const tl = new CueTimeline();
    for (let t = 0; t <= 4; t += 1) tl.add({ t, source: 'grid', beat: true });
    tl.prune(2);

    expect(tl.cues().map((c) => c.t)).toEqual([2, 3, 4]);
  });

  it('keeps what is still in force when it prunes', () => {
    const tl = new CueTimeline();
    tl.add(jevMood(0, 0.9));
    tl.add({ t: 0.5, source: 'jev', section: 'breakdown' });
    tl.add({ t: 9.9, source: 'jev', build: 0.4 });
    tl.add({ t: 10.1, source: 'jev', build: 1 });
    for (let t = 0; t <= 20; t += 0.5) tl.add({ t, source: 'grid', beat: true });

    tl.prune(10);

    // The beats are gone; what the renderer would read at 10 is not.
    expect(tl.cues().filter((c) => c.source === 'grid' && c.t < 10)).toHaveLength(0);
    expect(tl.at(10).mood.valence).toBeCloseTo(0.9, 6);
    // The build cue that opens the ramp still runs at 10: without it the ramp
    // into 10.1 would have no left-hand end.
    expect(tl.cues().filter((c) => c.build !== undefined && c.t < 10)).toHaveLength(1);
    expect(tl.at(10).section).toBe('breakdown');
    expect(tl.cues().map((c) => c.t)).toEqual([...tl.cues().map((c) => c.t)].sort((a, b) => a - b));
  });

  it('keeps a ramp anchor for every source, not just the last one written', () => {
    const tl = new CueTimeline();
    // Jev's ramp from 9 to 13, and a hole the detector found at 12.03.
    for (let t = 9; t < 13; t += 0.2) tl.add({ t, source: 'jev', build: (t - 9) / 4 });
    tl.add({ t: 13, source: 'jev', build: 1 });
    // A hole the detector found half a bar back, released just before the
    // cutoff — so the last build cue before the cutoff is the detector's, and
    // it is a zero.
    tl.add({ t: 11.5, source: 'detector', build: 1 });
    tl.add({ t: 12.05, source: 'detector', build: 0 });

    const before = tl.at(12.15).build;
    expect(before).toBeCloseTo(0.7875, 6);

    // Keeping one survivor for the whole channel keeps that zero and drops
    // Jev's anchor at 12.0, which leaves its climb with no left-hand end and
    // reads nothing at all until the next sample lands.
    tl.prune(12.1);

    expect(tl.at(12.15).build).toBeCloseTo(before, 6);
  });

  it('does not keep a build cue too old to be read anyway', () => {
    const tl = new CueTimeline();
    tl.add({ t: 5, source: 'jev', build: 0.5 });
    tl.add({ t: 5.2, source: 'detector', build: 1 });
    for (let t = 9; t <= 12; t += 0.5) tl.add({ t, source: 'grid', beat: true });

    tl.prune(10);

    // Nothing can interpolate with a cue five seconds back and nothing holds
    // that long, so keeping one per source is not a licence to keep them.
    expect(tl.cues().filter((c) => c.build !== undefined)).toHaveLength(0);
  });

  it('lists what is coming inside the horizon', () => {
    const tl = new CueTimeline();
    for (let t = 0; t <= 20; t += 1) tl.add({ t, source: 'grid', beat: true });

    const next = tl.upcoming(5, 8);
    expect(next.map((c) => c.t)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('replaces one source from a point on, leaving the rest alone', () => {
    const tl = new CueTimeline();
    for (let t = 0; t <= 8; t += 1) tl.add({ t, source: 'grid', beat: true });
    tl.add({ t: 6, source: 'jev', impact: 1 });

    tl.replaceSource('grid', 5, [
      { t: 5.5, source: 'grid', beat: true },
      { t: 6.5, source: 'grid', beat: true },
    ]);

    const grid = tl.cues().filter((c) => c.source === 'grid');
    expect(grid.map((c) => c.t)).toEqual([0, 1, 2, 3, 4, 5.5, 6.5]);
    // The jev impact at 6 was never this source's to remove.
    expect(tl.cues().filter((c) => c.source === 'jev')).toHaveLength(1);
  });

  it('reanchors the predicted future onto the measured instant', () => {
    const tl = new CueTimeline();
    tl.add({ t: 3, source: 'jev', impact: 1 });
    tl.add({ t: 3.5, source: 'grid', beat: true });
    tl.add({ t: 2.5, source: 'grid', beat: true });
    tl.add({ t: 3.02, source: 'detector', impact: 0.2 });

    tl.reanchor(3.0, 3.04);

    const at = (source: string, impactOrBeat: 'impact' | 'beat'): number[] =>
      tl.cues().filter((c) => c.source === source && c[impactOrBeat] !== undefined).map((c) => c.t);

    expect(at('jev', 'impact')[0]).toBeCloseTo(3.04, 6);
    expect(at('grid', 'beat')).toEqual([2.5, 3.54]);
    // Measurements are not predictions: nothing shifts them.
    expect(at('detector', 'impact')[0]).toBeCloseTo(3.02, 6);
    // And the list is still in order.
    expect(tl.cues().map((c) => c.t)).toEqual([...tl.cues().map((c) => c.t)].sort((a, b) => a - b));
  });

  it('shifts a cue that sits just inside the reanchor tolerance', () => {
    const tl = new CueTimeline();
    tl.add({ t: 2.96, source: 'jev', impact: 1 });
    tl.reanchor(3.0, 3.04);
    expect(tl.cues()[0]!.t).toBeCloseTo(3.0, 6);
  });

  it('removes what a caller no longer believes', () => {
    const tl = new CueTimeline();
    tl.add({ t: 1, source: 'jev', build: 0.5 });
    tl.add({ t: 1, source: 'grid', beat: true });

    tl.remove((c) => c.source === 'jev');
    expect(tl.cues()).toHaveLength(1);
    expect(tl.cues()[0]!.source).toBe('grid');
  });

  it('reads the middle of a long track as fast as the middle of a short one', () => {
    /** A file-mode timeline: every beat of the track, a mood cue per segment. */
    const track = (seconds: number): CueTimeline => {
      const tl = new CueTimeline();
      for (let t = 0; t < seconds; t += 0.5) {
        tl.add({ t, source: 'offline', beat: true, downbeat: t % 2 === 0 });
      }
      for (let t = 0; t < seconds; t += 20) tl.add(jevMood(t, 0.5));
      return tl;
    };

    /** Milliseconds for a thousand reads around `at`, warmed up first. */
    const thousandReads = (tl: CueTimeline, at: number): number => {
      for (let i = 0; i < 1000; i++) tl.at(at + i * 0.001);
      const started = performance.now();
      for (let i = 0; i < 1000; i++) tl.at(at + i * 0.001);
      return performance.now() - started;
    };

    const short = thousandReads(track(50), 25);
    const long = thousandReads(track(1000), 500);

    // A read is a binary search and a two-second window, not a walk back to
    // the top of the track: twenty times the cues must not cost twenty times
    // the reads. (The generous ratio is for a loaded CI box, not for slack —
    // scanning the whole list would be 20× on the nose.)
    expect(long).toBeLessThan(Math.max(short, 0.5) * 4);
    expect(long).toBeLessThan(20);
  });

  it('steps at 0.2 s', () => {
    expect(new CueTimeline().step).toBe(0.2);
  });
});

describe('transitionsIn', () => {
  const kinds = (tl: CueTimeline, from: number, to: number): TransitionKind[] => {
    const out: TransitionKind[] = [];
    tl.transitionsIn(from, to, out);
    return out;
  };

  it('reports a seam to exactly one frame', () => {
    // The whole point: a flourish is a one-shot, so a cue seen by two
    // consecutive frames would fire it twice — and the second firing lands on
    // top of the first, which is a cut with a flourish label on it.
    const tl = new CueTimeline();
    tl.add({ t: 10, source: 'jev', transition: 'drop', impact: 1 });
    expect(kinds(tl, 9.98, 10)).toEqual(['drop']);
    expect(kinds(tl, 10, 10.02)).toEqual([]);
    expect(kinds(tl, 9.9, 10.1)).toEqual(['drop']);
  });

  it('reports every seam in a long frame, in order', () => {
    // A page the browser has throttled hands the renderer a tenth of a second
    // at a time, and a seam must not be lost because the frame that contained
    // it was long.
    const tl = new CueTimeline();
    tl.add({ t: 10, source: 'jev', transition: 'build_start' });
    tl.add({ t: 10.05, source: 'jev', transition: 'drop', impact: 1 });
    expect(kinds(tl, 9.99, 10.1)).toEqual(['build_start', 'drop']);
  });

  it('ignores the cues that are not seams, and an empty or backwards window', () => {
    const tl = new CueTimeline();
    tl.add({ t: 10, source: 'grid', beat: true });
    tl.add({ t: 10.5, source: 'jev', transition: 'scream_peak' });
    expect(kinds(tl, 9, 10.2)).toEqual([]);
    expect(kinds(tl, 11, 9)).toEqual([]);
    expect(kinds(tl, 10.5, 10.5)).toEqual([]);
  });

  it('appends rather than replacing, so the caller can reuse one array', () => {
    const tl = new CueTimeline();
    tl.add({ t: 10, source: 'jev', transition: 'drop' });
    const out: TransitionKind[] = ['none'];
    tl.transitionsIn(9, 11, out);
    expect(out).toEqual(['none', 'drop']);
  });
});

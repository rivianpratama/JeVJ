import { describe, expect, it } from 'vitest';
import { AnalysisPipeline } from '../../src/analysis/pipeline';
import { RhythmTracker } from '../../src/analysis/rhythm';
import { framesFrom, kickPad, mulberry32 } from '../helpers/synth';

/** 120 BPM: one beat every half second, four beats to the bar. */
const PERIOD = 0.5;
const BAR = 4 * PERIOD;
/** The rate the real loop ticks the tracker at. */
const FPS = 60;

/** Where a grid locked to `PERIOD` would say `t` sits inside its beat. */
function phaseAt(t: number): number {
  const p = (t / PERIOD) % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * The tracker as the analysis loop drives it: ticked every frame, told about
 * the onsets in `onsets` as their moment goes by.
 */
function run(
  onsets: Array<{ t: number; strength: number }>,
  seconds: number,
  meterEvidence = true,
): RhythmTracker {
  const tracker = new RhythmTracker();
  tracker.setMeterEvidence(meterEvidence);
  const sorted = [...onsets].sort((a, b) => a.t - b.t);
  let next = 0;

  for (let i = 0; i * (1 / FPS) <= seconds; i++) {
    const t = i / FPS;
    tracker.tick(phaseAt(t));
    while (next < sorted.length && sorted[next]!.t <= t) {
      const o = sorted[next]!;
      tracker.pushOnset(o.t, o.strength, phaseAt(o.t));
      next += 1;
    }
  }
  return tracker;
}

/** One onset on every beat for `beats` beats, `strength` from the beat index. */
function onBeats(beats: number, strength: (beat: number) => number = () => 1) {
  return Array.from({ length: beats }, (_, b) => ({ t: b * PERIOD, strength: strength(b) }));
}

describe('RhythmTracker syncopation', () => {
  it('is near zero when every onset lands on a beat', () => {
    const tracker = run(onBeats(24), 12);

    expect(tracker.syncopation()).toBeLessThan(0.15);
  });

  it('rises when half the onsets land between the beats', () => {
    const onsets = Array.from({ length: 24 }, (_, b) => ({
      t: b * PERIOD + (b % 2 === 1 ? PERIOD / 2 : 0),
      strength: 1,
    }));
    const tracker = run(onsets, 12);

    expect(tracker.syncopation()).toBeGreaterThan(0.4);
  });
});

describe('RhythmTracker regularity', () => {
  it('is near one for isochronous onsets', () => {
    const tracker = run(onBeats(24), 12);

    expect(tracker.regularity()).toBeGreaterThan(0.9);
  });

  it('collapses when the intervals wander by a third', () => {
    const rand = mulberry32(0xbeef);
    const onsets: Array<{ t: number; strength: number }> = [];
    let t = 0;
    while (t < 12) {
      onsets.push({ t, strength: 1 });
      t += PERIOD * (1 + 0.3 * (rand() * 2 - 1));
    }
    const tracker = run(onsets, 12);

    expect(tracker.regularity()).toBeLessThan(0.6);
  });

  it('has no opinion before it has heard a few onsets', () => {
    expect(new RhythmTracker().regularity()).toBe(0);
    expect(new RhythmTracker().syncopation()).toBe(0);
  });
});

describe('RhythmTracker meter', () => {
  it('counts in three when the accent comes every third beat', () => {
    const tracker = run(
      onBeats(36, (b) => (b % 3 === 0 ? 3 : 1)),
      18,
    );

    expect(tracker.meter()).toBe('triple');
  });

  it('counts in four when the accent comes every fourth beat', () => {
    const tracker = run(
      onBeats(36, (b) => (b % 4 === 0 ? 3 : 1)),
      18,
    );

    expect(tracker.meter()).toBe('duple');
  });

  it('counts no meter at all while the beat it is handed is not the real one', () => {
    // The waltz of the test above, ticked against a beat the caller does not
    // believe in — a grid free-running before the tempo is measured.
    const tracker = run(
      onBeats(36, (b) => (b % 3 === 0 ? 3 : 1)),
      18,
      false,
    );

    expect(tracker.meter()).toBe('unclear');
    // The gate is on the meter alone; the groove is measured against times
    // and phases that are no worse for the beat being a guess.
    expect(tracker.regularity()).toBeGreaterThan(0.9);
    expect(tracker.onsetsPerSec(17.5)).toBeGreaterThan(1.8);
  });

  it('will not guess from flat onsets, or from none', () => {
    expect(run(onBeats(36), 18).meter()).toBe('unclear');
    expect(new RhythmTracker().meter()).toBe('unclear');
  });
});

describe('RhythmTracker meter hysteresis', () => {
  /**
   * Thirty-six beats of a plain every-four accent, and then, from beat 36, a
   * sudden and very loud every-three one. The raw hypothesis turns over at
   * beat 39; what the tracker *says* should not.
   */
  const flip = [
    ...onBeats(36, (b) => (b % 4 === 0 ? 3 : 1)),
    ...Array.from({ length: 24 }, (_, i) => ({
      t: (36 + i) * PERIOD,
      strength: i % 3 === 0 ? 20 : 1,
    })),
  ];

  it('keeps its answer while the new evidence is only two beats old', () => {
    expect(run(flip, 41 * PERIOD).meter()).toBe('duple');
  });

  it('changes it once the new evidence has survived four beats', () => {
    expect(run(flip, 45 * PERIOD).meter()).toBe('triple');
  });
});

describe('RhythmTracker density', () => {
  it('counts onsets per second over the recent past', () => {
    const tracker = run(onBeats(24), 12);

    // One onset every half second: two a second, give or take a window edge.
    expect(tracker.onsetsPerSec(11.5)).toBeGreaterThan(1.8);
    expect(tracker.onsetsPerSec(11.5)).toBeLessThan(2.4);
  });

  it('reports the density of the last two bars against eight bars ago', () => {
    // Bars 0-3 carry one onset a beat; from bar 4 on, two.
    const onsets: Array<{ t: number; strength: number }> = [];
    for (let beat = 0; beat * PERIOD < 24; beat++) {
      const t = beat * PERIOD;
      onsets.push({ t, strength: 1 });
      if (t >= 4 * BAR) onsets.push({ t: t + PERIOD / 2, strength: 1 });
    }
    const tracker = run(onsets, 24);

    expect(tracker.onsetRatio(20, BAR)).toBeGreaterThan(1.8);
    expect(tracker.onsetRatio(20, BAR)).toBeLessThan(2.4);
  });

  it('says nothing changed when there is no history to compare with', () => {
    expect(new RhythmTracker().onsetRatio(1, BAR)).toBe(1);
    expect(new RhythmTracker().onsetsPerSec(1)).toBe(0);
  });
});

/**
 * The unit tests above hand the tracker onsets that are already correct. This
 * one puts real audio through the whole chain, because the rows the HUD shows
 * are only as good as what the onset detector feeds them: a four-to-the-floor
 * kick over a sustained pad read `regular 0.00` while the tracker itself was
 * faultless — every kick was found, and so were fifty-five wobbles of the pad
 * in between them.
 *
 * `kickPad`, not `clickTrack`: the click track is bursts over silence, and a
 * detector that only ever meets that never has to tell an event from a sound
 * that is merely still going.
 */
describe('rhythm through the analysis pipeline', () => {
  const FS = 44100;
  /** 128 BPM: 0.469 s a beat, 16 beats in the 7.5 s the assertions cover. */
  const BPM = 128;
  const KICK_PERIOD = 60 / BPM;
  const COVERED_SEC = 16 * KICK_PERIOD;
  /** How far a detection may sit from a kick and still be that kick's. */
  const PAIRING_WINDOW = 0.12;

  function run(seconds: number) {
    const pipeline = new AnalysisPipeline();
    const onsets: number[] = [];
    let last = null as ReturnType<AnalysisPipeline['step']> | null;
    for (const f of framesFrom(kickPad(BPM, seconds, FS), FS)) {
      const snapshot = pipeline.step(f);
      if (snapshot.onset > 0) onsets.push(f.t);
      last = snapshot;
    }
    return { onsets, snapshot: last! };
  }

  it('reads a steady kick over a pad as regular and on the beat', () => {
    const { snapshot } = run(10);

    expect(snapshot.rhythm.regular).toBeGreaterThanOrEqual(0.8);
    expect(snapshot.rhythm.sync).toBeLessThanOrEqual(0.2);
  });

  it('finds the kick on nearly every beat of the first sixteen', () => {
    const { onsets } = run(10);
    const used = new Set<number>();
    let found = 0;

    for (let beat = 0; beat < 16; beat++) {
      const at = beat * KICK_PERIOD;
      const hit = onsets.findIndex((t, i) => !used.has(i) && Math.abs(t - at) <= PAIRING_WINDOW);
      if (hit < 0) continue;
      used.add(hit);
      found += 1;
    }

    expect(found).toBeGreaterThanOrEqual(12);
    // And not many more than the beats themselves: an onset on every pad
    // wobble is what made `regular` read zero.
    expect(onsets.filter((t) => t <= COVERED_SEC).length).toBeLessThanOrEqual(20);
  });
});

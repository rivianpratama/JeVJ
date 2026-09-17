import { describe, expect, it } from 'vitest';
import { createCueReader } from '../../src/app/cueReader';
import { CueTimeline } from '../../src/timeline/timeline';

describe('createCueReader', () => {
  it('reads the timeline as far ahead as the analysis runs behind', () => {
    const tl = new CueTimeline();
    tl.add({ t: 10, source: 'detector', impact: 1 });
    const reader = createCueReader(tl, () => 0.05);

    // The frame the hit was measured on is stamped 10; the listener heard it
    // at 9.95, so that is the audio time the visuals must fire at.
    expect(reader.at(9.95).impact).toBeCloseTo(1, 6);
    expect(reader.at(10).impact).toBeLessThan(1);
    expect(reader.readTime(9.95)).toBeCloseTo(10, 6);
  });

  it('lists what is coming from the compensated instant', () => {
    const tl = new CueTimeline();
    for (let t = 10; t <= 20; t += 1) tl.add({ t, source: 'grid', beat: true });
    const reader = createCueReader(tl, () => 0.5);

    // At audio time 9.6 the analysis clock reads 10.1, so the beat stamped 10
    // has already been heard and the next one due is 11.
    expect(reader.upcoming(9.6, 2).map((c) => c.t)).toEqual([11, 12]);
  });

  it('asks for the latency every read, because the trim slider moves', () => {
    const tl = new CueTimeline();
    tl.add({ t: 10, source: 'detector', impact: 1 });
    let latency = 0;
    const reader = createCueReader(tl, () => latency);

    expect(reader.at(9.8).impact).toBe(0);
    latency = 0.2;
    expect(reader.at(9.8).impact).toBeCloseTo(1, 6);
  });
});

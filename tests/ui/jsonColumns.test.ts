import { describe, expect, it } from 'vitest';
import {
  columnOffset,
  entryEnds,
  stamp,
  type ColumnEntry,
} from '../../src/ui/jsonColumns';
import { splitLog } from '../../src/app/columnsLink';
import type { AnalysisLogEntry } from '../../src/shared/types';

/** A column of `n` entries, alternating the two kinds at the given times. */
function entries(spec: [number, ColumnEntry['kind']][]): ColumnEntry[] {
  return spec.map(([t, kind], i) => ({ index: i + 1, t, kind, json: '{}' }));
}

describe('columnOffset', () => {
  const H = 4000;
  const V = 900;

  it('starts and ends entirely off screen, whichever way it travels', () => {
    // The whole point of the travel being content + viewport: at t = 0 nothing
    // has arrived and at t = duration nothing is left.
    expect(columnOffset(0, 200, H, V, 'up')).toBe(V);
    expect(columnOffset(200, 200, H, V, 'up')).toBe(-H);
    expect(columnOffset(0, 200, H, V, 'down')).toBe(-H);
    expect(columnOffset(200, 200, H, V, 'down')).toBe(V);
  });

  it('is linear in the track position, so a seek is a jump and a pause holds', () => {
    const half = columnOffset(100, 200, H, V, 'up');
    expect(half).toBeCloseTo(V - (H + V) / 2, 9);
    // Half of the travel covered at half the track, exactly: there is no state
    // here, so asking twice at the same instant gives the same answer.
    expect(columnOffset(100, 200, H, V, 'up')).toBe(half);
    for (let i = 1; i <= 10; i++) {
      const a = columnOffset((i - 1) * 20, 200, H, V, 'up');
      const b = columnOffset(i * 20, 200, H, V, 'up');
      expect(b).toBeLessThan(a);
    }
  });

  it('travels the two columns in opposite directions', () => {
    // Left is bottom → top, right is top → bottom, so one falls as the other
    // rises and the pair reads as a single mechanism rather than two lists.
    for (const t of [10, 50, 120, 199]) {
      const up = columnOffset(t, 200, H, V, 'up');
      const down = columnOffset(t, 200, H, V, 'down');
      expect(up).toBeLessThan(columnOffset(t - 5, 200, H, V, 'up'));
      expect(down).toBeGreaterThan(columnOffset(t - 5, 200, H, V, 'down'));
    }
  });

  it('clamps outside the track rather than running off into nothing', () => {
    expect(columnOffset(-10, 200, H, V, 'up')).toBe(columnOffset(0, 200, H, V, 'up'));
    expect(columnOffset(1e6, 200, H, V, 'up')).toBe(columnOffset(200, 200, H, V, 'up'));
  });

  it('parks at the start when the track has no duration yet', () => {
    // The element has not said how long it is. Dividing by that is a NaN
    // transform, which is a column that does not render at all.
    expect(columnOffset(5, 0, H, V, 'up')).toBe(V);
    expect(columnOffset(5, Number.NaN, H, V, 'down')).toBe(-H);
    expect(columnOffset(Number.NaN, 200, H, V, 'up')).toBe(V);
  });

  it('is off screen at both ends for an empty column too', () => {
    expect(columnOffset(0, 200, 0, V, 'up')).toBe(V);
    expect(columnOffset(200, 200, 0, V, 'up')).toBe(0);
  });
});

describe('entryEnds', () => {
  it('runs each entry to the next one of its own kind', () => {
    // The column is every segment and then every transition, so the list is not
    // monotone in t: the first transition is earlier than the last segment.
    const e = entries([
      [0, 'segment'],
      [30, 'segment'],
      [60, 'segment'],
      [12, 'transition'],
      [44, 'transition'],
    ]);
    expect(entryEnds(e, 90)).toEqual([30, 60, 90, 44, 90]);
  });

  it('gives at most one live entry of each kind at any instant', () => {
    const e = entries([
      [0, 'segment'],
      [30, 'segment'],
      [12, 'transition'],
      [44, 'transition'],
    ]);
    const ends = entryEnds(e, 90);
    for (const t of [0, 5, 12, 29, 30, 43, 44, 89]) {
      const live = e.filter((x, i) => t >= x.t && t < ends[i]!);
      expect(live.length).toBeLessThanOrEqual(2);
      expect(new Set(live.map((x) => x.kind)).size).toBe(live.length);
    }
  });

  it('ends the last of each kind at the end of the track', () => {
    const e = entries([
      [10, 'segment'],
      [20, 'transition'],
    ]);
    expect(entryEnds(e, 300)).toEqual([300, 300]);
  });

  it('has nothing to say about an empty column', () => {
    expect(entryEnds([], 120)).toEqual([]);
  });
});

describe('stamp', () => {
  it('is minutes and padded seconds', () => {
    expect(stamp(0)).toBe('0:00');
    expect(stamp(9.9)).toBe('0:09');
    expect(stamp(92)).toBe('1:32');
    expect(stamp(124)).toBe('2:04');
    expect(stamp(-5)).toBe('0:00');
  });
});

describe('splitLog', () => {
  const log: AnalysisLogEntry[] = [
    { t: 0, dir: 'req', json: '{"pos":"0:00"}' },
    { t: 0, dir: 'res', json: '{"arousal":0.3}' },
    { t: 30, dir: 'req', json: '{"pos":"0:30"}' },
    { t: 30, dir: 'res', json: '{"arousal":0.7}' },
    { t: 12, dir: 'req', json: '{"at":12}' },
    { t: 12, dir: 'res', json: '{"kind":"drop"}' },
  ];

  it('puts the questions on the left and the answers on the right, in order', () => {
    const { left, right } = splitLog(log, 2);
    expect(left.map((e) => e.t)).toEqual([0, 30, 12]);
    expect(right.map((e) => e.t)).toEqual([0, 30, 12]);
    expect(left.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it('calls the first `segments` of each column a segment and the rest transitions', () => {
    const { left, right } = splitLog(log, 2);
    expect(left.map((e) => e.kind)).toEqual(['segment', 'segment', 'transition']);
    expect(right.map((e) => e.kind)).toEqual(['segment', 'segment', 'transition']);
  });

  it('pretty-prints the bodies and survives one that is not JSON', () => {
    const { left } = splitLog([{ t: 0, dir: 'req', json: '{"a":1,"b":2}' }], 1);
    expect(left[0]!.json).toBe('{\n  "a": 1,\n  "b": 2\n}');
    const broken = splitLog([{ t: 0, dir: 'res', json: 'not json at all' }], 0);
    expect(broken.right[0]!.json).toBe('not json at all');
  });

  it('has two empty columns for a track nothing was asked about', () => {
    expect(splitLog([], 0)).toEqual({ left: [], right: [] });
  });
});

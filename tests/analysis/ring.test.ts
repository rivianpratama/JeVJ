import { describe, expect, it } from 'vitest';
import { Ring } from '../../src/analysis/ring';

describe('Ring', () => {
  it('keeps only the most recent `capacity` values, oldest first', () => {
    const r = new Ring(3);
    for (const v of [1, 2, 3, 4, 5]) r.push(v);

    expect(Array.from(r.toArray())).toEqual([3, 4, 5]);
    expect(r.mean()).toBe(4);
    expect(r.length).toBe(3);
  });

  it('indexes from the oldest value and reports the newest via last()', () => {
    const r = new Ring(3);
    for (const v of [1, 2, 3, 4, 5]) r.push(v);

    expect(r.at(0)).toBe(3);
    expect(r.at(1)).toBe(4);
    expect(r.at(2)).toBe(5);
    expect(r.last()).toBe(5);
  });

  it('grows up to capacity before wrapping', () => {
    const r = new Ring(4);
    r.push(10);
    r.push(20);

    expect(r.length).toBe(2);
    expect(Array.from(r.toArray())).toEqual([10, 20]);
    expect(r.mean()).toBe(15);
    expect(r.min()).toBe(10);
    expect(r.max()).toBe(20);
  });

  it('reports min and max over the retained window only', () => {
    const r = new Ring(3);
    for (const v of [100, -5, 1, 2, 3]) r.push(v);

    expect(r.min()).toBe(1);
    expect(r.max()).toBe(3);
  });

  it('answers 0 for every aggregate while empty', () => {
    const r = new Ring(3);

    expect(r.length).toBe(0);
    expect(r.mean()).toBe(0);
    expect(r.min()).toBe(0);
    expect(r.max()).toBe(0);
    expect(r.last()).toBe(0);
    expect(r.toArray().length).toBe(0);
  });

  it('rejects an out-of-range index', () => {
    const r = new Ring(3);
    r.push(1);

    expect(() => r.at(1)).toThrow(RangeError);
    expect(() => r.at(-1)).toThrow(RangeError);
  });

  it('rejects a capacity below 1', () => {
    expect(() => new Ring(0)).toThrow();
    expect(() => new Ring(2.5)).toThrow();
  });
});

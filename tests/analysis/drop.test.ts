import { describe, expect, it } from 'vitest';
import { DropDetector, type DropEvent } from '../../src/analysis/drop';
import type { FrameFeatures } from '../../src/shared/types';

/** The live hop: 735 samples at 44.1 kHz, the rate the analysis actually runs at. */
const HOP = 735 / 44100;

/** A frame carrying nothing but the loudness and the low-band weight the detector reads. */
function frame(t: number, db: number, low = 0.2): FrameFeatures {
  const bands = new Float32Array(8).fill(0.2);
  bands[0] = low;
  bands[1] = low;
  return {
    t,
    rms: 10 ** (db / 20),
    db,
    bands,
    bandsRaw: bands,
    centroid: 1200,
    flatness: 0.3,
    rolloff: 6000,
    flux: 0,
    zcr: 900,
    chroma: new Float32Array(12).fill(1 / 12),
    sub: 0.3,
  };
}

/** Frames from `from` to `to` seconds at the live hop, oldest first. */
function span(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to - 1e-9; t += HOP) out.push(t);
  return out;
}

describe('DropDetector', () => {
  it('hears the slam after a quiet bar', () => {
    const d = new DropDetector();
    for (const t of span(0, 1)) expect(d.push(frame(t, -30), 0)).toBeNull();

    const loud = span(1, 1.05);
    const events = loud.map((t) => d.push(frame(t, -12, 0.9), 1));
    const impacts = events.filter((e): e is DropEvent => e !== null);

    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.kind).toBe('impact');
    expect(impacts[0]!.strength).toBeGreaterThan(0.5);
    expect(impacts[0]!.strength).toBeLessThanOrEqual(1);
    // Within the first two loud frames.
    expect(events.indexOf(impacts[0]!)).toBeLessThanOrEqual(1);
  });

  it('does not fire twice inside the cooldown', () => {
    const d = new DropDetector();
    for (const t of span(0, 1)) d.push(frame(t, -30), 0);
    const first = span(1, 1.05).map((t) => d.push(frame(t, -12, 0.9), 1)).filter(Boolean);
    expect(first).toHaveLength(1);

    // Still loud, still onsetting, a third of a second later: nothing new.
    const later = span(1.05, 1.35).map((t) => d.push(frame(t, -12, 0.9), 1));
    expect(later.every((e) => e === null)).toBe(true);
  });

  it('needs the low end to call it an impact', () => {
    const d = new DropDetector();
    for (const t of span(0, 1)) d.push(frame(t, -30), 0);
    // Same jump, but the energy is all above the bass.
    const events = span(1, 1.3).map((t) => d.push(frame(t, -12, 0.1), 1));
    expect(events.every((e) => e === null || e.kind !== 'impact')).toBe(true);
  });

  it('needs an onset to call it an impact', () => {
    const d = new DropDetector();
    for (const t of span(0, 1)) d.push(frame(t, -30), 0);
    const events = span(1, 1.3).map((t) => d.push(frame(t, -12, 0.9), 0));
    expect(events.every((e) => e === null || e.kind !== 'impact')).toBe(true);
  });

  it('hears the hole in a loud passage', () => {
    const d = new DropDetector();
    for (const t of span(0, 4)) expect(d.push(frame(t, -8), 0)).toBeNull();

    const dip = span(4, 4.2).map((t) => d.push(frame(t, -40), 0));
    const gaps = dip.filter((e): e is DropEvent => e !== null);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe('gap');
    expect(gaps[0]!.strength).toBeGreaterThan(0.5);
    expect(gaps[0]!.t).toBeGreaterThanOrEqual(4);
  });

  it('says nothing about steady music', () => {
    const d = new DropDetector();
    const events = span(0, 6).map((t) => d.push(frame(t, -10, 0.6), t % 0.5 < HOP ? 1 : 0));
    expect(events.every((e) => e === null)).toBe(true);
  });

  it('takes its thresholds from the caller', () => {
    // A 6 dB jump is nothing to the default detector and everything to this one.
    const d = new DropDetector({ jumpDb: 3 });
    for (const t of span(0, 1)) d.push(frame(t, -30), 0);
    const events = span(1, 1.3).map((t) => d.push(frame(t, -24, 0.9), 1));
    expect(events.some((e) => e?.kind === 'impact')).toBe(true);
  });
});

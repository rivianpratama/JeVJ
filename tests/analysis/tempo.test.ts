import { describe, expect, it } from 'vitest';
import { OnsetDetector } from '../../src/analysis/onset';
import { estimateTempo, tempoMarking } from '../../src/analysis/tempo';
import { clickTrack, framesFrom } from '../helpers/synth';

const FS = 44100;

/** Six seconds of onset envelope taken off a click track at `bpm`. */
function envelopeAt(bpm: number, seconds = 10): Float32Array {
  const det = new OnsetDetector();
  let last = 0;
  for (const f of framesFrom(clickTrack(bpm, seconds, FS), FS)) {
    det.push(f);
    last = f.t;
  }
  return det.envelope(6, last);
}

describe('estimateTempo', () => {
  it('reads a 120 BPM click track as 120', () => {
    const e = estimateTempo(envelopeAt(120));

    expect(e.bpm).toBeGreaterThanOrEqual(118);
    expect(e.bpm).toBeLessThanOrEqual(122);
    expect(e.marking).toBe('allegro');
    expect(e.confidence).toBeGreaterThan(0.5);
    expect(e.period).toBeCloseTo(60 / e.bpm, 6);
  });

  it('reads a 90 BPM click track as 90', () => {
    const e = estimateTempo(envelopeAt(90));

    expect(e.bpm).toBeGreaterThanOrEqual(88);
    expect(e.bpm).toBeLessThanOrEqual(92);
    expect(e.marking).toBe('andante');
  });

  it('keeps a 170 BPM click track fast instead of halving it', () => {
    const e = estimateTempo(envelopeAt(170));

    expect(e.bpm).toBeGreaterThanOrEqual(166);
    expect(e.bpm).toBeLessThanOrEqual(174);
    expect(e.bpm).toBeGreaterThanOrEqual(160);
    expect(e.marking).toBe('vivace');
  });

  it('has no confidence in a flat envelope', () => {
    const flat = new Float32Array(600).fill(0.4);

    expect(estimateTempo(flat).confidence).toBeLessThan(0.2);
  });

  it('has no confidence in an empty one either', () => {
    const e = estimateTempo(new Float32Array(0));

    expect(e.confidence).toBe(0);
    expect(Number.isFinite(e.bpm)).toBe(true);
    expect(e.period).toBeGreaterThan(0);
  });

  it('stays inside the 60-200 BPM search range', () => {
    for (const bpm of [70, 100, 128, 150, 180]) {
      const e = estimateTempo(envelopeAt(bpm));
      expect(e.bpm).toBeGreaterThanOrEqual(60);
      expect(e.bpm).toBeLessThanOrEqual(200);
    }
  });
});

describe('tempoMarking', () => {
  it('names the traditional ranges', () => {
    expect(tempoMarking(50)).toBe('largo');
    expect(tempoMarking(66)).toBe('adagio');
    expect(tempoMarking(90)).toBe('andante');
    expect(tempoMarking(110)).toBe('moderato');
    expect(tempoMarking(120)).toBe('allegro');
    expect(tempoMarking(140)).toBe('allegro');
    expect(tempoMarking(160)).toBe('vivace');
    expect(tempoMarking(200)).toBe('presto');
  });
});

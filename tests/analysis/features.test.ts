import { describe, expect, it } from 'vitest';
import { fftMagnitudes } from '../../src/analysis/fft';
import { FeatureExtractor, bandIndexRanges, chromaFromMagnitudes } from '../../src/analysis/features';
import { BAND_EDGES_HZ } from '../../src/shared/types';

const FS = 44100;
const N = 4096;

function extractor(): FeatureExtractor {
  return new FeatureExtractor({ sampleRate: FS, fftSize: N });
}

function sine(freq: number, amp = 1, n = N, fs = FS): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
}

/** Deterministic noise, so a failure here is always reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(seed: number, n = N): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

function argmax(a: Float32Array): number {
  let best = 0;
  for (let i = 1; i < a.length; i++) if ((a[i] ?? 0) > (a[best] ?? 0)) best = i;
  return best;
}

describe('bandIndexRanges', () => {
  it('returns one ascending, non-empty bin range per band', () => {
    const ranges = bandIndexRanges(FS, N);

    expect(ranges.length).toBe(BAND_EDGES_HZ.length - 1);
    let previousEnd = 0;
    for (const range of ranges) {
      const [start, end] = range;
      expect(end).toBeGreaterThan(start);
      expect(start).toBeGreaterThanOrEqual(previousEnd === 0 ? 0 : previousEnd);
      expect(end).toBeLessThanOrEqual(N / 2);
      previousEnd = end;
    }
  });

  it('places 20-60 Hz and 60-130 Hz where 44.1 kHz / 4096 puts them', () => {
    const ranges = bandIndexRanges(FS, N);
    const hzPerBin = FS / N;

    const sub = ranges[0] as [number, number];
    expect((sub[0] ?? 0) * hzPerBin).toBeGreaterThanOrEqual(10);
    expect((sub[1] ?? 0) * hzPerBin).toBeLessThanOrEqual(70);

    const low = ranges[1] as [number, number];
    expect(low[0] * hzPerBin).toBeLessThanOrEqual(65);
    expect(low[1] * hzPerBin).toBeGreaterThanOrEqual(125);
  });

  it('clamps bands above Nyquist instead of running off the end', () => {
    const ranges = bandIndexRanges(8000, 512); // Nyquist 4 kHz: the top bands are gone
    for (const [start, end] of ranges) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(256);
      expect(end).toBeGreaterThan(start);
    }
  });
});

describe('chromaFromMagnitudes', () => {
  it('puts a 440 Hz sine on pitch class 9 (A)', () => {
    const chroma = chromaFromMagnitudes(fftMagnitudes(sine(440)), FS, N);

    expect(chroma.length).toBe(12);
    expect(chroma[9] ?? 0).toBeGreaterThanOrEqual(0.8);
    expect(argmax(chroma)).toBe(9);
  });

  it('sums to one for anything with energy, and to zero for silence', () => {
    const tone = chromaFromMagnitudes(fftMagnitudes(sine(261.63)), FS, N);
    let sum = 0;
    for (const v of tone) sum += v;
    expect(sum).toBeCloseTo(1, 5);

    const silent = chromaFromMagnitudes(new Float32Array(N / 2), FS, N);
    for (const v of silent) expect(v).toBe(0);
  });
});

describe('FeatureExtractor', () => {
  it('reads a 100 Hz sine as low-band energy with a low centroid', () => {
    const time = sine(100);
    const f = extractor().extract(fftMagnitudes(time), time, 0);

    expect(argmax(f.bandsRaw)).toBe(1); // 60-130 Hz dominates
    expect(f.centroid).toBeGreaterThan(80);
    expect(f.centroid).toBeLessThan(140);
    expect(f.sub).toBeLessThan(0.2); // little energy in 20-60 Hz
  });

  it('reads white noise as spectrally flat', () => {
    for (const seed of [1, 2, 3, 7]) {
      const time = noise(seed);
      const f = extractor().extract(fftMagnitudes(time), time, 0);

      expect(f.flatness).toBeGreaterThan(0.6);
      expect(f.flatness).toBeLessThanOrEqual(1);
    }
  });

  it('reads a pure tone as the opposite of flat', () => {
    const time = sine(1000);
    const f = extractor().extract(fftMagnitudes(time), time, 0);

    expect(f.flatness).toBeLessThan(0.01);
  });

  it('reads a full-scale sine as roughly 0.7 rms with or without the time frame', () => {
    const time = sine(1000);
    const mags = fftMagnitudes(time);

    const fromTime = extractor().extract(mags, time, 0);
    expect(fromTime.rms).toBeCloseTo(0.707, 2);
    expect(fromTime.db).toBeGreaterThan(-4);

    const fromMags = extractor().extract(mags, null, 0);
    expect(fromMags.rms).toBeGreaterThan(0.6);
    expect(fromMags.rms).toBeLessThan(0.8);
  });

  it('reads silence as no chroma and a floored -100 dB', () => {
    const f = extractor().extract(new Float32Array(N / 2), new Float32Array(N), 0);

    for (const v of f.chroma) expect(v).toBe(0);
    expect(f.db).toBeLessThanOrEqual(-99);
    expect(f.rms).toBe(0);
    expect(f.centroid).toBe(0);
    expect(f.sub).toBe(0);
  });

  it('reports no flux between two identical frames', () => {
    const mags = fftMagnitudes(sine(1000));
    const fx = extractor();

    fx.extract(mags, null, 0);
    const second = fx.extract(mags, null, 0.1);

    expect(second.flux).toBeCloseTo(0, 6);
  });

  it('reports flux when the spectrum jumps', () => {
    const fx = extractor();
    fx.extract(fftMagnitudes(new Float32Array(N)), null, 0);
    const hit = fx.extract(fftMagnitudes(sine(1000)), null, 0.1);

    expect(hit.flux).toBeGreaterThan(0);
  });

  it('adapts band levels to a constant tone within 60 frames', () => {
    const mags = fftMagnitudes(sine(100));
    const fx = extractor();

    let last = fx.extract(mags, null, 0);
    for (let i = 1; i < 60; i++) last = fx.extract(mags, null, i / 60);

    expect(last.bands[1] ?? 0).toBeGreaterThanOrEqual(0.8);
    expect(last.bands[1] ?? 0).toBeLessThanOrEqual(1);
  });

  it('does not let a band lit only by window leakage normalise to full level', () => {
    const mags = fftMagnitudes(sine(110)); // band 1 is 60-130 Hz; band 2 is 130-250
    const fx = extractor();

    let last = fx.extract(mags, null, 0);
    for (let i = 1; i < 60; i++) last = fx.extract(mags, null, i / 60);

    expect(last.bands[1] ?? 0).toBeGreaterThanOrEqual(0.8);
    expect(last.bands[2] ?? 1).toBeLessThanOrEqual(0.3);
  });

  it('counts zero crossings per second from the time frame', () => {
    const time = sine(100);
    const f = extractor().extract(fftMagnitudes(time), time, 0);

    expect(f.zcr).toBeGreaterThan(150);
    expect(f.zcr).toBeLessThan(250); // 100 Hz sine: two crossings per cycle

    const silent = extractor().extract(new Float32Array(N / 2), null, 0);
    expect(silent.zcr).toBe(0);
  });

  it('puts the 95% rolloff above the tone and below Nyquist', () => {
    const time = sine(1000);
    const f = extractor().extract(fftMagnitudes(time), time, 0);

    expect(f.rolloff).toBeGreaterThanOrEqual(900);
    expect(f.rolloff).toBeLessThan(FS / 2);
  });

  it('fills every field of FrameFeatures with finite numbers', () => {
    const time = noise(3);
    const f = extractor().extract(fftMagnitudes(time), time, 12.5);

    expect(f.t).toBe(12.5);
    expect(f.bands.length).toBe(8);
    expect(f.bandsRaw.length).toBe(8);
    expect(f.chroma.length).toBe(12);
    for (const v of [f.rms, f.db, f.centroid, f.flatness, f.rolloff, f.flux, f.zcr, f.sub]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    for (const v of f.bands) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('rejects a spectrum that is not fftSize/2 long', () => {
    expect(() => extractor().extract(new Float32Array(100), null, 0)).toThrow();
  });
});

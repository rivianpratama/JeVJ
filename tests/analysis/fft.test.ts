import { describe, expect, it } from 'vitest';
import { fftMagnitudes, hann } from '../../src/analysis/fft';

const FS = 44100;
const N = 4096;

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

function sine(freq: number, n: number, fs: number, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
}

function argmax(a: Float32Array): number {
  let best = 0;
  for (let i = 1; i < a.length; i++) if ((a[i] ?? 0) > (a[best] ?? 0)) best = i;
  return best;
}

describe('hann', () => {
  it('is a periodic window: zero at the first sample, one in the middle', () => {
    const w = hann(8);
    expect(w.length).toBe(8);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[4]).toBeCloseTo(1, 6);
    expect(w[2]).toBeCloseTo(0.5, 6);
    expect(w[6]).toBeCloseTo(0.5, 6);
  });

  it('has the textbook power gain of 3/8', () => {
    const w = hann(1024);
    let sum = 0;
    for (const v of w) sum += v * v;
    expect(sum / w.length).toBeCloseTo(0.375, 4);
  });
});

describe('fftMagnitudes', () => {
  it('puts a 1 kHz sine in the expected bin', () => {
    const mags = fftMagnitudes(sine(1000, N, FS));

    expect(mags.length).toBe(N / 2);
    expect(Math.round((1000 * N) / FS)).toBe(93);
    expect(Math.abs(argmax(mags) - 93)).toBeLessThanOrEqual(1); // 93 +/- 1
  });

  it('scales a full-scale sine to N/4 at the peak bin (Hann coherent gain)', () => {
    const mags = fftMagnitudes(sine(1000, N, FS));
    expect(mags[argmax(mags)] ?? 0).toBeGreaterThan((N / 4) * 0.9);
    expect(mags[argmax(mags)] ?? 0).toBeLessThan((N / 4) * 1.1);
  });

  it('returns finite magnitudes for white noise', () => {
    const rand = mulberry32(1);
    const frame = new Float32Array(N);
    for (let i = 0; i < N; i++) frame[i] = rand() * 2 - 1;

    const mags = fftMagnitudes(frame);
    expect(mags.length).toBe(N / 2);
    for (const m of mags) {
      expect(Number.isFinite(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns all zeros for silence', () => {
    const mags = fftMagnitudes(new Float32Array(N));
    for (const m of mags) expect(m).toBe(0);
  });

  it('resolves two tones into two peaks', () => {
    const frame = new Float32Array(N);
    const a = sine(1000, N, FS, 1);
    const b = sine(5000, N, FS, 0.5);
    for (let i = 0; i < N; i++) frame[i] = (a[i] ?? 0) + (b[i] ?? 0);

    const mags = fftMagnitudes(frame);
    const binA = Math.round((1000 * N) / FS);
    const binB = Math.round((5000 * N) / FS);
    expect(mags[binA] ?? 0).toBeGreaterThan(N / 8);
    expect(mags[binB] ?? 0).toBeGreaterThan(N / 16);
    expect(mags[binA] ?? 0).toBeGreaterThan(mags[binB] ?? 0);
  });

  it('rejects a frame whose length is not a power of two', () => {
    expect(() => fftMagnitudes(new Float32Array(1000))).toThrow();
  });
});

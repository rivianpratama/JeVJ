/**
 * A radix-2 FFT for the offline and test paths.
 *
 * Live playback never comes through here — `AnalyserNode` runs its own FFT in
 * native code. This exists so the analysis layer can be exercised in Node
 * (vitest) and so Task 8 can sweep a decoded buffer faster than real time.
 *
 * Magnitudes are left *unnormalized* (a plain |X_k|): everything downstream is
 * either scale-invariant or normalizes against its own recent peak, and the
 * one place that is not — rms from a spectrum — carries its own constant.
 * A full-scale sine therefore peaks near N/4 (amplitude N/2 halved between the
 * two conjugate images, times the Hann coherent gain of 0.5).
 */

interface Plan {
  /** cos/sin of 2*pi*k/n for k < n/2 — the forward twiddles. */
  cos: Float64Array;
  sin: Float64Array;
  /** rev[i] is i with its log2(n) bits reversed. */
  rev: Uint32Array;
  win: Float32Array;
  re: Float64Array;
  im: Float64Array;
}

/** One plan per transform size; frames of a given size arrive in their thousands. */
const plans = new Map<number, Plan>();

/**
 * Periodic (DFT-even) Hann window: `0.5 * (1 - cos(2*pi*i/n))`.
 *
 * Periodic rather than symmetric so the coherent gain is exactly 1/2 and the
 * power gain exactly 3/8, which is what the rms constant below assumes.
 */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * Hann-window `frame` and return the first N/2 linear magnitudes.
 *
 * `frame.length` must be a power of two of at least 2.
 */
export function fftMagnitudes(frame: Float32Array): Float32Array {
  const n = frame.length;
  const plan = planFor(n);
  const { cos, sin, rev, win, re, im } = plan;

  // Window and scatter into bit-reversed order in one pass, so the transform
  // below can run in place with no separate permutation step.
  for (let i = 0; i < n; i++) {
    re[rev[i]!] = frame[i]! * win[i]!;
    im[rev[i]!] = 0;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let base = 0; base < n; base += size) {
      for (let j = base, k = 0; j < base + half; j++, k += step) {
        const l = j + half;
        // (cos - i*sin) * (re[l] + i*im[l])
        const tre = re[l]! * cos[k]! + im[l]! * sin[k]!;
        const tim = im[l]! * cos[k]! - re[l]! * sin[k]!;
        re[l] = re[j]! - tre;
        im[l] = im[j]! - tim;
        re[j] = re[j]! + tre;
        im[j] = im[j]! + tim;
      }
    }
  }

  const mags = new Float32Array(n >> 1);
  for (let k = 0; k < mags.length; k++) {
    mags[k] = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
  }
  return mags;
}

function planFor(n: number): Plan {
  const cached = plans.get(n);
  if (cached) return cached;

  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
    throw new RangeError(`fft frame length must be a power of two >= 2, got ${n}`);
  }

  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }

  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }

  const plan: Plan = { cos, sin, rev, win: hann(n), re: new Float64Array(n), im: new Float64Array(n) };
  plans.set(n, plan);
  return plan;
}

/**
 * Synthetic audio for the analysis tests: a metronome the detectors can be
 * held against, and the frame pipeline the live graph runs, minus the browser.
 *
 * Pure by construction — no DOM, no Web Audio — so everything here runs under
 * vitest in Node exactly as `src/analysis/**` does.
 */

import { fftMagnitudes } from '../../src/analysis/fft';
import { FeatureExtractor } from '../../src/analysis/features';
import type { FrameFeatures } from '../../src/shared/types';

/** Length of the noise burst that stands in for a stick hit. */
const CLICK_SECONDS = 0.005;
/** How loud a plain beat is, leaving headroom for the accent and the thump. */
const CLICK_AMP = 0.5;
/** Every fourth beat is this much louder — the cue a downbeat detector wants. */
const ACCENT = 1.8;
/** The accent also gets a short 55 Hz thump, so bands 0-1 see the downbeat. */
const THUMP_HZ = 55;
const THUMP_SECONDS = 0.08;
/**
 * Quiet on purpose. A sine puts all its energy in three bins where a click
 * spreads it over two thousand, so even at this level the thump is the loudest
 * thing in the onset envelope by a factor of six — enough for a downbeat
 * detector, little enough that the beat is still the strongest period.
 */
const THUMP_AMP = 0.05;
const BEATS_PER_BAR = 4;

/**
 * Where `t` sits inside its analysis window, as a fraction of the window.
 *
 * Not the obvious 0.5. A Hann-windowed transient contributes almost nothing
 * while it sits at the edge of the window and reaches full weight at the
 * centre, so spectral flux — which reacts to the *rise* — peaks about a
 * quarter of a window after the hit enters. Placing `t` three quarters of the
 * way through the window cancels that bias, and frame times then line up with
 * the audio events that caused them instead of trailing them by ~30 ms. The
 * live path has the same bias (its window ends at `now`, so it runs late) and
 * compensates for it with the HUD's latency trim.
 */
const T_IN_WINDOW = 0.75;

/**
 * `seconds` of metronome at `bpm`: a 5 ms decaying noise burst on every beat,
 * with every fourth beat louder and thicker in the bass.
 *
 * The first beat is at t = 0, and — as on a real metronome — every beat is the
 * *same* click, scaled. Rolling fresh noise per beat sounds more natural but
 * gives each beat its own spectrum, and the resulting 30% wobble in onset
 * strength is enough for an autocorrelation to mistake some other period for
 * the beat. A fixture should test the detector, not the fixture's dice.
 */
export function clickTrack(bpm: number, seconds: number, sr = 44100): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  const period = (60 / bpm) * sr;
  const burst = Math.round(CLICK_SECONDS * sr);
  const thump = Math.round(THUMP_SECONDS * sr);
  const rand = mulberry32(0x5eed1234);

  // One click, struck over and over. Exponential decay: attack, no sustain.
  const click = new Float32Array(burst);
  for (let i = 0; i < burst; i++) click[i] = (rand() * 2 - 1) * Math.exp((-4 * i) / burst);

  for (let beat = 0; beat * period < out.length; beat++) {
    const start = Math.round(beat * period);
    const downbeat = beat % BEATS_PER_BAR === 0;
    const amp = downbeat ? CLICK_AMP * ACCENT : CLICK_AMP;

    for (let i = 0; i < burst; i++) {
      const at = start + i;
      if (at >= out.length) break;
      out[at] = out[at]! + click[i]! * amp;
    }

    if (!downbeat) continue;
    for (let i = 0; i < thump; i++) {
      const at = start + i;
      if (at >= out.length) break;
      const env = Math.exp((-4 * i) / thump);
      out[at] = out[at]! + THUMP_AMP * env * Math.sin((2 * Math.PI * THUMP_HZ * i) / sr);
    }
  }
  return out;
}

/**
 * `signal` through the same extractor the live graph feeds: one frame every
 * `hop` samples, `t = frameIndex * hop / sr`.
 *
 * The default hop is 735 samples — 60 frames a second at 44.1 kHz, which is
 * what `requestAnimationFrame` gives the real loop. Samples outside the signal
 * read as silence, so every beat gets a full set of frames.
 */
export function framesFrom(signal: Float32Array, sr: number, fftSize = 4096, hop = 735): FrameFeatures[] {
  const extractor = new FeatureExtractor({ sampleRate: sr, fftSize });
  // The time-domain frame is handed over unwindowed: rms is a property of the
  // waveform, and `fftMagnitudes` applies its own Hann.
  return windowsFrom(signal, sr, fftSize, hop).map((w) => extractor.extract(w.mags, w.time, w.t));
}

/**
 * The same frames one step earlier: raw spectra and waveforms, exactly what
 * `AudioGraph.readFrame()` hands the live loop. Each frame owns its arrays.
 */
export function windowsFrom(
  signal: Float32Array,
  sr: number,
  fftSize = 4096,
  hop = 735,
): Array<{ mags: Float32Array; time: Float32Array; t: number }> {
  const lead = Math.round(fftSize * T_IN_WINDOW);
  const out: Array<{ mags: Float32Array; time: Float32Array; t: number }> = [];

  for (let i = 0; i * hop < signal.length; i++) {
    const start = i * hop - lead;
    const time = new Float32Array(fftSize);
    for (let j = 0; j < fftSize; j++) {
      const at = start + j;
      time[j] = at >= 0 && at < signal.length ? signal[at]! : 0;
    }
    out.push({ mags: fftMagnitudes(time).slice(), time, t: (i * hop) / sr });
  }
  return out;
}

/** Beat times of `clickTrack(bpm, seconds)` — what the detectors should find. */
export function beatTimes(bpm: number, seconds: number): number[] {
  const period = 60 / bpm;
  const out: number[] = [];
  for (let beat = 0; beat * period < seconds; beat++) out.push(beat * period);
  return out;
}

/** Small, fast, seeded PRNG: reproducible noise beats `Math.random` in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

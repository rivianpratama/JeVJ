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
const DEFAULT_BEATS_PER_BAR = 4;

/**
 * Where `t` sits inside its analysis window, as a fraction of the window.
 *
 * 1.0: the window *ends* at `t`. This is the live geometry and the only one
 * worth testing against — `AudioGraph.readFrame()` stamps a frame with
 * `ctx.currentTime`, and an `AnalyserNode` hands back the `fftSize` samples
 * that arrived before that moment. A fixture that centred its windows, or put
 * `t` three quarters of the way through, would cancel a latency the live
 * pipeline actually has and the tests would certify a timing the app never
 * achieves. The resulting lag is measured instead, and published as
 * `ONSET_REPORT_LAG_SEC`.
 */
const T_IN_WINDOW = 1;

/**
 * `seconds` of metronome at `bpm`: a 5 ms decaying noise burst on every beat,
 * with the first beat of every bar louder and thicker in the bass. Pass
 * `beatsPerBar = 3` for a waltz.
 *
 * The first beat is at t = 0, and — as on a real metronome — every beat is the
 * *same* click, scaled. Rolling fresh noise per beat sounds more natural but
 * gives each beat its own spectrum, and the resulting 30% wobble in onset
 * strength is enough for an autocorrelation to mistake some other period for
 * the beat. A fixture should test the detector, not the fixture's dice.
 */
export function clickTrack(
  bpm: number,
  seconds: number,
  sr = 44100,
  beatsPerBar = DEFAULT_BEATS_PER_BAR,
): Float32Array {
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
    const downbeat = beat % beatsPerBar === 0;
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

/** Partials in the sawtooth the pitched helpers use; amplitude 1/k. */
const SAW_PARTIALS = 8;
/** Peak the pitched helpers normalise to, leaving headroom like real audio. */
const TONE_PEAK = 0.5;
/** How long each note of `scaleTones` sounds. */
const NOTE_SECONDS = 0.25;
/**
 * A note that started or stopped mid-sample is a click, and a click is
 * broadband — it would smear energy across every pitch class the chroma cares
 * about. Five milliseconds of fade is inaudible and keeps the spectrum honest.
 */
const NOTE_FADE_SEC = 0.005;

/** How many sines `amNoise` stacks, and how far either side of the centre. */
const NOISE_PARTIALS = 48;
const NOISE_SPREAD = 0.25;

/**
 * `seconds` of a sustained chord: one sawtooth per frequency, partials 1..8 at
 * 1/k, summed and normalised so the loudest sample sits at 0.5.
 *
 * Sawtooth rather than sine because a key detector that only ever sees
 * fundamentals is not being tested: real instruments put a fifth and a third
 * into the chroma whether the music asked for them or not, and the tracker has
 * to survive that.
 */
export function chord(freqsHz: number[], seconds: number, sr = 44100): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (const f of freqsHz) addSaw(out, f, 0, out.length, sr);
  return normalisePeak(out, TONE_PEAK);
}

/**
 * The notes of `midiNotes` in turn, 0.25 s each, cycling until `seconds` is
 * full. Each note is the same sawtooth `chord` uses, faded in and out.
 *
 * Repeat a note in the list to weight it: a scale whose tonic appears twice is
 * how a bare scale tells a key detector which note is home.
 */
export function scaleTones(midiNotes: number[], seconds: number, sr = 44100): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  if (midiNotes.length === 0) return out;

  const span = Math.round(NOTE_SECONDS * sr);
  const fade = Math.round(NOTE_FADE_SEC * sr);

  for (let slot = 0; slot * span < out.length; slot++) {
    const note = midiNotes[slot % midiNotes.length]!;
    const hz = 440 * Math.pow(2, (note - 69) / 12);
    const start = slot * span;
    const end = Math.min(start + span, out.length);

    const voice = new Float32Array(end - start);
    addSaw(voice, hz, 0, voice.length, sr);
    normalisePeak(voice, TONE_PEAK);
    for (let i = 0; i < voice.length; i++) {
      const rise = fade > 0 ? Math.min(1, i / fade) : 1;
      const fall = fade > 0 ? Math.min(1, (voice.length - 1 - i) / fade) : 1;
      out[start + i] = voice[i]! * Math.min(rise, fall);
    }
  }
  return out;
}

/**
 * Band-limited noise around `centerHz`, amplitude-modulated at `rateHz` by
 * `0.5 + 0.5·sin(2π·rate·t)` — the syllabic envelope speech has and music
 * mostly does not.
 *
 * The "noise" is 48 sines scattered over ±25% of the centre with random
 * phases: cheap, deterministic, and it puts the spectral centroid exactly
 * where the caller asked for it, which a filtered white source would not.
 */
export function amNoise(rateHz: number, seconds: number, sr = 44100, centerHz = 2000): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const rand = mulberry32(0x0a11ce55);

  const freqs = new Float64Array(NOISE_PARTIALS);
  const phases = new Float64Array(NOISE_PARTIALS);
  for (let k = 0; k < NOISE_PARTIALS; k++) {
    freqs[k] = centerHz * (1 + NOISE_SPREAD * (rand() * 2 - 1));
    phases[k] = rand() * 2 * Math.PI;
  }

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (let k = 0; k < NOISE_PARTIALS; k++) v += Math.sin(2 * Math.PI * freqs[k]! * t + phases[k]!);
    out[i] = v * (0.5 + 0.5 * Math.sin(2 * Math.PI * rateHz * t));
  }
  return normalisePeak(out, TONE_PEAK);
}

/** One sawtooth voice added into `out[from..to)`. Partials past Nyquist are dropped. */
function addSaw(out: Float32Array, hz: number, from: number, to: number, sr: number): void {
  for (let k = 1; k <= SAW_PARTIALS; k++) {
    const f = hz * k;
    if (f >= sr / 2) break;
    const w = (2 * Math.PI * f) / sr;
    for (let i = from; i < to; i++) out[i] = out[i]! + Math.sin(w * i) / k;
  }
}

/** Scales `buf` in place so its loudest sample is `peak`. Silence stays silent. */
function normalisePeak(buf: Float32Array, peak: number): Float32Array {
  let loudest = 0;
  for (let i = 0; i < buf.length; i++) loudest = Math.max(loudest, Math.abs(buf[i]!));
  if (loudest > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i]! / loudest) * peak;
  return buf;
}

/** The signals end to end, in order — one longer take made of several. */
export function concatSignals(...parts: Float32Array[]): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
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

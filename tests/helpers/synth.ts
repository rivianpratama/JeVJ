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

/** The kick's resting pitch, and where its sweep starts. */
const KICK_HZ = 55;
const KICK_SWEEP_HZ = 175;
/** How long the sweep from `KICK_SWEEP_HZ` down to `KICK_HZ` takes. */
const KICK_SWEEP_SEC = 0.03;
/** How long a kick rings before it is inaudible. */
const KICK_SECONDS = 0.25;
/** Peak of one kick, leaving headroom for the pad underneath it. */
const KICK_AMP = 0.9;
/**
 * Peak of the pad, well below the kick's. A drop detector asks whether the
 * low end carries the frame, and a pad loud enough to rival the kick would
 * make every frame look like a kick; a pad this quiet is a bed the kick
 * stands on, which is what a mix sounds like.
 */
const PAD_AMP = 0.12;
/** A minor triad low enough to share the kick's octave without masking it. */
const PAD_CHORD_HZ = [110, 130.81, 164.81];

/**
 * `seconds` of four-to-the-floor at `bpm`: a swept 55 Hz kick on every beat
 * over a sustained minor-triad pad.
 *
 * `clickTrack` is a metronome — broadband bursts over silence, the friendliest
 * signal a detector will ever see. This is the other half of the job: the thing
 * the detectors actually meet. Two properties matter and neither is in the
 * click track.
 *
 * The pad never stops, so spectral flux never returns to zero between hits and
 * the relative threshold an onset has to clear is being held up by a sound that
 * is not an event. A kick that reads as an onset here is one that would read as
 * an onset over a real track.
 *
 * The kick sweeps rather than sitting at 55 Hz, because a bare 55 Hz sine is
 * three bins wide and rises over a whole cycle — 18 ms, more than a frame. The
 * sweep puts the attack up at 175 Hz where the analysis has resolution, which
 * is what makes a kick's transient a transient rather than a swell.
 *
 * As in `clickTrack`, the first kick is at t = 0 and every kick is the *same*
 * kick: nothing here varies beat to beat, so a test that fails failed on the
 * detector.
 */
export function kickPad(bpm: number, seconds: number, sr = 44100): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (const hz of PAD_CHORD_HZ) addSaw(out, hz, 0, out.length, sr);
  normalisePeak(out, PAD_AMP);

  // One kick, struck over and over. The sweep is integrated rather than
  // evaluated: sin(2π·f(t)·t) with a moving f is not a chirp, it is a
  // discontinuity at every sample where f changed.
  const span = Math.min(Math.round(KICK_SECONDS * sr), out.length);
  const kick = new Float32Array(span);
  let phase = 0;
  for (let i = 0; i < span; i++) {
    const at = i / sr;
    const hz =
      at < KICK_SWEEP_SEC ? KICK_SWEEP_HZ + (KICK_HZ - KICK_SWEEP_HZ) * (at / KICK_SWEEP_SEC) : KICK_HZ;
    kick[i] = KICK_AMP * Math.exp((-5 * i) / span) * Math.sin(phase);
    phase += (2 * Math.PI * hz) / sr;
  }

  const period = (60 / bpm) * sr;
  for (let beat = 0; beat * period < out.length; beat++) {
    const start = Math.round(beat * period);
    for (let i = 0; i < span; i++) {
      const at = start + i;
      if (at >= out.length) break;
      out[at] = out[at]! + kick[i]!;
    }
  }
  return out;
}

/** The hat's burst: how long it rings, how loud, and the band it lives in. */
const HAT_SECONDS = 0.04;
/**
 * Peak of one hat, against the kick's 0.9.
 *
 * Loud for a hi-hat, and deliberately so: the point of this fixture is that a
 * hat *is* an event, so it must not be arguable that the detector missed it
 * because it was inaudible. Even at this level the hat moves the wideband flux
 * about a third as much as the kick does, because a kick is a huge amount of
 * energy in a handful of bins and a hat is a modest amount spread over
 * hundreds.
 */
const HAT_AMP = 0.4;
/**
 * The band the hat's noise sits in. Above `CHROMA_MIN_HZ` and below the 8 kHz
 * where `FeatureExtractor.flux` stops looking, so the hat is inside the
 * measurement rather than an argument about its edges.
 */
const HAT_LO_HZ = 3000;
const HAT_HI_HZ = 8000;
/** How many sines the hat's noise is made of — see `amNoise` for the trick. */
const HAT_PARTIALS = 40;

/**
 * `kickPad` with a hi-hat on every off-beat: four-to-the-floor with the
 * eighth-note that makes it a groove rather than a pulse.
 *
 * `kickPad` is a beat and nothing else, and a detector tested only against it
 * is never asked the question this fixture asks: can it hear a hit that is not
 * the kick? Everything a rhythm reading is made of depends on that answer.
 * Syncopation is the share of onset energy away from the beat, and on a signal
 * whose only detected events are kicks it is 0 by construction however busy
 * the music is; regularity is the spread of the intervals between onsets, and
 * with the hats in it is measuring a 0.234 s pulse rather than a 0.469 s one.
 *
 * The hat is a decaying burst of forty sines scattered over 3-8 kHz with fixed
 * random phases — deterministic, and it puts the energy where a hi-hat puts it
 * without a filter. As everywhere else here, every hat is the *same* hat.
 */
export function edmLoop(bpm: number, seconds: number, sr = 44100): Float32Array {
  const out = kickPad(bpm, seconds, sr);
  const span = Math.round(HAT_SECONDS * sr);
  const rand = mulberry32(0x0ffbea7);

  const hat = new Float32Array(span);
  for (let k = 0; k < HAT_PARTIALS; k++) {
    const hz = HAT_LO_HZ + (HAT_HI_HZ - HAT_LO_HZ) * rand();
    const phase = rand() * 2 * Math.PI;
    for (let i = 0; i < span; i++) hat[i] = hat[i]! + Math.sin((2 * Math.PI * hz * i) / sr + phase);
  }
  normalisePeak(hat, HAT_AMP);
  for (let i = 0; i < span; i++) hat[i] = hat[i]! * Math.exp((-5 * i) / span);

  const period = (60 / bpm) * sr;
  for (let beat = 0; (beat + 0.5) * period < out.length; beat++) {
    const start = Math.round((beat + 0.5) * period);
    for (let i = 0; i < span; i++) {
      const at = start + i;
      if (at >= out.length) break;
      out[at] = out[at]! + hat[i]!;
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

/** A phrase of `speechLike`, the breath after it, and how far down the breath is. */
const PHRASE_SEC = 1.6;
const BREATH_SEC = 0.45;
const BREATH_GAIN = 0.02;

/**
 * `amNoise` cut into phrases with a breath between them — what a person
 * talking actually looks like to an envelope follower.
 *
 * `amNoise` alone is a *sustained* syllabic modulation, and that turns out to
 * be the wrong fixture for a speech detector: its envelope never stops, and a
 * talking human's does. Measured on four minutes of a real TED talk, roughly a
 * fifth of every four seconds sits more than 15 dB below the median — the
 * breaths between phrases — and on a minute each of house, metal, trap and an
 * ambient pad that share is exactly zero. A detector calibrated against
 * `amNoise` cannot use the one cue that separates them, which is why the first
 * one built here reported 0.35 on a talk and 0.29 on Slipknot.
 *
 * So: `PHRASE_SEC` of syllables, `BREATH_SEC` at `BREATH_GAIN` (-34 dB, a room
 * rather than a digital silence), repeated. Everything else is `amNoise`.
 */
export function speechLike(
  rateHz: number,
  seconds: number,
  sr = 44100,
  centerHz = 2000,
): Float32Array {
  const out = amNoise(rateHz, seconds, sr, centerHz);
  const phrase = Math.round(PHRASE_SEC * sr);
  const breath = Math.round(BREATH_SEC * sr);
  const cycle = phrase + breath;

  for (let i = 0; i < out.length; i++) {
    if (i % cycle >= phrase) out[i] = out[i]! * BREATH_GAIN;
  }
  return out;
}

/** How many harmonics a sung vowel carries, as the brief specifies. */
const VOWEL_PARTIALS = 12;
/** The two formants a mid vowel sits on, and how wide each resonance is. */
const FORMANT_1_HZ = 700;
const FORMANT_2_HZ = 1200;
const FORMANT_BANDWIDTH_HZ = 140;
/** How much each formant lifts the partials inside it, over the 1/k baseline. */
const FORMANT_GAIN = 9;
/** A singer's vibrato: five a second, half a percent either way. */
const VIBRATO_HZ = 5;
const VIBRATO_DEPTH = 0.005;

/**
 * `seconds` of a sung vowel on `f0Hz`: twelve harmonics at 1/k, lifted where
 * they fall inside a formant, with a slight vibrato.
 *
 * This is the signal the `vocal` feature exists to find, and every part of it
 * is one of the three things that make a voice measurable. The harmonic series
 * is what a pitch salience measures — twelve partials of one fundamental, so
 * the harmonic sum at f0 collects nearly all of the energy and the sum at any
 * other candidate collects almost none. The formants are what tells a voice
 * from a violin: a resonance is a property of the *throat*, so it stays at
 * 700 and 1200 Hz whatever the sung pitch, and the share of energy in the
 * 1-3 kHz formant band is high however low the note. And the vibrato is what
 * keeps the partials from reading as a synthesizer — a bare harmonic stack
 * with no pitch movement is an organ.
 *
 * Deterministic, like everything else here: no dice, so a failure is the
 * detector's.
 */
export function sungVowel(f0Hz: number, seconds: number, sr = 44100): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);

  // The vibrato is integrated rather than evaluated: sin(2π·f(t)·t) with a
  // moving f is a discontinuity at every sample where f changed, not a warble.
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = f0Hz * (1 + VIBRATO_DEPTH * Math.sin(2 * Math.PI * VIBRATO_HZ * t));
    let v = 0;
    for (let k = 1; k <= VOWEL_PARTIALS; k++) {
      const hz = f0 * k;
      if (hz >= sr / 2) break;
      v += (formantGain(hz) / k) * Math.sin(k * phase);
    }
    out[i] = v;
    phase += (2 * Math.PI * f0) / sr;
  }
  return normalisePeak(out, TONE_PEAK);
}

/** How much the two formants lift a partial at `hz`. */
function formantGain(hz: number): number {
  return 1 + FORMANT_GAIN * (resonance(hz, FORMANT_1_HZ) + resonance(hz, FORMANT_2_HZ));
}

/** A one-pole resonance: 1 at the centre, falling away over its bandwidth. */
function resonance(hz: number, centerHz: number): number {
  const d = (hz - centerHz) / FORMANT_BANDWIDTH_HZ;
  return 1 / (1 + d * d);
}

/** How long one burst of `noiseBurstTrain` lasts, and how loud it is. */
const BURST_SECONDS = 0.02;
const BURST_PEAK = 0.95;
/** How sharply a burst decays over its own length. */
const BURST_DECAY = 6;

/**
 * `seconds` of bright noise bursts at `rateHz`: 20 ms of high-passed noise,
 * struck over and over, close to full scale.
 *
 * The other end of the timbre axis from `sungVowel`, and what `harsh` is
 * measured against: no pitch at all (flat spectrum, so the harmonic sum finds
 * nothing to sum), a centroid up where a cymbal or a scream lives, transients
 * sharp enough that the attack reads `sharp`, and loud. A distorted scream is
 * this plus a voice; for the feature under test, this is the worst case.
 *
 * The noise is differenced white noise — a one-zero high pass, which tilts the
 * spectrum up 6 dB an octave — and, as everywhere here, every burst is the
 * *same* burst.
 */
export function noiseBurstTrain(rateHz: number, seconds: number, sr = 44100): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  const span = Math.max(1, Math.round(BURST_SECONDS * sr));
  const rand = mulberry32(0xb1a55e7);

  const burst = new Float32Array(span);
  let prev = 0;
  for (let i = 0; i < span; i++) {
    const white = rand() * 2 - 1;
    burst[i] = (white - prev) * Math.exp((-BURST_DECAY * i) / span);
    prev = white;
  }
  normalisePeak(burst, BURST_PEAK);

  if (!(rateHz > 0)) return out;
  const period = sr / rateHz;
  for (let hit = 0; hit * period < out.length; hit++) {
    const start = Math.round(hit * period);
    for (let i = 0; i < span; i++) {
      const at = start + i;
      if (at >= out.length) break;
      out[at] = out[at]! + burst[i]!;
    }
  }
  return out;
}

/** The tempo the song fixture runs at: 120 BPM puts a bar on every 2 s. */
const SONG_BPM = 120;
/** The section boundaries, in seconds. Each is a whole number of bars. */
const SONG_BUILD_START = 12;
const SONG_DROP = 24;
const SONG_BREAKDOWN = 40;
const SONG_SCREAM = 48;
const SONG_QUIET = 52;
const SONG_END = 60;
/** How long the hole before the slam is. */
const SONG_GAP_SEC = 0.4;
/**
 * The pad's chord: a minor triad an octave above the kick.
 *
 * Low on purpose. A sawtooth triad up at 220 Hz puts enough of its partials in
 * the 1-3 kHz formant band to read as a voice, which is a true thing about the
 * sound and a distracting one in a fixture whose vocal crossings are supposed
 * to come from the scream.
 */
const SONG_PAD_HZ = [110, 130.81, 164.81];

export interface SongFixture {
  signal: Float32Array;
  /** What the analysis is supposed to find, in seconds. */
  truth: { drop: number; breakdownStart: number; screamStart: number; quietStart: number };
}

/**
 * Sixty seconds of music with a shape: intro, build, slam, drop, breakdown,
 * scream, outro.
 *
 * Every fixture above this one tests a detector against the one thing it
 * measures. This one tests the *pass*: a track long enough to be segmented,
 * with four moments in it a listener would name, and the names written down in
 * `truth` so a candidate finder or a transition writer can be held against
 * them rather than against a hand-picked list of timestamps.
 *
 * The moments are what the four transition kinds are made of. The drop is a
 * 0.4 s hole and then everything at once, which is what both the gap branch
 * and the impact branch of the drop detector exist for. The breakdown takes
 * the kit away and leaves the pad, so the loudness falls without the music
 * stopping. The scream is `noiseBurstTrain` over a kick — loud, bright,
 * transient, no pitch — and the outro is the pad again, quiet.
 *
 * 120 BPM throughout, so every boundary lands on a downbeat and a two-bar
 * anticipation ramp is exactly four seconds. A tempo change would be a fifth
 * thing to find and is not what this fixture is for.
 */
export function songFixture(sr = 44100): SongFixture {
  const out = new Float32Array(Math.round(SONG_END * sr));
  const at = (sec: number): number => Math.round(sec * sr);

  // The pad runs under everything except the hole and the drop's own slam,
  // which is what keeps a section boundary a change of energy rather than a
  // change of whether there is any music at all.
  addPad(out, at(0), at(SONG_BREAKDOWN) - Math.round(SONG_GAP_SEC * sr), sr, 0.1);
  addPad(out, at(SONG_BREAKDOWN), at(SONG_SCREAM), sr, 0.16);
  addPad(out, at(SONG_QUIET), at(SONG_END), sr, 0.16);

  // Intro: a soft kick on every downbeat only.
  addKicks(out, at(0), at(SONG_BUILD_START), sr, 0.35, 4);

  // Build: a kick on every beat, hats doubling from eighths to sixteenths, and
  // the whole thing rising. The hole is cut at the end, so the slam arrives
  // out of silence.
  const buildEnd = at(SONG_DROP) - Math.round(SONG_GAP_SEC * sr);
  addKicks(out, at(SONG_BUILD_START), buildEnd, sr, 0.3, 1);
  addHats(out, at(SONG_BUILD_START), at(18), sr, 0.25, 0.5);
  addHats(out, at(18), buildEnd, sr, 0.3, 0.25);
  ramp(out, at(SONG_BUILD_START), buildEnd, 0.45, 0.95);
  out.fill(0, buildEnd, at(SONG_DROP));

  // Drop: full kit, a second pad layer and a bass note on every beat — and
  // decisively louder than the end of the build, which is what makes the slam
  // a slam rather than the build continuing.
  addPad(out, at(SONG_DROP), at(SONG_BREAKDOWN), sr, 0.18);
  addKicks(out, at(SONG_DROP), at(SONG_BREAKDOWN), sr, 1.5, 1);
  addHats(out, at(SONG_DROP), at(SONG_BREAKDOWN), sr, 0.4, 0.5);
  addBass(out, at(SONG_DROP), at(SONG_BREAKDOWN), sr, 1.1);

  // Scream: bright noise bursts six to a beat over a kick, and no pad under
  // them — a scream is the loudest, brightest, most transient thing here.
  const scream = noiseBurstTrain(12, SONG_QUIET - SONG_SCREAM, sr);
  for (let i = 0; i < scream.length; i++) {
    const j = at(SONG_SCREAM) + i;
    if (j >= out.length) break;
    out[j] = out[j]! + scream[i]! * 1.3;
  }
  addKicks(out, at(SONG_SCREAM), at(SONG_QUIET), sr, 0.9, 1);

  // Outro: the pad alone, taken down to a whisper.
  ramp(out, at(SONG_QUIET), at(SONG_END), 0.35, 0.15);

  return {
    signal: out,
    truth: {
      drop: SONG_DROP,
      breakdownStart: SONG_BREAKDOWN,
      screamStart: SONG_SCREAM,
      quietStart: SONG_QUIET,
    },
  };
}

/** The sustained triad, at `amp`, added into `out[from..to)`. */
function addPad(out: Float32Array, from: number, to: number, sr: number, amp: number): void {
  const span = Math.max(0, Math.min(to, out.length) - from);
  if (span === 0) return;
  const voice = new Float32Array(span);
  for (const hz of SONG_PAD_HZ) addSaw(voice, hz, 0, span, sr);
  normalisePeak(voice, amp);
  for (let i = 0; i < span; i++) out[from + i] = out[from + i]! + voice[i]!;
}

/** The swept kick of `kickPad`, on every `everyBeats`-th beat of the section. */
function addKicks(
  out: Float32Array,
  from: number,
  to: number,
  sr: number,
  amp: number,
  everyBeats: number,
): void {
  const span = Math.round(0.25 * sr);
  const kick = new Float32Array(span);
  let phase = 0;
  for (let i = 0; i < span; i++) {
    const t = i / sr;
    const hz = t < KICK_SWEEP_SEC ? KICK_SWEEP_HZ + (KICK_HZ - KICK_SWEEP_HZ) * (t / KICK_SWEEP_SEC) : KICK_HZ;
    kick[i] = amp * Math.exp((-5 * i) / span) * Math.sin(phase);
    phase += (2 * Math.PI * hz) / sr;
  }

  const period = (60 / SONG_BPM) * sr * everyBeats;
  for (let beat = 0; from + beat * period < to; beat++) {
    const start = Math.round(from + beat * period);
    for (let i = 0; i < span; i++) {
      const j = start + i;
      if (j >= to || j >= out.length) break;
      out[j] = out[j]! + kick[i]!;
    }
  }
}

/** A hi-hat every `everyBeats` beats — 0.5 for eighths, 0.25 for sixteenths. */
function addHats(
  out: Float32Array,
  from: number,
  to: number,
  sr: number,
  amp: number,
  everyBeats: number,
): void {
  const span = Math.round(HAT_SECONDS * sr);
  const rand = mulberry32(0x5eed0a7);
  const hat = new Float32Array(span);
  for (let k = 0; k < HAT_PARTIALS; k++) {
    const hz = HAT_LO_HZ + (HAT_HI_HZ - HAT_LO_HZ) * rand();
    const phase = rand() * 2 * Math.PI;
    for (let i = 0; i < span; i++) hat[i] = hat[i]! + Math.sin((2 * Math.PI * hz * i) / sr + phase);
  }
  normalisePeak(hat, amp);
  for (let i = 0; i < span; i++) hat[i] = hat[i]! * Math.exp((-5 * i) / span);

  const period = (60 / SONG_BPM) * sr * everyBeats;
  for (let hit = 0; from + hit * period < to; hit++) {
    const start = Math.round(from + hit * period);
    for (let i = 0; i < span; i++) {
      const j = start + i;
      if (j >= to || j >= out.length) break;
      out[j] = out[j]! + hat[i]!;
    }
  }
}

/** A decaying two-octave bass note on every beat: the weight a drop lands with. */
function addBass(out: Float32Array, from: number, to: number, sr: number, amp: number): void {
  const period = (60 / SONG_BPM) * sr;
  const span = Math.round(0.4 * sr);
  for (let beat = 0; from + beat * period < to; beat++) {
    const start = Math.round(from + beat * period);
    for (let i = 0; i < span; i++) {
      const j = start + i;
      if (j >= to || j >= out.length) break;
      const env = Math.exp((-3 * i) / span);
      const phase = (2 * Math.PI * i) / sr;
      out[j] = out[j]! + amp * env * (Math.sin(55 * phase) + 0.6 * Math.sin(110 * phase));
    }
  }
}

/** Scales `out[from..to)` by a gain sliding linearly from `a` to `b`. */
function ramp(out: Float32Array, from: number, to: number, a: number, b: number): void {
  const end = Math.min(to, out.length);
  const span = Math.max(1, end - from);
  for (let i = from; i < end; i++) out[i] = out[i]! * (a + (b - a) * ((i - from) / span));
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

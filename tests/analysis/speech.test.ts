import { describe, expect, it } from 'vitest';
import { AnalysisPipeline } from '../../src/analysis/pipeline';
import { beatTrust, pauseRatio, pitchVariation, SpeechDetector } from '../../src/analysis/speech';
import { amNoise, clickTrack, edmLoop, framesFrom, speechLike } from '../helpers/synth';

const FS = 44100;

/** Every frame of `signal` through a fresh detector. */
function listen(signal: Float32Array): SpeechDetector {
  const detector = new SpeechDetector();
  for (const f of framesFrom(signal, FS)) detector.push(f.rms, f.t, f);
  return detector;
}

describe('SpeechDetector', () => {
  it('scores syllables with breaths between them as speech', () => {
    // 4 Hz syllables in 1.6 s phrases, centroid ~2 kHz, no beat to speak of.
    const score = listen(speechLike(4, 8, FS, 2000)).score(0.1);

    expect(score).toBeGreaterThan(0.55);
  });

  /**
   * The gate, stated as a test. A sustained syllabic modulation is what the
   * detector used to be calibrated against and it is not what a person talking
   * sounds like: measured over five real tracks, an envelope with no holes in
   * it is music every time. So `amNoise` — the same signal as above without the
   * breaths — is allowed to look speech-like and is not allowed to be called
   * speech, and the whole difference between the two lines is the pauses.
   */
  it('does not call a sustained syllabic modulation speech, for want of pauses', () => {
    const detector = listen(amNoise(4, 8, FS, 2000));

    expect(detector.pause()).toBe(0);
    expect(detector.score(0.1)).toBeLessThan(0.35);
  });

  it('does not mistake a confident metronome for speech', () => {
    const score = listen(clickTrack(120, 8, FS)).score(0.9, 2, 0.9);

    expect(score).toBeLessThan(0.3);
  });

  it('stays inside 0..1 whatever it is told', () => {
    const detector = listen(speechLike(4, 8, FS, 2000));

    expect(detector.score(0)).toBeLessThanOrEqual(1);
    expect(detector.score(1)).toBeGreaterThanOrEqual(0);
  });

  it('has nothing to say before it has heard anything', () => {
    expect(new SpeechDetector().score(0.5)).toBe(0);
    expect(new SpeechDetector().pause()).toBe(0);
    expect(new SpeechDetector().pitchVar()).toBe(0);
  });
});

/**
 * Two signals apart, one number.
 *
 * A beat at 128 BPM modulates the loudness envelope at 2.13 Hz, and a pulse
 * train's second, third and fourth harmonics land at 4.3, 6.4 and 8.5 Hz —
 * inside the band this detector calls syllabic. That is not a near miss: it is
 * the same measurement answering yes to a drum machine. The beat grid already
 * knows the period, so the detector is told it and stops counting the music's
 * own pulse as speech.
 */
describe('SpeechDetector against a beat it has been told about', () => {
  /** `a` and `b` summed sample for sample, in `a`'s length. */
  function mix(a: Float32Array, b: Float32Array, gain: number): Float32Array {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i] ?? 0) * gain;
    return out;
  }

  it('does not hear an instrumental EDM loop as talking', () => {
    const pipeline = new AnalysisPipeline();
    const scores: number[] = [];
    for (const f of framesFrom(edmLoop(128, 20, FS), FS)) {
      const snapshot = pipeline.step(f);
      if (f.t >= 8) scores.push(snapshot.speech);
    }

    expect(scores.length).toBeGreaterThan(0);
    expect(Math.max(...scores)).toBeLessThanOrEqual(0.25);
  });

  it('still hears speech over a beat it is only half sure of', () => {
    // Syllables and breaths with a quiet 120 BPM pulse under them: a voice
    // over music, which is the case the notch must not throw away.
    const voice = mix(speechLike(4, 8, FS, 2000), clickTrack(120, 8, FS), 0.2);

    expect(listen(voice).score(0.3, 2, 0.5)).toBeGreaterThanOrEqual(0.45);
  });

  it('is unchanged when it is told nothing about the beat', () => {
    const detector = listen(speechLike(4, 8, FS, 2000));

    expect(detector.score(0.1)).toBeGreaterThan(0.55);
    expect(detector.score(0.1, 2)).toBeGreaterThan(0.55);
  });

  /**
   * The finding that made `beatTrust` exist. A TED talk's grid reports
   * confidence 1.00 from about thirty seconds in, against a regularity of
   * 0.00: an autocorrelation can find a period in syllables, and nothing is
   * landing on it. A grid that confident used to take the whole "no beat" cue
   * away and 70% of the modulation cue with it.
   */
  it('discounts a confident grid that nothing regular is landing on', () => {
    const detector = listen(speechLike(4, 8, FS, 2000));
    const overGroove = detector.score(1, 2, 0.9);
    const overSyllables = detector.score(1, 2, 0);

    expect(overSyllables).toBeGreaterThan(overGroove);
    expect(overSyllables).toBeGreaterThan(0.55);
  });
});

describe('beatTrust', () => {
  it('is nothing without confidence, whatever the regularity', () => {
    expect(beatTrust(0, 1)).toBe(0);
    expect(beatTrust(0, 0)).toBe(0);
  });

  it('leaves a confident grid over an irregular rhythm a fifth of its weight', () => {
    expect(beatTrust(1, 0)).toBeCloseTo(0.2, 6);
    expect(beatTrust(1, 1)).toBeCloseTo(1, 6);
    expect(beatTrust(1, 0.5)).toBeCloseTo(0.6, 6);
  });

  it('clamps both arguments rather than extrapolating', () => {
    expect(beatTrust(2, 2)).toBeCloseTo(1, 6);
    expect(beatTrust(-1, -1)).toBe(0);
  });
});

describe('pauseRatio', () => {
  const RATE = 50;

  /** `seconds` of a level at `db`, on the 50 Hz grid the detector uses. */
  function level(db: number, seconds: number): number[] {
    return new Array(Math.round(seconds * RATE)).fill(db);
  }

  it('finds nothing in a sustained level', () => {
    expect(pauseRatio(level(-20, 4), RATE)).toBe(0);
  });

  it('counts a single 0.3 s hole as most of what a speaker is worth', () => {
    // Four seconds hold thirteen whole windows, so one hole is 0.077 — the
    // bottom of what a real talk measures, and `PAUSE_FULL` is 0.10.
    const envelope = [...level(-40, 0.3), ...level(-20, 3.7)];

    expect(pauseRatio(envelope, RATE)).toBeCloseTo(0.77, 2);
  });

  it('saturates on two, which is an ordinary speaking rate', () => {
    const envelope = [...level(-40, 0.6), ...level(-20, 3.4)];

    expect(pauseRatio(envelope, RATE)).toBe(1);
  });

  it('ignores a dip that is not deep enough to be a breath', () => {
    // 10 dB down is a quiet syllable; a pause is 15.
    const envelope = [...level(-20, 3.7), ...level(-30, 0.3)];

    expect(pauseRatio(envelope, RATE)).toBe(0);
  });

  it('measures against the median, so a passage of holes still finds them', () => {
    // Four phrases of 0.6 s with a 0.4 s breath after each: the mean is
    // dragged down by the breaths and the median is not.
    const envelope: number[] = [];
    for (let i = 0; i < 4; i++) envelope.push(...level(-20, 0.6), ...level(-45, 0.4));

    expect(pauseRatio(envelope, RATE)).toBe(1);
  });

  it('has nothing to say about less than two windows of envelope', () => {
    expect(pauseRatio(level(-20, 0.2), RATE)).toBe(0);
    expect(pauseRatio([], RATE)).toBe(0);
    expect(pauseRatio(level(-20, 4), 0)).toBe(0);
  });
});

describe('pitchVariation', () => {
  it('reads a held note as still', () => {
    expect(pitchVariation(new Array(50).fill(220))).toBeCloseTo(0, 9);
  });

  it('grows with the spread, and saturates past the spread of a speaker', () => {
    // A ramp's standard deviation is its range over root twelve, so an octave
    // is 3.46 semitones — just under the four that count as full marks — and
    // two octaves is nearly seven, which is past them.
    const slide = (octaves: number): number[] =>
      Array.from({ length: 50 }, (_, i) => 110 * Math.pow(2, (octaves * i) / 49));

    expect(pitchVariation(slide(1))).toBeCloseTo(0.88, 2);
    expect(pitchVariation(slide(2))).toBe(1);
  });

  it('is measured in semitones, so register does not change the answer', () => {
    const low = Array.from({ length: 50 }, (_, i) => 100 * Math.pow(2, i / 200));
    const high = low.map((f) => f * 4);

    expect(pitchVariation(high)).toBeCloseTo(pitchVariation(low), 6);
  });

  it('leaves unpitched frames out rather than counting them as a low note', () => {
    const held = new Array(50).fill(220);

    expect(pitchVariation([...held, ...new Array(50).fill(0)])).toBeCloseTo(0, 9);
  });

  it('has nothing to say about too few pitched frames', () => {
    expect(pitchVariation([110, 220, 440])).toBe(0);
    expect(pitchVariation([])).toBe(0);
  });
});

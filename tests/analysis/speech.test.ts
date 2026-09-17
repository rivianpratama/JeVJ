import { describe, expect, it } from 'vitest';
import { AnalysisPipeline } from '../../src/analysis/pipeline';
import { SpeechDetector } from '../../src/analysis/speech';
import { amNoise, clickTrack, edmLoop, framesFrom } from '../helpers/synth';

const FS = 44100;

/** Every frame of `signal` through a fresh detector. */
function listen(signal: Float32Array): SpeechDetector {
  const detector = new SpeechDetector();
  for (const f of framesFrom(signal, FS)) detector.push(f.rms, f.t, f);
  return detector;
}

describe('SpeechDetector', () => {
  it('scores a syllable-rate envelope over a mid-band as speech', () => {
    // 4 Hz amplitude modulation, centroid ~2 kHz, and no beat to speak of.
    const score = listen(amNoise(4, 8, FS, 2000)).score(0.1);

    expect(score).toBeGreaterThan(0.55);
  });

  it('does not mistake a confident metronome for speech', () => {
    const score = listen(clickTrack(120, 8, FS)).score(0.9);

    expect(score).toBeLessThan(0.3);
  });

  it('stays inside 0..1 whatever it is told', () => {
    const detector = listen(amNoise(4, 8, FS, 2000));

    expect(detector.score(0)).toBeLessThanOrEqual(1);
    expect(detector.score(1)).toBeGreaterThanOrEqual(0);
  });

  it('has nothing to say before it has heard anything', () => {
    expect(new SpeechDetector().score(0.5)).toBeGreaterThanOrEqual(0);
    expect(new SpeechDetector().score(0.5)).toBeLessThanOrEqual(1);
  });
});

/**
 * Two signals apart, one number.
 *
 * A beat at 128 BPM modulates the loudness envelope at 2.13 Hz, and a pulse
 * train's second, third and fourth harmonics land at 4.3, 6.4 and 8.5 Hz —
 * two of them inside the 3-6 Hz band this detector calls syllabic. That is not
 * a near miss: it is the same measurement answering yes to a drum machine. The
 * beat grid already knows the period, so the detector is told it and stops
 * counting the music's own pulse as speech.
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
    // Syllables at 4 Hz with a quiet 120 BPM pulse under them: a voice over
    // music, which is the case the notch must not throw away.
    const voice = mix(amNoise(4, 8, FS, 2000), clickTrack(120, 8, FS), 0.2);

    expect(listen(voice).score(0.3, 2)).toBeGreaterThanOrEqual(0.45);
  });

  it('is unchanged when it is told nothing about the beat', () => {
    const detector = listen(amNoise(4, 8, FS, 2000));

    expect(detector.score(0.1)).toBeGreaterThan(0.55);
    expect(detector.score(0.1, 2)).toBeGreaterThan(0.55);
  });
});

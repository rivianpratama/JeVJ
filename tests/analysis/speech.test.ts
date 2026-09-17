import { describe, expect, it } from 'vitest';
import { SpeechDetector } from '../../src/analysis/speech';
import { amNoise, clickTrack, framesFrom } from '../helpers/synth';

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

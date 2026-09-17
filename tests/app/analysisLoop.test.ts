import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisLoop } from '../../src/app/analysisLoop';
import { BeatGrid } from '../../src/analysis/grid';
import { FeatureExtractor } from '../../src/analysis/features';
import { magnitudesFromDecibels } from '../../src/source/audioGraph';
import type { AudioGraph } from '../../src/source/audioGraph';
import { clickTrack, edmLoop, windowsFrom } from '../helpers/synth';

/** A metronome that accents every third beat. */
function waltz(bpm: number, seconds: number, sr: number): Float32Array {
  return clickTrack(bpm, seconds, sr, 3);
}

const FS = 44100;
const FFT = 4096;

/** An `AudioGraph` that plays a pre-rendered signal, one frame per read. */
function fakeGraph(signal: Float32Array): AudioGraph {
  const frames = windowsFrom(signal, FS, FFT);
  let i = 0;
  return {
    ctx: { sampleRate: FS } as AudioContext,
    analyser: { fftSize: FFT } as AnalyserNode,
    connectSource: () => {},
    disconnectSource: () => {},
    readFrame: () => frames[Math.min(i++, frames.length - 1)]!,
  };
}

/**
 * The same signal as the *live* graph delivers it.
 *
 * `AnalyserNode` divides its spectrum by `fftSize` before reporting decibels;
 * `fftMagnitudes` normalizes by nothing. So this takes the test fixture's
 * magnitudes the whole way down that path and back up through the conversion
 * `AudioGraph.readFrame` actually uses, which is the only way a Node test can
 * hold the live scale to the offline one.
 *
 * Not clamped to `minDecibels`/`maxDecibels`: those bound `getByteFrequencyData`,
 * which quantizes into a 0-255 byte range that has to be bounded somehow.
 * `getFloatFrequencyData` — what `AudioGraph` actually calls — hands back the
 * unclamped decibel value, so clamping here would be modelling a limit the
 * real float path does not have.
 */
function analyserGraph(signal: Float32Array): AudioGraph {
  const frames = windowsFrom(signal, FS, FFT).map((w) => {
    const db = new Float32Array(w.mags.length);
    for (let i = 0; i < w.mags.length; i++) {
      db[i] = 20 * Math.log10(Math.max(w.mags[i]! / FFT, 1e-12));
    }
    const mags = new Float32Array(db.length);
    magnitudesFromDecibels(db, mags);
    return { mags, time: w.time, t: w.t };
  });
  let i = 0;
  return {
    ctx: { sampleRate: FS } as AudioContext,
    analyser: { fftSize: FFT } as AnalyserNode,
    connectSource: () => {},
    disconnectSource: () => {},
    readFrame: () => frames[Math.min(i++, frames.length - 1)]!,
  };
}

/** Nothing here waits on the display, but `start` schedules against it. */
beforeEach(() => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  // The loop also asks the page whether it is visible, so that it can step off
  // a timer instead of off frames when it is not.
  globalThis.document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  Reflect.deleteProperty(globalThis, 'document');
});

describe('AnalysisLoop', () => {
  it('has nothing to report before it has run', () => {
    expect(new AnalysisLoop().latest()).toBeNull();
  });

  it('finds the tempo and phase of a click track', () => {
    const loop = new AnalysisLoop();
    const signal = clickTrack(120, 12, FS);
    loop.start(fakeGraph(signal));
    for (let i = 0; i < Math.floor((12 * FS) / 735); i++) loop.step();

    const snap = loop.latest();
    expect(snap).not.toBeNull();
    expect(snap!.tempo?.bpm).toBeGreaterThanOrEqual(118);
    expect(snap!.tempo?.bpm).toBeLessThanOrEqual(122);
    expect(snap!.grid.bpm).toBe(snap!.tempo?.bpm);
    expect(snap!.grid.confidence).toBeGreaterThan(0.5);
    expect(snap!.phase).toBeGreaterThanOrEqual(0);
    expect(snap!.phase).toBeLessThan(1);
    // Beats keep coming, and the grid stays near the real ones.
    expect(snap!.grid.beatIndex).toBeGreaterThan(8);
    const offset = Math.abs(snap!.grid.nextBeat % 0.5);
    expect(Math.min(offset, 0.5 - offset)).toBeLessThan(0.05);
  });

  it('measures no tempo before it has a window of audio to measure', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 12, FS)));
    for (let i = 0; i < 60; i++) loop.step(); // one second

    expect(loop.latest()!.tempo).toBeNull();
    expect(loop.latest()!.grid.confidence).toBe(0);
  });

  it('reports onsets as they pass', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 8, FS)));
    let onsets = 0;
    for (let i = 0; i < Math.floor((8 * FS) / 735); i++) {
      loop.step();
      if (loop.latest()!.onset > 0) onsets += 1;
    }

    expect(onsets).toBeGreaterThanOrEqual(14);
    expect(onsets).toBeLessThanOrEqual(18);
  });

  it('keeps quiet, and keeps its grid, when the audio is silent', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(new Float32Array(8 * FS)));
    for (let i = 0; i < Math.floor((8 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(snap.onset).toBe(0);
    expect(snap.tempo?.confidence).toBe(0);
    expect(snap.grid.confidence).toBe(0); // never anchored to noise
    expect(snap.beats).toHaveLength(0);
  });

  it('carries every tracker in its snapshot', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 12, FS)));
    for (let i = 0; i < Math.floor((12 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(['duple', 'triple', 'unclear']).toContain(snap.rhythm.meter);
    expect(snap.rhythm.regular).toBeGreaterThan(0.5); // a metronome, after all
    expect(snap.rhythm.sync).toBeLessThan(0.3);
    expect(snap.rhythm.onsetsPerSec).toBeGreaterThan(1);
    expect(snap.timbre.attack).toBe('sharp');
    expect(snap.timbre.consonance).toBeGreaterThanOrEqual(0);
    expect(snap.timbre.consonance).toBeLessThanOrEqual(1);
    expect(snap.dynamics.trend).toBe('steady');
    // A bare metronome is silence with clicks in it, so it genuinely reports
    // a hole in every beat. Only the type is worth asserting here; what a gap
    // is gets decided in the dynamics tests, on music-shaped loudness.
    expect(typeof snap.dynamics.gap).toBe('boolean');
    expect(snap.speech).toBeLessThan(0.5);
    expect(snap.key.tonic).toBeGreaterThanOrEqual(-1);
  });

  it('carries the last drop it heard, and nothing before one', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 12, FS)));
    loop.step();
    expect(loop.latest()!.drop).toBeNull();

    const kinds = new Set<string>();
    let lastAt = -1;
    for (let i = 0; i < Math.floor((12 * FS) / 735); i++) {
      loop.step();
      const d = loop.latest()!.drop;
      if (d && d.t !== lastAt) {
        lastAt = d.t;
        kinds.add(d.kind);
        expect(d.strength).toBeGreaterThan(0);
        expect(d.t).toBeLessThanOrEqual(loop.latest()!.features.t);
      }
    }

    // A bare metronome is silence with 5 ms of noise in it, so what it
    // reports is the hole rather than the slam — the clicks carry too little
    // of the low end to pass for a drop. What matters here is that the events
    // reach the snapshot and stay in it; which events a click track earns is
    // settled against synthetic loudness in the detector's own tests.
    expect([...kinds]).toEqual(['gap']);
    expect(loop.latest()!.drop).not.toBeNull();
  });

  it('hears no drop in silence', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(new Float32Array(8 * FS)));
    for (let i = 0; i < Math.floor((8 * FS) / 735); i++) loop.step();
    expect(loop.latest()!.drop).toBeNull();
  });

  it('has nothing to say about a key it has not heard', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(new Float32Array(4 * FS)));
    for (let i = 0; i < Math.floor((4 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(snap.key.key).toBe('?');
    expect(snap.key.mode).toBe('unclear');
    expect(snap.rhythm.meter).toBe('unclear');
    expect(snap.dynamics.slope4).toBe(0);
  });

  it('hands the meter it hears to the grid, and counts in three for it', () => {
    const loop = new AnalysisLoop();
    // A waltz: a strong beat then two weak ones, at 90 BPM.
    const signal = waltz(90, 20, FS);
    loop.start(fakeGraph(signal));
    for (let i = 0; i < Math.floor((20 * FS) / 735); i++) loop.step();

    const snap = loop.latest()!;
    expect(snap.rhythm.meter).toBe('triple');
    expect(snap.grid.barLength).toBe(3);
  });

  it('does not churn the grid over a steady four-four click track', () => {
    // Every reading the loop forwards costs the grid its downbeat evidence, so
    // a meter that flickers costs it repeatedly. Un-debounced this track drew
    // two calls in twenty seconds — a spurious triple and the retraction of it
    // — and the spurious one left the grid counting in three.
    const spy = vi.spyOn(BeatGrid.prototype, 'setMeter');
    try {
      const loop = new AnalysisLoop();
      loop.start(fakeGraph(clickTrack(120, 20, FS)));
      const lengths = new Set<number>();
      for (let i = 0; i < Math.floor((20 * FS) / 735); i++) {
        loop.step();
        // Before the first tempo estimate the phase is fiction and no meter
        // evidence is counted at all; from there on the bar stays four.
        if (loop.latest()!.tempo !== null) lengths.add(loop.latest()!.grid.barLength);
      }

      // A 4 → 4 call is a no-op inside the grid, so one is tolerated.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      expect([...lengths]).toEqual([4]);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The HUD's `fps` row.
   *
   * `requestAnimationFrame` does not run at 60 Hz in a tab the browser has
   * backgrounded, or in a pane the desktop app has hidden: measured in Chrome
   * against a hidden pane it fired 1.3 times a second. The pipeline is honest
   * about this — every frame carries the audio clock, so a skipped frame is
   * simply audio nobody looked at — but the *reader* is then looking at 93 ms
   * of every 770, and no amount of correctness downstream recovers a tempo
   * from that. So the rate is measured and printed, and a beat confidence of
   * 0.2 next to `fps 1` explains itself.
   */
  describe('step rate', () => {
    it('counts the steps of the last second', () => {
      let now = 0;
      const loop = new AnalysisLoop({ now: () => now });
      loop.start(fakeGraph(clickTrack(120, 4, FS)));

      expect(loop.stepsPerSec()).toBe(0);

      for (let i = 0; i < 60; i++) {
        now = i * (1000 / 60);
        loop.step();
      }
      expect(loop.stepsPerSec()).toBe(60);

      // A second of nothing — a hidden tab — and the row says so.
      now += 1000;
      expect(loop.stepsPerSec()).toBe(0);
    });

    it('forgets the steps that have scrolled out of the window', () => {
      let now = 0;
      const loop = new AnalysisLoop({ now: () => now });
      loop.start(fakeGraph(clickTrack(120, 8, FS)));

      for (let i = 0; i < 300; i++) {
        now = i * (1000 / 60);
        loop.step();
      }
      // Five seconds of stepping, one second of it counted.
      expect(loop.stepsPerSec()).toBeGreaterThanOrEqual(58);
      expect(loop.stepsPerSec()).toBeLessThanOrEqual(61);
    });

    it('counts a throttled loop as the handful of steps it is', () => {
      let now = 0;
      const loop = new AnalysisLoop({ now: () => now });
      loop.start(fakeGraph(clickTrack(120, 8, FS)));

      for (let i = 0; i < 20; i++) {
        now = i * 770;
        loop.step();
      }
      expect(loop.stepsPerSec()).toBeLessThanOrEqual(2);
    });
  });

  /**
   * The live path and the offline one, on the same audio, must agree.
   *
   * They did not. Everything the analysis does with a spectrum is a ratio bar
   * one number — the onset detector's absolute floor, which is what stops
   * silence from triggering — and the live graph was handing over magnitudes
   * five thousand times smaller than the offline path's, so the whole
   * detection function sat below that floor. Onsets fired on whichever frames
   * of a kick happened to clear an absolute bar, and the browser read
   * `regular 0.00` on a loop the same file read 1.00 on when swept. Measured
   * in Chrome after the fix, on a 30 s render of this same fixture: `bpm
   * 127.7 beat 1.00 regular 1.00 meter duple`.
   */
  it('reads the same groove through the analyser scale as through the fft', () => {
    const signal = edmLoop(128, 20, FS);
    const steps = Math.floor((20 * FS) / 735);

    const offline = new AnalysisLoop();
    offline.start(fakeGraph(signal));
    for (let i = 0; i < steps; i++) offline.step();

    const live = new AnalysisLoop();
    live.start(analyserGraph(signal));
    for (let i = 0; i < steps; i++) live.step();

    const a = offline.latest()!;
    const b = live.latest()!;
    expect(b.grid.bpm).toBeCloseTo(a.grid.bpm, 1);
    expect(b.grid.confidence).toBeGreaterThan(0.5);
    expect(b.rhythm.regular).toBeGreaterThanOrEqual(0.8);
    expect(b.rhythm.onsetsPerSec).toBeGreaterThan(3);
    expect(b.rhythm.meter).toBe('duple');
    expect(b.speech).toBeLessThanOrEqual(0.25);
  });

  /**
   * Pins the magnitude scale itself, at the one layer that is not a ratio:
   * `bandsRaw` is a direct mean of the linear magnitudes, and `flux` is a
   * direct difference between two frames of them, so either would show a
   * scale mismatch immediately — before it is buried under the grid,
   * onsets and everything downstream that measures a *shape* rather than a
   * *level*. Same synthesized signal, run through `fftMagnitudes` for the
   * offline reading and through `magnitudesFromDecibels` with the analyser's
   * own normalization for the live one.
   */
  it('scales bandsRaw and flux the same way live as offline, within 25%', () => {
    const signal = edmLoop(128, 6, FS);
    const frames = windowsFrom(signal, FS, FFT);

    const offline = new FeatureExtractor({ sampleRate: FS, fftSize: FFT });
    const offlineFeatures = frames.map((f) => offline.extract(f.mags, f.time, f.t));

    // The frame with the strongest attack: bandsRaw and flux both carry real
    // signal there rather than noise-floor rounding, which is where a 25%
    // tolerance would be meaningless either way.
    let bestIdx = 1;
    for (let i = 1; i < offlineFeatures.length; i++) {
      if (offlineFeatures[i]!.flux > offlineFeatures[bestIdx]!.flux) bestIdx = i;
    }

    const live = new FeatureExtractor({ sampleRate: FS, fftSize: FFT });
    let liveAtBest = live.extract(frames[0]!.mags, frames[0]!.time, frames[0]!.t);
    for (let i = 0; i <= bestIdx; i++) {
      const db = new Float32Array(frames[i]!.mags.length);
      for (let k = 0; k < db.length; k++) db[k] = 20 * Math.log10(Math.max(frames[i]!.mags[k]! / FFT, 1e-12));
      const mags = new Float32Array(db.length);
      magnitudesFromDecibels(db, mags);
      liveAtBest = live.extract(mags, frames[i]!.time, frames[i]!.t);
    }

    const a = offlineFeatures[bestIdx]!;
    const b = liveAtBest;

    for (let band = 0; band < a.bandsRaw.length; band++) {
      const ref = a.bandsRaw[band]!;
      if (ref < 1e-3) continue; // near-silent band: a ratio there is noise, not signal.
      expect(b.bandsRaw[band]!).toBeGreaterThanOrEqual(ref * 0.75);
      expect(b.bandsRaw[band]!).toBeLessThanOrEqual(ref * 1.25);
    }
    expect(a.flux).toBeGreaterThan(0);
    expect(b.flux).toBeGreaterThanOrEqual(a.flux * 0.75);
    expect(b.flux).toBeLessThanOrEqual(a.flux * 1.25);
  });

  it('keeps stepping off a timer while the page is hidden', () => {
    let hidden = false;
    let onVisible = (): void => {};
    let timerStep: (() => void) | null = null;
    const loop = new AnalysisLoop({
      host: {
        requestFrame: () => 1,
        cancelFrame: () => {},
        setTimer: (cb) => {
          timerStep = cb;
          return 2;
        },
        clearTimer: () => {
          timerStep = null;
        },
        hidden: () => hidden,
        onVisibilityChange: (cb) => {
          onVisible = cb;
          return () => {};
        },
      },
    });

    loop.start(fakeGraph(clickTrack(120, 4, FS)));
    expect(loop.driverMode()).toBe('frames');

    hidden = true;
    onVisible();
    expect(loop.driverMode()).toBe('timer');

    // The music has not stopped, so neither has the analysis: the timer drives
    // the same step the display frames were driving.
    timerStep!();
    timerStep!();
    expect(loop.latest()).not.toBeNull();
    expect(loop.stepsPerSec()).toBeGreaterThan(0);
  });

  it('stops reading once stopped', () => {
    const loop = new AnalysisLoop();
    loop.start(fakeGraph(clickTrack(120, 4, FS)));
    loop.step();
    const first = loop.latest()!.features.t;
    loop.stop();
    loop.step();

    expect(loop.latest()!.features.t).toBe(first);
  });
});

/**
 * The one audio graph: whatever is playing feeds an `AnalyserNode`, and every
 * frame of analysis is read from here.
 *
 * Two rules the rest of the app depends on:
 *
 * - The `AudioContext` is built by `createAudioGraph()`, which must be called
 *   from inside a user gesture. Browsers start a context created any other way
 *   in the `suspended` state, and a suspended analyser returns silence
 *   forever.
 * - A tab-capture source is connected to the analyser *only*. The captured tab
 *   is already audible through its own iframe; routing it to `destination`
 *   would play it a second time, slightly delayed. File sources are the
 *   exception — nothing else is playing them.
 * - The magnitudes `readFrame` hands out are in the same units as
 *   `analysis/fft.ts` produces. That is not automatic; see `MAGNITUDE_SCALE`.
 */

/** 4096 at 44.1 kHz is ~93 ms of history, ~10.8 Hz per bin: fine enough to see bass notes apart. */
const FFT_SIZE = 4096;
/** No smoothing: transients are the point, and Task 4 does its own smoothing. */
const SMOOTHING = 0;
const MIN_DB = -100;
const MAX_DB = -10;

/**
 * What the analyser's magnitudes have to be multiplied by to be the same
 * numbers `fftMagnitudes` returns.
 *
 * `AnalyserNode` divides its spectrum by `fftSize` before taking decibels;
 * `fftMagnitudes` normalizes by nothing at all, so a full-scale sine peaks
 * near `fftSize / 4` there and near 0.2 here — a factor of five thousand at
 * this window size. Everything the analysis does with a spectrum is a ratio
 * except one number, and that number is the onset detector's `ABSOLUTE_FLOOR`,
 * the gate that stops silence from triggering. Unscaled, the live path handed
 * it a detection function whose *loudest* measured value was about 0.012 —
 * just above the 0.01 floor rather than comfortably clear of it — so the
 * floor was close enough to the threshold to bite: onsets fired on whichever
 * frames of a kick happened to squeak over an absolute bar, if any, and
 * `regular` read 0.00 on a metronome-perfect loop while the same audio swept
 * offline read 1.00.
 *
 * The windows are not identical — the analyser applies Blackman (coherent
 * gain 0.42) where `fftMagnitudes` applies Hann (0.5) — so this is right to
 * about 20%. That is four orders of magnitude of margin on the only constant
 * that cares, and matching the windows exactly would mean reimplementing the
 * analyser rather than reading it.
 */
const MAGNITUDE_SCALE = FFT_SIZE;

/**
 * One `getFloatFrequencyData` reading as linear magnitudes on the analysis
 * layer's scale, written into `out`.
 *
 * Exported so the conversion can be exercised without an `AudioContext`:
 * `tests/app/analysisLoop.test.ts` drives the pipeline through it with
 * analyser-shaped decibels, which is the only way the live scale can be held
 * to the offline one in a test.
 */
export function magnitudesFromDecibels(db: Float32Array, out: Float32Array): void {
  for (let i = 0; i < db.length; i++) {
    const value = db[i]!;
    // Silence arrives as -Infinity; anything non-finite is simply no energy.
    out[i] = Number.isFinite(value) ? MAGNITUDE_SCALE * 10 ** (value / 20) : 0;
  }
}

export interface AudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
  /** Replaces any previous source. `toDestination` also makes it audible. */
  connectSource(node: AudioNode, toDestination: boolean): void;
  disconnectSource(): void;
  /**
   * The current frame. The arrays are reused between calls — read them, or
   * copy them, before the next call.
   */
  readFrame(): { mags: Float32Array; time: Float32Array; t: number };
}

export function createAudioGraph(): AudioGraph {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = SMOOTHING;
  analyser.minDecibels = MIN_DB;
  analyser.maxDecibels = MAX_DB;

  const db = new Float32Array(analyser.frequencyBinCount);
  const mags = new Float32Array(analyser.frequencyBinCount);
  const time = new Float32Array(analyser.fftSize);

  let source: AudioNode | null = null;
  let audible = false;

  function disconnectSource(): void {
    if (!source) return;
    // Targeted disconnects: the node belongs to the caller, which may still
    // want it for something else. Either throws if never connected.
    try {
      source.disconnect(analyser);
    } catch {
      /* already gone */
    }
    if (audible) {
      try {
        source.disconnect(ctx.destination);
      } catch {
        /* already gone */
      }
    }
    source = null;
    audible = false;
  }

  return {
    ctx,
    analyser,

    connectSource(node: AudioNode, toDestination: boolean): void {
      disconnectSource();
      node.connect(analyser);
      if (toDestination) node.connect(ctx.destination);
      source = node;
      audible = toDestination;
    },

    disconnectSource,

    readFrame(): { mags: Float32Array; time: Float32Array; t: number } {
      analyser.getFloatFrequencyData(db);
      analyser.getFloatTimeDomainData(time);
      magnitudesFromDecibels(db, mags);
      return { mags, time, t: ctx.currentTime };
    },
  };
}

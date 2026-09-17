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
 */

/** 4096 at 44.1 kHz is ~93 ms of history, ~10.8 Hz per bin: fine enough to see bass notes apart. */
const FFT_SIZE = 4096;
/** No smoothing: transients are the point, and Task 4 does its own smoothing. */
const SMOOTHING = 0;
const MIN_DB = -100;
const MAX_DB = -10;

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
      for (let i = 0; i < db.length; i++) {
        const value = db[i]!;
        // Silence arrives as -Infinity; anything non-finite is simply no energy.
        mags[i] = Number.isFinite(value) ? 10 ** (value / 20) : 0;
      }
      return { mags, time, t: ctx.currentTime };
    },
  };
}

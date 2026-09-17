/**
 * The browser end of the analysis: a display frame, an analyser read, and one
 * pass of the pipeline.
 *
 * Everything that reasons about the music lives in `analysis/pipeline.ts`,
 * which is pure and knows nothing about the page. This file is the three
 * things that are not: the `requestAnimationFrame` that drives it, the
 * `AudioGraph` it reads spectra from, and the `FeatureExtractor` that has to
 * be rebuilt when the graph — and with it the sample rate and fft size —
 * changes. Task 8's offline pass drives the same pipeline from a decoded file
 * with none of this attached.
 *
 * It runs on display frames because that is when there is a new spectrum worth
 * reading, but it never *times* anything with them: every instant downstream is
 * the audio clock carried in `FrameFeatures.t`.
 *
 * A browser does not run `requestAnimationFrame` at 60 Hz in a tab it has
 * backgrounded or a pane the desktop app has hidden — measured in Chrome
 * against a hidden pane, 1.3 times a second — and an analyser read is a 93 ms
 * window, so at that rate five sixths of the music is never looked at, and a
 * tempo taken off it reads 0.2 confident where the same audio swept offline
 * reads 1.0. The music does not stop when the user looks away, so neither does
 * this: `loopDriver` puts the step on a 33 ms timer for as long as the page is
 * hidden and back on frames when it returns.
 *
 * `stepsPerSec` publishes how often the step actually ran, so the HUD's reading
 * explains itself either way.
 */

import { AnalysisPipeline } from '../analysis/pipeline';
import { FeatureExtractor } from '../analysis/features';
import { createLoopDriver, type DriverHost, type LoopDriver } from './loopDriver';
import type { AnalysisSnapshot } from '../analysis/pipeline';
import type { AudioGraph } from '../source/audioGraph';

export type {
  AnalysisSnapshot,
  DynamicsReading,
  RhythmReading,
  TimbreReading,
} from '../analysis/pipeline';

/** How long `stepsPerSec` looks back, in milliseconds. */
const RATE_WINDOW_MS = 1000;
/**
 * Room for a second of steps at 240 a second, which is beyond any display this
 * runs on. A loop somehow faster than that saturates the count rather than
 * losing the window.
 */
const RATE_CAPACITY = 256;

export interface AnalysisLoopOptions {
  /**
   * The wall clock `stepsPerSec` measures against, in milliseconds. Injected
   * only so the rate can be tested without a display; the analysis itself
   * never reads it.
   */
  now?: () => number;
  /** The page the driver reads frames, timers and visibility from. */
  host?: DriverHost;
}

export class AnalysisLoop {
  private pipeline = new AnalysisPipeline();
  private graph: AudioGraph | null = null;
  private extractor: FeatureExtractor | null = null;
  private readonly driver: LoopDriver;

  /** When the last `RATE_CAPACITY` steps happened, newest at `rateHead - 1`. */
  private readonly stamps = new Float64Array(RATE_CAPACITY);
  private rateHead = 0;
  private rateStored = 0;
  private readonly now: () => number;

  constructor(o: AnalysisLoopOptions = {}) {
    this.now = o.now ?? (() => performance.now());
    this.driver = createLoopDriver(() => this.step(), o.host);
  }

  /**
   * Start reading `graph`. Safe to call again with the same graph; a different
   * one starts the analysis over.
   */
  start(graph: AudioGraph): void {
    if (this.graph !== graph) {
      this.graph = graph;
      // A new graph is new music on a new clock: a different sample rate or
      // fft size, times that start again from zero, and a first spectrum with
      // nothing to compare against. Nothing carried over would still be true.
      this.extractor = new FeatureExtractor({
        sampleRate: graph.ctx.sampleRate,
        fftSize: graph.analyser.fftSize,
      });
      this.pipeline = new AnalysisPipeline();
    }
    this.driver.start();
  }

  stop(): void {
    this.driver.stop();
    this.graph = null;
    this.extractor = null;
    this.rateStored = 0;
  }

  /** What the analysis currently believes, or null before the first frame. */
  latest(): AnalysisSnapshot | null {
    return this.pipeline.latest();
  }

  /**
   * How many times `step` ran in the last second — the HUD's `fps` row.
   *
   * Not an average since start and not a smoothed rate: the question it
   * answers is "is the loop running *now*", and a tab that has just been
   * hidden should say so within the second rather than decay towards it.
   */
  stepsPerSec(): number {
    const cutoff = this.now() - RATE_WINDOW_MS;
    let n = 0;
    while (n < this.rateStored) {
      const at = this.stamps[(this.rateHead - 1 - n + RATE_CAPACITY) % RATE_CAPACITY]!;
      if (at < cutoff) break;
      n += 1;
    }
    return (n * 1000) / RATE_WINDOW_MS;
  }

  /** Task 8 marks the boundaries it hears, which restarts the phrase count. */
  markSectionChange(now: number): void {
    this.pipeline.markSectionChange(now);
  }

  /** The beat grid the cue writers schedule against. */
  beatGrid(): ReturnType<AnalysisPipeline['beatGrid']> {
    return this.pipeline.beatGrid();
  }

  /**
   * One pass over the current frame. Public so it can be driven a frame at a
   * time in tests, where there is no display to sync to.
   */
  step(): void {
    const graph = this.graph;
    const extractor = this.extractor;
    if (!graph || !extractor) return;

    this.stamps[this.rateHead] = this.now();
    this.rateHead = (this.rateHead + 1) % RATE_CAPACITY;
    if (this.rateStored < RATE_CAPACITY) this.rateStored += 1;

    const frame = graph.readFrame();
    this.pipeline.step(extractor.extract(frame.mags, frame.time, frame.t));
  }

  /** Which clock the step is running on: the HUD says so when it is a timer. */
  driverMode(): ReturnType<LoopDriver['mode']> {
    return this.driver.mode();
  }
}

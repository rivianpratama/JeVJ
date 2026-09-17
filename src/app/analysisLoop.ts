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
 * It runs on rAF because that is when there is a new spectrum worth reading,
 * but it never *times* anything with it: every instant downstream is the audio
 * clock carried in `FrameFeatures.t`.
 */

import { AnalysisPipeline } from '../analysis/pipeline';
import { FeatureExtractor } from '../analysis/features';
import type { AnalysisSnapshot } from '../analysis/pipeline';
import type { AudioGraph } from '../source/audioGraph';

export type {
  AnalysisSnapshot,
  DynamicsReading,
  RhythmReading,
  TimbreReading,
} from '../analysis/pipeline';

export class AnalysisLoop {
  private pipeline = new AnalysisPipeline();
  private graph: AudioGraph | null = null;
  private extractor: FeatureExtractor | null = null;
  private handle = 0;

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
    if (this.handle === 0) this.handle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.handle !== 0) cancelAnimationFrame(this.handle);
    this.handle = 0;
    this.graph = null;
    this.extractor = null;
  }

  /** What the analysis currently believes, or null before the first frame. */
  latest(): AnalysisSnapshot | null {
    return this.pipeline.latest();
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

    const frame = graph.readFrame();
    this.pipeline.step(extractor.extract(frame.mags, frame.time, frame.t));
  }

  private readonly frame = (): void => {
    this.handle = requestAnimationFrame(this.frame);
    this.step();
  };
}

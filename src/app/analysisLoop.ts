/**
 * The analysis loop: one frame of audio in, everything the rest of the app
 * believes about the music out.
 *
 * This is the only place that knows the order the analysis runs in — features,
 * then onsets, then tempo, then the beat grid, each feeding the next — and the
 * only place that owns their state between frames. Everything upstream (the
 * HUD today, the visuals in Task 6, Jev in Task 5) reads a snapshot and never
 * sees the machinery.
 *
 * It runs on `requestAnimationFrame` because that is when there is a new
 * spectrum worth reading, but it never *times* anything with it: every instant
 * here is the audio clock carried in `FrameFeatures.t`. A frame the browser
 * skipped is a frame of audio that still happened, and rAF's clock would lie
 * about when.
 */

import { FeatureExtractor } from '../analysis/features';
import { BeatGrid, type Beat, type GridState } from '../analysis/grid';
import { OnsetDetector } from '../analysis/onset';
import { estimateTempo, type TempoEstimate } from '../analysis/tempo';
import type { AudioGraph } from '../source/audioGraph';
import type { FrameFeatures, Meter } from '../shared/types';

/** How often the tempo is re-measured, in audio seconds. */
const TEMPO_INTERVAL = 1;
/** How much onset envelope each measurement looks at. */
const TEMPO_WINDOW = 6;

export interface AnalysisSnapshot {
  features: FrameFeatures;
  /** Onset strength for this frame; 0 when it was not an onset. */
  onset: number;
  grid: GridState;
  /** The last tempo measured, or null before the first one. */
  tempo: TempoEstimate | null;
  /** Position within the current beat, 0..1. */
  phase: number;
  /** Beats that fell in this frame — usually none. */
  beats: Beat[];
}

export class AnalysisLoop {
  private onset = new OnsetDetector();
  private grid = new BeatGrid();

  private graph: AudioGraph | null = null;
  private extractor: FeatureExtractor | null = null;
  private tempo: TempoEstimate | null = null;
  private snapshot: AnalysisSnapshot | null = null;

  private handle = 0;
  private nextTempoAt = Infinity;

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
      this.onset = new OnsetDetector();
      this.grid = new BeatGrid();
      this.tempo = null;
      this.snapshot = null;
      this.nextTempoAt = Infinity;
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
    return this.snapshot;
  }

  /** Task 5 hears the meter in the music and tells the grid how to count. */
  setMeter(m: Meter): void {
    this.grid.setMeter(m);
  }

  /** Task 5 marks the boundaries it hears, which restarts the phrase count. */
  markSectionChange(now: number): void {
    this.grid.markSectionChange(now);
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
    const features = extractor.extract(frame.mags, frame.time, frame.t);

    const onset = this.onset.push(features);
    if (onset > 0) this.grid.onOnset(features.t, onset, this.onset.lowOnsetStrength());

    // The first measurement waits a full window: a tempo taken off a quarter
    // second of audio is a guess, and the grid would anchor to it.
    if (this.nextTempoAt === Infinity) this.nextTempoAt = features.t + TEMPO_WINDOW;
    if (features.t >= this.nextTempoAt) {
      this.nextTempoAt = features.t + TEMPO_INTERVAL;
      const estimate = estimateTempo(this.onset.envelope(TEMPO_WINDOW, features.t));
      this.tempo = estimate;
      // No confidence means no periodicity was found at all — silence, speech,
      // free time. Leaving the old grid running is better than re-anchoring
      // the beat to whatever the noise floor correlated with.
      if (estimate.confidence > 0) this.grid.setTempo(estimate, features.t);
    }

    // Advance the grid before reading it, so the state, the phase and the
    // beats in this snapshot all describe the same instant.
    const beats = this.grid.tick(features.t);
    this.snapshot = {
      features,
      onset,
      grid: this.grid.state(),
      tempo: this.tempo,
      phase: this.grid.phase(features.t),
      beats,
    };
  }

  private readonly frame = (): void => {
    this.handle = requestAnimationFrame(this.frame);
    this.step();
  };
}

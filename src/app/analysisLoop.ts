/**
 * The analysis loop: one frame of audio in, everything the rest of the app
 * believes about the music out.
 *
 * This is the only place that knows the order the analysis runs in — features,
 * then onsets, then tempo, then the beat grid, then the trackers that watch
 * key, rhythm, dynamics, timbre and speech over the longer term — and the only
 * place that owns their state between frames. Everything upstream (the HUD
 * today, the visuals in Task 6, Jev in Task 5b) reads a snapshot and never sees
 * the machinery.
 *
 * It runs on `requestAnimationFrame` because that is when there is a new
 * spectrum worth reading, but it never *times* anything with it: every instant
 * here is the audio clock carried in `FrameFeatures.t`. A frame the browser
 * skipped is a frame of audio that still happened, and rAF's clock would lie
 * about when.
 */

import { DropDetector, type DropEvent } from '../analysis/drop';
import { DynamicsTracker } from '../analysis/dynamics';
import { FeatureExtractor } from '../analysis/features';
import { BeatGrid, type Beat, type GridState } from '../analysis/grid';
import { KeyTracker, type KeyEstimate } from '../analysis/key';
import { OnsetDetector } from '../analysis/onset';
import { RhythmTracker } from '../analysis/rhythm';
import { SpeechDetector } from '../analysis/speech';
import { TimbreTracker, consonance } from '../analysis/timbre';
import { estimateTempo, type TempoEstimate } from '../analysis/tempo';
import type { AudioGraph } from '../source/audioGraph';
import type { Attack, DynClass, FrameFeatures, Meter, Trend } from '../shared/types';

/** How often the tempo is re-measured, in audio seconds. */
const TEMPO_INTERVAL = 1;
/** How much onset envelope each measurement looks at. */
const TEMPO_WINDOW = 6;
/**
 * The largest gap between frames the trackers are told about. A backgrounded
 * tab can return after minutes; feeding that as one `dt` would decay the key
 * accumulator to nothing and smooth the timbre through a whole song.
 */
const MAX_FRAME_GAP = 0.25;
/**
 * How sure of the tempo the loop has to be before the rhythm tracker is
 * allowed to count a meter.
 *
 * Until a tempo has been measured the grid free-runs on its default 120 BPM,
 * and the phase wraps the tracker counts beats from have nothing to do with
 * the music. Accent evidence gathered against them is an accent pattern read
 * out of nothing, and on a plain 4/4 click track it was enough to publish a
 * spurious triple and leave the grid counting in three.
 */
const METER_EVIDENCE_CONFIDENCE = 0.3;

export interface RhythmReading {
  sync: number;
  regular: number;
  meter: Meter;
  onsetsPerSec: number;
  onsetRatio: number;
}

export interface DynamicsReading {
  loud: DynClass;
  range: number;
  trend: Trend;
  crest: number;
  slope4: number;
  slope8: number;
  gap: boolean;
}

export interface TimbreReading {
  consonance: number;
  bright: number;
  noise: number;
  attack: Attack;
  sub: number;
  centroidSlope: number;
}

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
  key: KeyEstimate;
  rhythm: RhythmReading;
  dynamics: DynamicsReading;
  timbre: TimbreReading;
  /** 0..1: how much this sounds like talking rather than music. */
  speech: number;
  /**
   * The last slam or hole the detector called, or null before the first one.
   *
   * Sticky: it stays in the snapshot after the frame it fired on, so a
   * consumer reading at its own rate — the HUD at 15 Hz, the visuals at 60 —
   * cannot miss one. `t` says which event this is; a consumer that must act
   * once per event compares it against the `t` it acted on last.
   */
  drop: DropEvent | null;
}

export class AnalysisLoop {
  private onset = new OnsetDetector();
  private grid = new BeatGrid();
  private key = new KeyTracker();
  private rhythm = new RhythmTracker();
  private dynamics = new DynamicsTracker();
  private timbre = new TimbreTracker();
  private speech = new SpeechDetector();
  private drops = new DropDetector();

  private graph: AudioGraph | null = null;
  private extractor: FeatureExtractor | null = null;
  private tempo: TempoEstimate | null = null;
  private snapshot: AnalysisSnapshot | null = null;

  private handle = 0;
  private nextTempoAt = Infinity;
  private prevFrameT = NaN;
  /** The meter last handed to the grid, so it is only told when it changes. */
  private meter: Meter = 'unclear';
  /** The last event the drop detector called, kept for the next snapshot. */
  private drop: DropEvent | null = null;

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
      this.key = new KeyTracker();
      this.rhythm = new RhythmTracker();
      this.dynamics = new DynamicsTracker();
      this.timbre = new TimbreTracker();
      this.speech = new SpeechDetector();
      this.drops = new DropDetector();
      this.tempo = null;
      this.drop = null;
      this.snapshot = null;
      this.nextTempoAt = Infinity;
      this.prevFrameT = NaN;
      this.meter = 'unclear';
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

  /** Task 5b marks the boundaries it hears, which restarts the phrase count. */
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
    const dt = Number.isNaN(this.prevFrameT)
      ? 0
      : Math.min(MAX_FRAME_GAP, Math.max(0, features.t - this.prevFrameT));
    this.prevFrameT = features.t;

    const onset = this.onset.push(features);
    if (onset > 0) this.grid.onOnset(features.t, onset, this.onset.lowOnsetStrength());

    // Every frame, ahead of everything slower: an impact has a deadline no
    // tracker here does, and the detector needs the frames in order to have a
    // dip to measure the next one against.
    const drop = this.drops.push(features, onset);
    if (drop !== null) this.drop = drop;

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
    const phase = this.grid.phase(features.t);

    this.key.push(features.chroma, dt);
    this.timbre.push(features, onset, dt);
    this.dynamics.push(features.db, features.t);
    this.speech.push(features.rms, features.t, features);

    // The rhythm tracker counts beats from phase wraps, so it has to see every
    // frame, not only the ones an onset landed on — but those wraps are only
    // the music's beats once the tempo is measured and believed.
    this.rhythm.setMeterEvidence(
      this.tempo !== null && this.tempo.confidence >= METER_EVIDENCE_CONFIDENCE,
    );
    this.rhythm.tick(phase);
    if (onset > 0) this.rhythm.pushOnset(features.t, onset, phase);

    // The grid rebuilds its downbeat evidence whenever the bar length changes,
    // so it is only told when the answer is new. The tracker debounces the
    // answer itself, which is what keeps that from happening every other frame.
    const meter = this.rhythm.meter();
    if (meter !== this.meter) {
      this.meter = meter;
      this.grid.setMeter(meter);
    }

    // Read the grid only now: on the frame the meter flips, `setMeter` has
    // just changed the bar length, and a state taken before it would put a
    // stale `barLength` — and a stale `barSec` — in this snapshot.
    const grid = this.grid.state();
    const barSec = grid.period * grid.barLength;
    this.snapshot = {
      features,
      onset,
      grid,
      tempo: this.tempo,
      phase,
      beats,
      key: this.key.estimate(),
      rhythm: {
        sync: this.rhythm.syncopation(),
        regular: this.rhythm.regularity(),
        meter,
        onsetsPerSec: this.rhythm.onsetsPerSec(features.t),
        onsetRatio: this.rhythm.onsetRatio(features.t, barSec),
      },
      dynamics: {
        loud: this.dynamics.loudClass(),
        range: this.dynamics.range(),
        trend: this.dynamics.trend(),
        crest: this.dynamics.crest(),
        slope4: this.dynamics.slopeDb(4, barSec, features.t),
        slope8: this.dynamics.slopeDb(8, barSec, features.t),
        gap: this.dynamics.gap(features.t, grid.period),
      },
      timbre: {
        consonance: consonance(features.chroma),
        bright: this.timbre.brightness(),
        noise: this.timbre.noisiness(),
        attack: this.timbre.attack(),
        sub: this.timbre.subWeight(),
        centroidSlope: this.timbre.centroidSlope(),
      },
      speech: this.speech.score(grid.confidence),
      drop: this.drop,
    };
  }

  private readonly frame = (): void => {
    this.handle = requestAnimationFrame(this.frame);
    this.step();
  };
}

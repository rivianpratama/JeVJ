/**
 * One frame of features in, everything the app believes about the music out.
 *
 * This is the only place that knows the order the analysis runs in — onsets,
 * then tempo, then the beat grid, then the trackers that watch key, rhythm,
 * dynamics, timbre and speech over the longer term — and the only place that
 * owns their state between frames. Everything downstream reads a snapshot and
 * never sees the machinery.
 *
 * It is a pure function of the frames it is given, in the order it is given
 * them, and it has no clock of its own: every instant here is the audio clock
 * carried in `FrameFeatures.t`. That is what lets the same chain serve two
 * callers that could hardly be more different — `AnalysisLoop`, which reads
 * the analyser once per display frame, and `analyzeOffline`, which sweeps a
 * decoded file as fast as the CPU allows. A frame the browser skipped is a
 * frame of audio that still happened, and a file swept in three seconds is
 * thirty seconds of music: neither is the wall clock's business.
 */

import { DropDetector, type DropEvent } from './drop';
import { DynamicsTracker } from './dynamics';
import { BeatGrid, type Beat, type GridState } from './grid';
import { KeyTracker, type KeyEstimate } from './key';
import { OnsetDetector } from './onset';
import { RhythmTracker } from './rhythm';
import { SpeechDetector } from './speech';
import { TimbreTracker, consonance } from './timbre';
import { harshness, VocalDetector } from './vocal';
import { estimateTempo, type TempoEstimate } from './tempo';
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
 * How sure of the tempo the chain has to be before the rhythm tracker is
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
   * 0..1: how much of the last four seconds is holes, scaled so that a normal
   * speaking rate reads 1. The single cue that separates a talk from a record,
   * published separately because the model is shown it by name.
   */
  pause: number;
  /** 0..1: how far the fundamental wandered over the last second. */
  pitchVar: number;
  /** 0..1: how much of a singing voice is present. */
  vocal: number;
  /** 0..1: how abrasive the sound is right now. */
  harsh: number;
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

export class AnalysisPipeline {
  private onset = new OnsetDetector();
  private grid = new BeatGrid();
  private key = new KeyTracker();
  private rhythm = new RhythmTracker();
  private dynamics = new DynamicsTracker();
  private timbre = new TimbreTracker();
  private speech = new SpeechDetector();
  private vocal = new VocalDetector();
  private drops = new DropDetector();

  private tempo: TempoEstimate | null = null;
  private snapshot: AnalysisSnapshot | null = null;
  private nextTempoAt = Infinity;
  private prevFrameT = NaN;
  /** The meter last handed to the grid, so it is only told when it changes. */
  private meter: Meter = 'unclear';
  /** The last event the drop detector called, kept for the next snapshot. */
  private drop: DropEvent | null = null;

  /** What the analysis currently believes, or null before the first frame. */
  latest(): AnalysisSnapshot | null {
    return this.snapshot;
  }

  /** A section boundary restarts the phrase count the grid keeps. */
  markSectionChange(now: number): void {
    this.grid.markSectionChange(now);
  }

  /**
   * The beat grid, for the cue writers that schedule against it.
   *
   * The snapshot carries the grid's *state*, which is what a summary or a HUD
   * row needs; a writer needs it to predict, and a prediction cannot be read
   * off a struct. Narrowed to the two methods that ask rather than tell, so
   * nobody outside this chain can drive the grid.
   */
  beatGrid(): Pick<BeatGrid, 'state' | 'predict'> {
    return this.grid;
  }

  /** One pass over one frame. Frames must arrive in time order. */
  step(features: FrameFeatures): AnalysisSnapshot {
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
    this.vocal.push(features, dt);

    // The rhythm tracker counts beats from phase wraps, so it has to see every
    // frame, not only the ones an onset landed on — but those wraps are only
    // the music's beats once the tempo is measured and believed.
    this.rhythm.setBeatEvidence(
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
    const attack = this.timbre.attack();
    // Read once and shared: `speech` is told how regular the rhythm is so it
    // can tell a grid that locked onto a groove from one that locked onto
    // syllables, and `harsh` is told the crest so it can tell a saturated wall
    // from a loud bright pad. Both have to describe the same instant as the
    // readings they sit beside in this snapshot.
    const regular = this.rhythm.regularity();
    const crest = this.dynamics.crest();
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
        regular,
        meter,
        onsetsPerSec: this.rhythm.onsetsPerSec(features.t),
        onsetRatio: this.rhythm.onsetRatio(features.t, barSec),
      },
      dynamics: {
        loud: this.dynamics.loudClass(),
        range: this.dynamics.range(),
        trend: this.dynamics.trend(),
        crest,
        slope4: this.dynamics.slopeDb(4, barSec, features.t),
        slope8: this.dynamics.slopeDb(8, barSec, features.t),
        gap: this.dynamics.gap(features.t, grid.period),
      },
      timbre: {
        consonance: consonance(features.chroma),
        bright: this.timbre.brightness(),
        noise: this.timbre.noisiness(),
        attack,
        sub: this.timbre.subWeight(),
        centroidSlope: this.timbre.centroidSlope(),
      },
      // The beat, how sure of it we are, and how regularly anything lands on
      // it. A pulse train's harmonics sit in the syllabic band, so the
      // detector can only take them out of the measurement if it is told where
      // they are — and a grid that is certain about a period nothing plays on
      // is a grid that has locked onto speech, which is what `regular` says.
      speech: this.speech.score(
        grid.confidence,
        grid.period > 0 ? 1 / grid.period : 0,
        regular,
      ),
      pause: this.speech.pause(),
      pitchVar: this.speech.pitchVar(),
      vocal: this.vocal.score(),
      // Read off the trackers already in this snapshot, so `harsh` describes
      // the same instant as the brightness and the loudness it is made of.
      harsh: harshness({
        bright: this.timbre.brightness(),
        flatness: this.timbre.noisiness(),
        loudRel: this.dynamics.position(),
        crest,
        attack,
      }),
      drop: this.drop,
    };
    return this.snapshot;
  }
}

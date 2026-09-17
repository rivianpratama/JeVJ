/** Band edges in Hz; 9 edges describe the 8 analysis bands. */
export const BAND_EDGES_HZ = [20, 60, 130, 250, 500, 1000, 2000, 5000, 16000] as const; // 8 bands

export type TempoMarking = 'largo' | 'adagio' | 'andante' | 'moderato' | 'allegro' | 'vivace' | 'presto';
export type Meter = 'duple' | 'triple' | 'unclear';
export type Mode = 'major' | 'minor' | 'unclear';
export type ModalFlavor =
  | 'ionian'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'aeolian'
  | 'locrian'
  | 'unclear';
export type DynClass = 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff';
export type Trend = 'building' | 'fading' | 'steady';
export type Attack = 'sharp' | 'soft' | 'mixed';

export const GENRES = [
  'classical',
  'jazz',
  'electronic_dance',
  'hiphop_trap',
  'rock_metal',
  'ambient_drone',
  'pop',
  'folk_acoustic',
  'spoken',
] as const;
export type Genre = (typeof GENRES)[number];

export const SECTIONS = ['intro', 'verse_steady', 'build', 'drop_climax', 'breakdown', 'outro'] as const;
export type Section = (typeof SECTIONS)[number];

export const MOTIONS = ['flow', 'pulse', 'shatter', 'drift', 'swarm', 'bloom'] as const;
export type Motion = (typeof MOTIONS)[number];

export const BEATS_TO_CHANGE = ['1', '2', '4', '8', '16', 'none'] as const;
export type BeatsToChange = (typeof BEATS_TO_CHANGE)[number];

export const PRE_DROP_STYLES = ['silence_slam', 'riser', 'snare_roll', 'swell', 'none'] as const;
export type PreDropStyle = (typeof PRE_DROP_STYLES)[number];

/** One analysis frame straight off the audio graph. */
export interface FrameFeatures {
  t: number; // audio-clock seconds at which this frame was measured
  rms: number; // 0..1 linear
  db: number; // dBFS, -100..0
  bands: Float32Array; // 8, adaptive-normalized 0..1
  bandsRaw: Float32Array; // 8, mean linear magnitude per band
  centroid: number; // Hz
  flatness: number; // 0..1
  rolloff: number; // Hz where 95% cumulative energy is reached
  flux: number; // half-wave rectified spectral flux, >=0
  zcr: number; // zero crossings per second
  chroma: Float32Array; // 12, sums to 1 (all zeros if silent)
  sub: number; // share of energy in 20-60 Hz, 0..1
  pitch: number; // 0..1 harmonic-sum salience of the best f0 in 100-1000 Hz
  f0: number; // Hz of that best fundamental, refined past the scan grid; 0 when silent
  formant: number; // 0..1 share of 200 Hz-8 kHz energy sitting in 1-3 kHz
}

/** The compact, human-readable summary of recent audio that Jev is asked about. */
export interface MoodInput {
  pos: string;
  bpm: number;
  tempo: TempoMarking;
  beatConf: number;
  meter: Meter;
  sync: number;
  regular: number;
  key: string;
  mode: Mode;
  modeConf: number;
  modal: ModalFlavor;
  consonance: number;
  loud: DynClass;
  range: number;
  trend: Trend;
  crest: number;
  bright: number;
  noise: number;
  attack: Attack;
  sub: number;
  bands: number[]; // 8 ints 0..9
  speech: number;
  vocal: number; // 0..1 a sung voice is present
  harsh: number; // 0..1 abrasive, distorted or screamed
  onsetsPerSec: number;
  slope4: number;
  slope8: number;
  onsetRatio: number;
  centroidSlope: number;
  gap: boolean;
  barsSinceChange: number;
  barInPhrase: number;
}

/** Jev's judgment about the music: what it feels like and what is about to happen. */
export interface MoodVector {
  valence: number;
  arousal: number;
  tension: number;
  warmth: number;
  synthetic: number;
  space: number;
  aggression: number;
  melancholy: number;
  hypnotic: number;
  euphoricPeak: number;
  spoken: number;
  genre: Genre;
  genreP: Record<Genre, number>;
  section: Section;
  sectionP: Record<Section, number>;
  motion: Motion;
  motionP: Record<Motion, number>;
  dropImminent: number;
  beatsToChange: BeatsToChange;
  impact: number;
  preDropStyle: PreDropStyle;
  confidence: number;
}

/**
 * The moments pass 2 asks Jev to name.
 *
 * Local DSP finds *where* something happened; this is the vocabulary for
 * *what*. Every kind is a thing a listener would describe in a sentence, and
 * the order is the order the question's criteria are written in.
 */
export const TRANSITION_KINDS = [
  'drop',
  'build_start',
  'breakdown',
  'break_silence',
  'vocal_entry',
  'scream_peak',
  'quiet_fall',
  'tempo_change',
  'key_change',
  'none',
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * One candidate moment, as Jev is shown it: the music either side of it and
 * the handful of measurements that describe the seam itself.
 */
export interface TransitionInput {
  /** When it happens, `m:ss`. */
  at: string;
  /** The four bars before it. */
  before: MoodInput;
  /** The four bars after it. */
  after: MoodInput;
  /** Loudness change across the moment, in dB. */
  jumpDb: number;
  /** Seconds of near-silence immediately before it. */
  gapBeforeSec: number;
  bpmBefore: number;
  bpmAfter: number;
  keyChanged: boolean;
  /** How much more (or less) of a voice there is after it, -1..1. */
  vocalDelta: number;
  /** How much more (or less) abrasive it is after it, -1..1. */
  harshDelta: number;
}

/** What Jev says one candidate moment is, and how hard it lands. */
export interface TransitionVerdict {
  kind: TransitionKind;
  kindP: Record<TransitionKind, number>;
  /** 0..1 how hard it hits. */
  intensity: number;
  /** Probability a listener feels a jolt at it. */
  dramatic: number;
  /** 0 tension-building .. 1 tension-releasing. */
  release: number;
  confidence: number;
}

export const CUE_SOURCES = ['jev', 'grid', 'detector', 'offline'] as const;
export type CueSource = (typeof CUE_SOURCES)[number];

/** A scheduled instruction for the visuals at audio-clock time `t`. */
export interface Cue {
  t: number;
  source: CueSource;
  mood?: Partial<MoodVector>;
  impact?: number;
  section?: Section;
  beat?: boolean;
  downbeat?: boolean;
  build?: number; // build 0..1 anticipation ramp
  /** Fire a one-shot flourish here: a moment Jev called dramatic. */
  flourish?: boolean;
  /** Which transition wrote this cue, when one did. */
  transition?: TransitionKind;
}

export interface Timeline {
  step: 0.2;
  cues: Cue[];
}

export interface MoodResponse {
  mood: MoodVector;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

export interface TransitionResponse {
  /** One verdict per candidate sent, in the order they were sent. */
  verdicts: TransitionVerdict[];
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

/** One segment of the track, and what Jev said about it. */
export interface AnalyzedSegment {
  start: number;
  end: number;
  input: MoodInput;
  mood: MoodVector;
}

/** One candidate moment, and what Jev said it was. */
export interface AnalyzedTransition {
  /** Track seconds. `input.at` is the same instant, written for the model. */
  at: number;
  input: TransitionInput;
  verdict: TransitionVerdict;
}

/**
 * Every request and response of one analysis, with the track time it is about.
 *
 * Kept as text rather than as objects because this is a transcript: it feeds
 * the scrolling columns, which print it, and a cache, which stores it. Nothing
 * downstream re-decides anything from it.
 */
export interface AnalysisLogEntry {
  t: number;
  dir: 'req' | 'res';
  json: string;
}

/**
 * What the two passes cost, in the model's own accounting.
 *
 * Summed from the `usage` every `/api/mood` and `/api/transition` response
 * carries, so it is what was billed rather than an estimate of what was sent.
 * `lastLatencyMs` is the last call's round trip, which is the only latency the
 * HUD has ever printed.
 */
export interface TokenUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  lastLatencyMs: number;
}

/** The whole pre-analysis of one track: what to draw, and how we got there. */
export interface TrackAnalysis {
  videoId?: string;
  title: string;
  durationSec: number;
  segments: AnalyzedSegment[];
  transitions: AnalyzedTransition[];
  cues: Cue[];
  log: AnalysisLogEntry[];
  /**
   * What the analysis cost, when the caller was counting. Optional because a
   * record cached before v2.1 does not carry one, and a cache that rejects its
   * own old entries is a cache that re-analyzes every track once.
   */
  usage?: TokenUsage;
}

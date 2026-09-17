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

export type CueSource = 'jev' | 'grid' | 'detector' | 'offline';

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

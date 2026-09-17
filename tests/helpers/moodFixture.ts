/**
 * The Task 6 serialization example, as the object the whole mood layer is
 * tested against, plus a set of model answers shaped exactly like the SDK's.
 */

import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import type { MoodInput, TrackAnalysis, TransitionInput, TransitionVerdict } from '../../src/shared/types';

export const EXAMPLE_INPUT: MoodInput = {
  pos: '1:32/4:05',
  bpm: 128,
  tempo: 'allegro',
  beatConf: 0.9,
  meter: 'duple',
  sync: 0.3,
  regular: 0.9,
  key: 'F#',
  mode: 'minor',
  modeConf: 0.7,
  modal: 'aeolian',
  consonance: 0.6,
  loud: 'f',
  range: 0.2,
  trend: 'building',
  crest: 0.3,
  bright: 0.7,
  noise: 0.4,
  attack: 'sharp',
  sub: 0.8,
  bands: [9, 8, 6, 5, 5, 6, 7, 5],
  speech: 0.05,
  vocal: 0.2,
  harsh: 0.45,
  onsetsPerSec: 4.2,
  slope4: 3.5,
  slope8: 6.1,
  onsetRatio: 2.1,
  centroidSlope: 0.4,
  gap: false,
  barsSinceChange: 14,
  barInPhrase: 14,
};

/**
 * A candidate moment: quiet, sparse music before, loud dense music after, and
 * a hole in between — the shape of a drop, which is the case every consumer of
 * a `TransitionInput` has an opinion about.
 */
export function exampleTransition(at = '2:04', over: Partial<TransitionInput> = {}): TransitionInput {
  return {
    at,
    before: { ...EXAMPLE_INPUT, loud: 'p', bands: [3, 3, 2, 2, 2, 3, 4, 2], trend: 'building' },
    after: { ...EXAMPLE_INPUT, loud: 'ff', bands: [9, 9, 7, 6, 6, 7, 8, 6] },
    jumpDb: 12.4,
    gapBeforeSec: 0.4,
    bpmBefore: 128,
    bpmAfter: 128,
    keyChanged: false,
    vocalDelta: -0.1,
    harshDelta: 0.3,
    ...over,
  };
}

/** A verdict with every field set, for the writers and the record. */
export function exampleVerdict(over: Partial<TransitionVerdict> = {}): TransitionVerdict {
  const kindP: Record<string, number> = {
    drop: 0.6, build_start: 0.1, breakdown: 0.05, break_silence: 0.05, vocal_entry: 0.05,
    scream_peak: 0.05, quiet_fall: 0.02, tempo_change: 0.02, key_change: 0.02, none: 0.04,
  };
  return {
    kind: 'drop',
    kindP: kindP as TransitionVerdict['kindP'],
    intensity: 0.9,
    dramatic: 0.8,
    release: 0.7,
    confidence: 0.75,
    ...over,
  };
}

/** A small but complete analysis record: one segment, one moment, both cued. */
export function exampleAnalysis(videoId?: string): TrackAnalysis {
  const input = exampleTransition('0:24');
  const verdict = exampleVerdict();
  const analysis: TrackAnalysis = {
    title: 'a track',
    durationSec: 60,
    segments: [{ start: 0, end: 60, input: EXAMPLE_INPUT, mood: NEUTRAL_MOOD }],
    transitions: [{ at: 24, input, verdict }],
    cues: [
      { t: 0, source: 'offline', mood: NEUTRAL_MOOD },
      { t: 20, source: 'jev', build: 0, transition: 'drop' },
      { t: 24, source: 'jev', impact: 0.9, build: 1, section: 'drop_climax', flourish: true, transition: 'drop' },
    ],
    log: [
      { t: 0, dir: 'req', json: JSON.stringify(EXAMPLE_INPUT) },
      { t: 0, dir: 'res', json: JSON.stringify(NEUTRAL_MOOD) },
      { t: 24, dir: 'req', json: JSON.stringify(input) },
      { t: 24, dir: 'res', json: JSON.stringify(verdict) },
    ],
  };
  if (videoId !== undefined) analysis.videoId = videoId;
  return analysis;
}

function scoreAnswer(score: number, levels: number, confidence = 0.8): Record<string, unknown> {
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i++) probabilities[String(i)] = i === Math.round(score) ? 0.6 : 0.4 / (levels - 1);
  return { type: 'score', score, confidence, legend: {}, probabilities };
}

function noulAnswer(noul: number): Record<string, unknown> {
  return { type: 'noul', noul };
}

function choiceAnswer(
  choice: string,
  probabilities: Record<string, number>,
  confidence = 0.7,
): Record<string, unknown> {
  return { type: 'choice', choice, confidence, probabilities };
}

/** A full, well-formed answer set: everything decode has to cope with. */
export function exampleAnswers(): Record<string, unknown> {
  return {
    valence: scoreAnswer(3, 5, 0.8),
    arousal: scoreAnswer(4, 5, 0.6),
    tension: scoreAnswer(2, 5, 0.5),
    warmth: scoreAnswer(1, 5, 0.9),
    synthetic: scoreAnswer(4, 5, 0.7),
    space: scoreAnswer(2, 5, 0.4),
    aggression: noulAnswer(0.2),
    melancholy: noulAnswer(0.65),
    hypnotic: noulAnswer(0.8),
    euphoric_peak: noulAnswer(0.05),
    spoken: noulAnswer(0.01),
    genre: choiceAnswer('electronic_dance', { electronic_dance: 0.7, pop: 0.2, rock_metal: 0.1 }, 0.9),
    section: choiceAnswer('build', { build: 0.6, verse_steady: 0.3, drop_climax: 0.1 }, 0.6),
    motion: choiceAnswer('pulse', { pulse: 0.5, flow: 0.3, swarm: 0.2 }, 0.5),
    drop_imminent: noulAnswer(0.72),
    beats_to_change: choiceAnswer('8', { '8': 0.5, '16': 0.3, none: 0.2 }, 0.4),
    impact: scoreAnswer(3, 5, 0.6),
    pre_drop_style: choiceAnswer('riser', { riser: 0.8, swell: 0.2 }, 0.8),
  };
}

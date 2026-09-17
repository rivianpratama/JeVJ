/**
 * The Task 6 serialization example, as the object the whole mood layer is
 * tested against, plus a set of model answers shaped exactly like the SDK's.
 */

import type { MoodInput } from '../../src/shared/types';

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
  onsetsPerSec: 4.2,
  slope4: 3.5,
  slope8: 6.1,
  onsetRatio: 2.1,
  centroidSlope: 0.4,
  gap: false,
  barsSinceChange: 14,
  barInPhrase: 14,
};

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

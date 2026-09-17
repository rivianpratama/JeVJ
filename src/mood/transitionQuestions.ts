/**
 * Pass 2: what we ask Jev about a *moment* rather than about a passage.
 *
 * Pass 1 asks "what is this music like" once per section. That is the mood,
 * and it cross-fades. This asks the other question, the one a mood cannot
 * answer: *something happened at 2:04 — what was it, and how hard did it
 * land*. Local DSP is good at finding the instant and hopeless at naming it;
 * a model is the other way round; so the candidate finder brings the
 * timestamps and these four questions do the naming.
 *
 * As in `questions.ts`, the wording here is the interface. `kind`'s criteria
 * are what the whole taxonomy means — change "the payoff: full energy slams in
 * after a build or gap" and you have changed what a drop is — and the score
 * rubrics are the words the model reasons with about how hard something hit.
 *
 * **Four candidates per call.** A track has up to sixty moments worth asking
 * about and one question per call would be sixty round trips; the state
 * therefore carries four candidates as `t0`..`t3` and every question is asked
 * four times over, its id suffixed with the index and its instructions naming
 * the candidate it is about. The handler splits the answers back apart. Fewer
 * than four candidates is fine — the last batch of a track usually is — and
 * asks only the questions that have a candidate.
 *
 * No TypeSafe runtime import, for the same reason as `questions.ts`: the
 * client bundle reads these shapes and the SDK will not load in a browser.
 */

import { MOOD_PREAMBLE, type ChoiceQuestion, type NoulQuestion, type Question, type ScoreQuestion } from './questions';
import type { TransitionInput } from '../shared/types';

/** The most candidates one request may carry. */
export const TRANSITION_BATCH = 4;

/**
 * What the fields of a candidate mean, on top of the music legend.
 *
 * The two music pages inside a candidate are ordinary `MoodInput`s, so the
 * mood legend has to travel with them — a call that explained `crest` for one
 * page and not the other would be explaining it for neither.
 */
export const TRANSITION_PREAMBLE: Record<string, string> = {
  ...MOOD_PREAMBLE,
  at: 'when this moment happens, m:ss',
  before: 'the music over the 4 bars before it',
  after: 'the music over the 4 bars after it',
  jumpDb: 'loudness change across the moment, in dB',
  gapBeforeSec: 'seconds of near-silence immediately before it',
  'bpmBefore/bpmAfter': 'tempo either side',
  keyChanged: 'the harmony moved to a different tonic',
  vocalDelta: '-1..1 change in how much of a sung voice there is',
  harshDelta: '-1..1 change in how abrasive it is',
};

/** The choice rubric, in the order `TRANSITION_KINDS` declares. */
const KIND_CRITERIA = {
  drop: { what: 'the payoff: full energy slams in after a build or gap' },
  build_start: { what: 'energy begins rising toward something' },
  breakdown: { what: 'energy is pulled away after a peak, stripped down' },
  break_silence: { what: 'a sudden hole: near-silence or a filter cut' },
  vocal_entry: { what: 'a voice enters or becomes the focus' },
  scream_peak: { what: 'harsh, screamed or distorted climax' },
  quiet_fall: { what: 'gentle fall into a quiet passage' },
  tempo_change: { what: 'the pulse speeds up or slows down' },
  key_change: { what: 'the harmony moves to a new key' },
  none: { what: 'no meaningful change here' },
} as const;

/** The five levels of `intensity`, lowest first. */
export const INTENSITY_LEVELS = [
  'imperceptible',
  'gentle shift',
  'clear change',
  'strong hit',
  'overwhelming slam',
] as const;

/** The three levels of `release`, lowest first. */
export const RELEASE_LEVELS = [
  'tension is being built',
  'neutral',
  'tension is being released',
] as const;

/** The four questions asked of one candidate, without the index suffix. */
export const TRANSITION_QUESTION_IDS = ['kind', 'intensity', 'dramatic', 'release'] as const;
export type TransitionQuestionId = (typeof TRANSITION_QUESTION_IDS)[number];

/** `kind_2` for the third candidate of a batch. */
export function questionId(id: TransitionQuestionId, index: number): string {
  return `${id}_${index}`;
}

/** `t2` — the key the third candidate of a batch is carried under. */
export function candidateKey(index: number): string {
  return `t${index}`;
}

function kindQuestion(index: number): ChoiceQuestion {
  return {
    type: 'choice',
    instructions: `What kind of musical moment is \`${candidateKey(index)}\`? Judge from the music either side of it and from the measurements of the seam itself.`,
    criteria: KIND_CRITERIA,
  };
}

function intensityQuestion(index: number): ScoreQuestion {
  return {
    type: 'score',
    instructions: `How hard does the moment at \`${candidateKey(index)}\` hit a listener?`,
    criteria: [...INTENSITY_LEVELS] as unknown as ScoreQuestion['criteria'],
  };
}

function dramaticQuestion(index: number): NoulQuestion {
  return {
    type: 'noul',
    instructions: `About \`${candidateKey(index)}\`: Would a listener feel a jolt (goosebumps, a held breath, a gasp) at this moment?`,
    criteria: {
      true: 'the moment lands hard enough to be felt in the body',
      false: 'the music simply carries on',
    },
  };
}

function releaseQuestion(index: number): ScoreQuestion {
  return {
    type: 'score',
    instructions: `At \`${candidateKey(index)}\`, is tension being wound up or let go?`,
    criteria: [...RELEASE_LEVELS] as unknown as ScoreQuestion['criteria'],
  };
}

/**
 * The questions for a batch of `count` candidates, in candidate order.
 *
 * A count outside 1..`TRANSITION_BATCH` is clamped rather than refused: this
 * is called with a length, and a length that is wrong is a bug in the caller,
 * not something to fail a request over.
 */
export function transitionQuestions(count: number): Record<string, Question> {
  const n = Math.min(TRANSITION_BATCH, Math.max(1, Math.floor(count)));
  const out: Record<string, Question> = {};
  for (let i = 0; i < n; i++) {
    out[questionId('kind', i)] = kindQuestion(i);
    out[questionId('intensity', i)] = intensityQuestion(i);
    out[questionId('dramatic', i)] = dramaticQuestion(i);
    out[questionId('release', i)] = releaseQuestion(i);
  }
  return out;
}

export interface TransitionState {
  legend: Record<string, string>;
  [candidate: string]: TransitionInput | Record<string, string>;
}

/** The state one batch carries: the candidates as `t0`.., and the legend. */
export function buildTransitionState(inputs: readonly TransitionInput[]): TransitionState {
  const state: TransitionState = { legend: TRANSITION_PREAMBLE };
  inputs.slice(0, TRANSITION_BATCH).forEach((input, i) => {
    state[candidateKey(i)] = input;
  });
  return state;
}

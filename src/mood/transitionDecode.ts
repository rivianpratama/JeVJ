/**
 * A batch of transition answers, split back into one verdict per candidate.
 *
 * The call asked `kind_0`..`kind_3` and three more questions each; what comes
 * back is one flat map of answers, and the only thing that ties an answer to
 * the candidate it is about is the suffix on its id. Undoing that is this
 * file, and it is deliberately the *only* place that knows the naming scheme
 * other than `transitionQuestions.ts`.
 *
 * Nothing here trusts the model. A missing answer falls back to the neutral
 * verdict — `none`, no intensity, no drama — rather than to a guess, because
 * a transition nobody answered about is a moment the writer should leave
 * alone. Probability maps are coerced onto our own `TRANSITION_KINDS` exactly
 * as `decodeAnswers` coerces the mood labels.
 */

import { decodeChoice, readNoul, readScore, uniform, type Confidences } from './decode';
import {
  INTENSITY_LEVELS,
  RELEASE_LEVELS,
  questionId,
} from './transitionQuestions';
import { validateTransitionVerdict } from '../shared/moodSchema';
import { TRANSITION_KINDS, type TransitionVerdict } from '../shared/types';

/**
 * What a candidate nobody answered about is worth: nothing at all.
 *
 * `confidence: 0` is how a consumer tells this apart from a real `none` —
 * which is itself a useful answer, and comes back with a confidence.
 */
export const NEUTRAL_VERDICT: TransitionVerdict = {
  kind: 'none',
  kindP: uniform(TRANSITION_KINDS),
  intensity: 0,
  dramatic: 0,
  release: 0.5,
  confidence: 0,
};

/** One candidate's verdict, out of the flat answer map of a whole batch. */
export function decodeTransition(answers: Record<string, unknown>, index: number): TransitionVerdict {
  const conf: Confidences = [];
  const kind = decodeChoice(
    answers[questionId('kind', index)],
    TRANSITION_KINDS,
    NEUTRAL_VERDICT.kind,
    NEUTRAL_VERDICT.kindP,
    conf,
  );

  const verdict: TransitionVerdict = {
    kind: kind.label,
    kindP: kind.p,
    intensity: readScore(
      answers[questionId('intensity', index)],
      INTENSITY_LEVELS.length,
      NEUTRAL_VERDICT.intensity,
      conf,
    ),
    dramatic: readNoul(answers[questionId('dramatic', index)], NEUTRAL_VERDICT.dramatic),
    release: readScore(
      answers[questionId('release', index)],
      RELEASE_LEVELS.length,
      NEUTRAL_VERDICT.release,
      conf,
    ),
    confidence: conf.length === 0 ? 0 : conf.reduce((a, b) => a + b, 0) / conf.length,
  };

  const checked = validateTransitionVerdict(verdict);
  return checked.ok ? checked.value : { ...NEUTRAL_VERDICT };
}

/** `count` verdicts, in the order the candidates were sent. */
export function decodeTransitions(answers: Record<string, unknown>, count: number): TransitionVerdict[] {
  const out: TransitionVerdict[] = [];
  for (let i = 0; i < count; i++) out.push(decodeTransition(answers, i));
  return out;
}

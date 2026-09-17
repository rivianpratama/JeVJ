/**
 * The one place a transition request is answered.
 *
 * Same shape as `moodHandler.ts` and for the same reasons: every decision — is
 * this batch real, what do we ask about it, what do the answers mean, what do
 * we say when the model is down — lives here rather than at the front door, so
 * it can be tested against a fake client with no HTTP and no key in sight, and
 * so the key never leaves this module's caller.
 *
 * The one thing this does that the mood handler does not is *split*. A request
 * carries up to four candidate moments and the call asks sixteen questions
 * about them at once; what comes back is a flat answer map, and turning it
 * into one verdict per candidate — in the order they were sent — is the job of
 * `decodeTransitions`. A short batch is normal (the last one of a track almost
 * always is) and asks only the questions its candidates need.
 */

import { decodeTransitions } from '../src/mood/transitionDecode';
import { buildTransitionState, transitionQuestions, TRANSITION_BATCH } from '../src/mood/transitionQuestions';
import { validateTransitionInput } from '../src/shared/moodSchema';
import type { TransitionInput, TransitionResponse } from '../src/shared/types';
import type { JevLike } from './moodHandler';

/** The model we ask. Pinned by name, as the mood route pins it. */
export const TRANSITION_MODEL = 'jev-latest';

export interface TransitionDeps {
  client: JevLike;
  /** Milliseconds, for measuring latency; `Date.now` by default. */
  now?: () => number;
}

export type TransitionResult = { status: number; json: TransitionResponse | { error: string } };

/**
 * The candidates a body carries, or why it does not carry any.
 *
 * `{ transitions: [...] }` rather than a bare array so that the body has room
 * to grow a field without becoming a different kind of JSON, and because a
 * top-level array is the shape most likely to arrive by accident.
 */
function candidatesOf(body: unknown): { ok: true; value: TransitionInput[] } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body: expected an object' };
  const raw = (body as Record<string, unknown>)['transitions'];
  if (!Array.isArray(raw)) return { ok: false, error: 'transitions: expected an array' };
  if (raw.length === 0) return { ok: false, error: 'transitions: expected at least one candidate' };
  if (raw.length > TRANSITION_BATCH) {
    return { ok: false, error: `transitions: expected at most ${TRANSITION_BATCH} candidates` };
  }

  const out: TransitionInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const checked = validateTransitionInput(raw[i]);
    if (!checked.ok) return { ok: false, error: `transitions[${i}].${checked.error}` };
    out.push(checked.value);
  }
  return { ok: true, value: out };
}

export async function handleTransition(body: unknown, deps: TransitionDeps): Promise<TransitionResult> {
  const candidates = candidatesOf(body);
  if (!candidates.ok) return { status: 400, json: { error: candidates.error } };

  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    // The validated copies, not the body: validation rebuilds each candidate
    // field by field, so nothing a caller attached reaches the model.
    const result = await deps.client.systemOne({
      state: buildTransitionState(candidates.value),
      questions: transitionQuestions(candidates.value.length),
      model: TRANSITION_MODEL,
    });
    return {
      status: 200,
      json: {
        verdicts: decodeTransitions(result.answers, candidates.value.length),
        usage: {
          input_tokens: result.usage?.input_tokens ?? 0,
          output_tokens: result.usage?.output_tokens ?? 0,
        },
        latencyMs: Math.max(0, now() - startedAt),
      },
    };
  } catch (err) {
    return { status: 502, json: { error: describe(err) } };
  }
}

/**
 * What we are willing to say about a failure. An SDK error message can quote
 * the request — headers included — so only the HTTP status crosses the line.
 */
function describe(err: unknown): string {
  const status =
    typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : null;
  return status === null ? 'transition service unavailable' : `transition service returned ${status}`;
}

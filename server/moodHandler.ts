/**
 * The one place a mood request is answered, wherever it arrives from.
 *
 * Both front doors — the Vercel function in `api/mood.ts` and the Vite dev
 * middleware — are thin: they turn their own runtime's request into a body and
 * their own runtime's response out of `{ status, json }`. Everything that is
 * actually a decision (is this payload real, what do we ask, what does the
 * answer mean, what do we say when the model is down) lives here, so the two
 * doors cannot drift apart and so it can all be tested against a fake client
 * with no HTTP and no key in sight.
 *
 * The key never leaves this module's caller: `createJevClient` is the only
 * thing that sees it, and nothing it throws is forwarded to the client.
 */

import { TypeSafeClient, type EntryType, type Questions } from '@typesafe-ai/sdk';

import { decodeAnswers } from '../src/mood/decode';
import { buildState, questionsFor } from '../src/mood/questions';
import { validateMoodInput, validateMoodVector } from '../src/shared/moodSchema';
import type { MoodResponse, MoodVector } from '../src/shared/types';

/** The model we ask. Pinned by name so a client default cannot move it. */
export const MOOD_MODEL = 'jev-latest';

/** How long one call may take before it is a failure, in milliseconds. */
const TIMEOUT_MS = 8000;

/**
 * As much of the TypeSafe client as this handler uses. Narrow on purpose: the
 * tests hand it a function, and nothing here depends on the SDK.
 */
export interface JevLike {
  systemOne(req: { state: unknown; questions: Record<string, unknown>; model?: string }): Promise<{
    answers: Record<string, unknown>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

export interface MoodDeps {
  client: JevLike;
  /** Milliseconds, for measuring latency; `Date.now` by default. */
  now?: () => number;
}

export type MoodResult = { status: number; json: MoodResponse | { error: string } };

/**
 * The questions the caller asked for, and the answer it is holding.
 *
 * Both are hints rather than instructions: the client decides what is worth
 * asking this call (`mood/questions.ts`) and carries its last vector so that
 * the questions it skipped can be filled in rather than reset. Neither is
 * trusted — `questionsFor` drops names it does not know and falls back to the
 * whole set, and a `prev` that is not a well-formed vector is simply not there.
 */
function askedFor(body: unknown): { ask: string[]; previous: MoodVector | null } {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const ask = Array.isArray(raw['ask']) ? raw['ask'].filter((x): x is string => typeof x === 'string') : [];
  const prev = validateMoodVector(raw['prev']);
  return { ask, previous: prev.ok ? prev.value : null };
}

export async function handleMood(body: unknown, deps: MoodDeps): Promise<MoodResult> {
  const input = validateMoodInput(body);
  if (!input.ok) return { status: 400, json: { error: input.error } };
  const { ask, previous } = askedFor(body);

  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    // `input.value` and not `body`: validation copies the payload field by
    // field, so anything extra a caller attached never reaches the model.
    const result = await deps.client.systemOne({
      state: buildState(input.value),
      questions: questionsFor(ask),
      model: MOOD_MODEL,
    });
    return {
      status: 200,
      json: {
        mood: decodeAnswers(result.answers, previous),
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
  return status === null ? 'mood service unavailable' : `mood service returned ${status}`;
}

/** The real client. Server-side only: the SDK refuses to run in a browser. */
export function createJevClient(apiKey: string): JevLike {
  const client = new TypeSafeClient({ apiKey, timeout: TIMEOUT_MS });
  return {
    async systemOne(req) {
      // The casts cross a deliberate seam: `JevLike` is stated in plain JSON
      // so the handler and its tests owe the SDK nothing. `MOOD_QUESTIONS` is
      // structurally a `Questions` and the state is a JSON object, which is
      // exactly what `EntryType` admits.
      const result = await client.systemOne({
        state: req.state as EntryType,
        questions: req.questions as Questions,
        ...(req.model === undefined ? {} : { model: req.model }),
      });
      return {
        answers: result.answers as Record<string, unknown>,
        usage: result.usage,
      };
    },
  };
}

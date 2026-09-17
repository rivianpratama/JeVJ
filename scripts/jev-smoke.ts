/**
 * One real call to Jev, end to end: `npm run smoke -- --live`.
 *
 * The unit tests run against a fake client, so nothing in them would notice if
 * the question shapes were rejected by the API, if a rubric came back with a
 * different number of levels than we asked for, or if a call cost five times
 * what we budgeted. This does notice, for the price of one request.
 *
 * **It costs money, so it does not spend any unless you say `--live`.** Run
 * without it — or with `--dry`, which is the same thing said out loud — and it
 * builds exactly what would be sent and prints the shape and the estimated
 * size of it, without opening a socket. That is the mode CI and a routine
 * `npm test` sweep want, and it still catches the thing that breaks most
 * often: a payload or a rubric that has quietly grown.
 *
 * It reads `.env` itself rather than adding a dotenv dependency, and it prints
 * the decoded mood, the token usage and the latency. The key is never printed
 * and never appears in the output.
 */

import { resolve } from 'node:path';

import { readEnvFile } from '../server/env';
import { createJevClient, handleMood } from '../server/moodHandler';
import { MOOD_QUESTIONS, buildState } from '../src/mood/questions';
import { estimateTokens } from '../src/shared/tokens';
import type { MoodInput } from '../src/shared/types';

/** The serialization example from Task 6: a build, 14 bars in, at 128 BPM. */
const PAYLOAD: MoodInput = {
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
  pause: 0,
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

/** One live call, printed. */
async function run(
  client: ReturnType<typeof createJevClient>,
): Promise<{ tokens: number; latencyMs: number } | null> {
  const result = await handleMood(PAYLOAD, { client });
  if (result.status !== 200 || !('mood' in result.json)) {
    console.error(`status ${result.status}:`, result.json);
    return null;
  }
  const { mood, usage, latencyMs } = result.json;
  const tokens = usage.input_tokens + usage.output_tokens;
  console.log(`\nevery question — ${Object.keys(MOOD_QUESTIONS).length} of them`);
  console.log('mood   ', JSON.stringify(round(mood)));
  console.log('usage  ', JSON.stringify(usage), `→ ${tokens} tokens`);
  console.log('latency', `${latencyMs} ms`);
  return { tokens, latencyMs };
}

/** What would be sent, measured, without sending it. */
function dryRun(): void {
  const state = buildState(PAYLOAD);
  const questions = Object.keys(MOOD_QUESTIONS);
  console.log('dry run — nothing was sent. Add --live to spend a call.\n');
  console.log(`questions   ${questions.length}: ${questions.join(', ')}`);
  console.log(`state       ${estimateTokens(JSON.stringify(state))} est. tokens`);
  console.log(`questions   ${estimateTokens(JSON.stringify(MOOD_QUESTIONS))} est. tokens`);
  console.log(`request     ~${estimateTokens(JSON.stringify({ state, questions: MOOD_QUESTIONS }))} est. tokens`);
}

async function main(): Promise<void> {
  // Live is opt-in. A script that costs money on a bare `npm run smoke` is a
  // script somebody runs by accident.
  if (!process.argv.includes('--live')) {
    dryRun();
    return;
  }

  const env = readEnvFile(resolve(process.cwd(), '.env'));
  const apiKey = env['TYPESAFE_API_KEY'] ?? process.env['TYPESAFE_API_KEY'] ?? '';
  if (apiKey === '') {
    console.error('no TYPESAFE_API_KEY in .env or the environment');
    process.exitCode = 1;
    return;
  }

  if ((await run(createJevClient(apiKey))) === null) process.exitCode = 1;
}

/** Two decimals on every number, so one line of output stays one line. */
function round(m: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'number') out[k] = Number(v.toFixed(2));
    else if (v !== null && typeof v === 'object') out[k] = round(v as object);
    else out[k] = v;
  }
  return out;
}

void main();

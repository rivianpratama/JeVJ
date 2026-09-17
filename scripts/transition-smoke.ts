/**
 * The whole two-pass analysis against the real model:
 * `npm run smoke:transition -- --live`.
 *
 * The unit tests run the song fixture past a *scripted* Jev — one that reads
 * the payload and answers by rule — which proves the chain lines up but proves
 * nothing about whether the questions in `transitionQuestions.ts` mean what we
 * think they mean to the model. This does, for the price of one track's worth
 * of calls: it sweeps the fixture, asks Jev about every segment and every
 * candidate, and prints what came back next to the four moments the fixture was
 * built out of.
 *
 * **A track's worth of calls is real money, so it does not spend any unless you
 * say `--live`.** Without it — or with `--dry`, which is the same thing said out
 * loud — the sweep runs exactly as it would, the candidates are found and the
 * requests are built, and then the size of them is printed instead of being
 * sent. That is what catches a batch that has outgrown the body limit, or a
 * candidate finder that has started returning sixty moments where it used to
 * return twelve, without opening a socket.
 *
 * It reads `.env` itself rather than adding a dotenv dependency. The key is
 * never printed and never appears in the output.
 */

import { resolve } from 'node:path';

import { readEnvFile } from '../server/env';
import { createJevClient, handleMood } from '../server/moodHandler';
import { handleTransition } from '../server/transitionHandler';
import { analyzeTrack } from '../src/app/trackAnalysis';
import { buildTransitionState, transitionQuestions } from '../src/mood/transitionQuestions';
import { NEUTRAL_MOOD } from '../src/shared/moodSchema';
import { estimateTokens } from '../src/shared/tokens';
import { songFixture } from '../tests/helpers/synth';
import type { MoodVector, TransitionInput, TransitionVerdict } from '../src/shared/types';

/** The rate the tests sweep the fixture at, so the timings are comparable. */
const SR = 44100;

/** What one batch would have cost to send, without sending it. */
function measure(inputs: TransitionInput[]): number {
  return estimateTokens(
    JSON.stringify({
      state: buildTransitionState(inputs),
      questions: transitionQuestions(inputs.length),
    }),
  );
}

async function main(): Promise<void> {
  // Live is opt-in: a track's worth of calls is not something to run by
  // accident. Everything below still happens — the sweep, the candidates, the
  // requests — it is only the sending that is skipped.
  const live = process.argv.includes('--live');

  const env = readEnvFile(resolve(process.cwd(), '.env'));
  const apiKey = live ? (env['TYPESAFE_API_KEY'] ?? process.env['TYPESAFE_API_KEY'] ?? '') : '';
  if (live && apiKey === '') {
    console.error('no TYPESAFE_API_KEY in .env or the environment');
    process.exitCode = 1;
    return;
  }

  const client = live ? createJevClient(apiKey) : null;
  /** The biggest request a batch would carry, in estimated tokens. */
  let widestBatch = 0;
  const { signal, truth } = songFixture(SR);

  let tokens = 0;
  let moodCalls = 0;
  let transitionCalls = 0;
  let failures = 0;

  const startedAt = Date.now();
  const analysis = await analyzeTrack(
    signal,
    SR,
    {
      title: 'song fixture',
      askJev: async (input): Promise<MoodVector> => {
        moodCalls += 1;
        if (client === null) return { ...NEUTRAL_MOOD };
        const res = await handleMood(input, { client });
        if (res.status !== 200 || !('mood' in res.json)) {
          failures += 1;
          console.error(`  mood call failed: ${JSON.stringify(res.json)}`);
          return { ...NEUTRAL_MOOD };
        }
        tokens += res.json.usage.input_tokens + res.json.usage.output_tokens;
        return res.json.mood;
      },
      askTransition: async (inputs): Promise<TransitionVerdict[]> => {
        transitionCalls += 1;
        widestBatch = Math.max(widestBatch, measure(inputs));
        if (client === null) {
          // A verdict nobody gave. `none` writes no cues, so the dry run
          // reports what would have been *asked* and claims nothing about what
          // would have come back.
          return inputs.map(() => ({
            kind: 'none' as const,
            kindP: {
              drop: 0, build_start: 0, breakdown: 0, break_silence: 0, vocal_entry: 0,
              scream_peak: 0, quiet_fall: 0, tempo_change: 0, key_change: 0, none: 1,
            },
            intensity: 0,
            dramatic: 0,
            release: 0.5,
            confidence: 0,
          }));
        }
        const res = await handleTransition({ transitions: inputs }, { client });
        if (res.status !== 200 || !('verdicts' in res.json)) {
          failures += 1;
          console.error(`  transition call failed: ${JSON.stringify(res.json)}`);
          return [];
        }
        tokens += res.json.usage.input_tokens + res.json.usage.output_tokens;
        return res.json.verdicts;
      },
    },
    (p) => {
      const percent = Math.round(40 + p * 60);
      if (percent % 10 === 0) process.stdout.write(`analyzing track ${percent}%\r`);
    },
  );
  const elapsedMs = Date.now() - startedAt;

  console.log(`\nanalyzing track 100% — ready\n`);
  if (client === null) console.log('dry run — nothing was sent. Add --live to spend a track.\n');
  console.log(`segments      ${analysis.segments.length} (${moodCalls} mood calls)`);
  console.log(`candidates    ${analysis.transitions.length} (${transitionCalls} transition calls)`);
  console.log(`cues          ${analysis.cues.length}`);
  console.log(`log entries   ${analysis.log.length}`);

  console.log('\ntransitions found');
  for (const t of analysis.transitions) {
    const v = t.verdict;
    console.log(
      `  ${t.at.toFixed(2).padStart(6)}s  ${v.kind.padEnd(13)} intensity ${v.intensity.toFixed(2)}` +
        `  dramatic ${v.dramatic.toFixed(2)}  release ${v.release.toFixed(2)}  conf ${v.confidence.toFixed(2)}`,
    );
  }

  console.log('\nagainst the fixture');
  for (const [name, at] of Object.entries(truth)) {
    const near = analysis.transitions
      .filter((t) => Math.abs(t.at - at) <= 0.6)
      .map((t) => `${t.verdict.kind}@${t.at.toFixed(2)}s i=${t.verdict.intensity.toFixed(2)}`);
    console.log(`  ${name.padEnd(15)} ${String(at).padStart(5)}s  ${near.length === 0 ? '— nothing found' : near.join(', ')}`);
  }

  const impacts = analysis.cues.filter((c) => c.impact !== undefined && c.source === 'jev');
  const flourishes = analysis.cues.filter((c) => c.flourish === true);
  console.log(`\nimpact cues   ${impacts.map((c) => c.t.toFixed(2)).join(', ') || '—'}`);
  console.log(`flourishes    ${flourishes.length}`);

  console.log(`\nwidest batch  ~${widestBatch} est. tokens`);
  if (client === null) {
    console.log(`calls         ${moodCalls + transitionCalls} would have gone out`);
    console.log(`elapsed       ${(elapsedMs / 1000).toFixed(1)} s (sweep only)`);
    return;
  }
  console.log(`tokens        ${tokens}`);
  console.log(`calls         ${moodCalls + transitionCalls} (${failures} failed)`);
  console.log(`elapsed       ${(elapsedMs / 1000).toFixed(1)} s`);
  if (failures > 0) process.exitCode = 1;
}

void main();

/**
 * The whole two-pass analysis against the real model: `npm run smoke:transition`.
 *
 * The unit tests run the song fixture past a *scripted* Jev — one that reads
 * the payload and answers by rule — which proves the chain lines up but proves
 * nothing about whether the questions in `transitionQuestions.ts` mean what we
 * think they mean to the model. This does, for the price of one track's worth
 * of calls: it sweeps the fixture, asks Jev about every segment and every
 * candidate, and prints what came back next to the four moments the fixture was
 * built out of.
 *
 * It reads `.env` itself rather than adding a dotenv dependency. The key is
 * never printed and never appears in the output.
 */

import { resolve } from 'node:path';

import { readEnvFile } from '../server/env';
import { createJevClient, handleMood } from '../server/moodHandler';
import { handleTransition } from '../server/transitionHandler';
import { analyzeTrack } from '../src/app/trackAnalysis';
import { NEUTRAL_MOOD } from '../src/shared/moodSchema';
import { songFixture } from '../tests/helpers/synth';
import type { MoodVector, TransitionVerdict } from '../src/shared/types';

/** The rate the tests sweep the fixture at, so the timings are comparable. */
const SR = 44100;

async function main(): Promise<void> {
  const env = readEnvFile(resolve(process.cwd(), '.env'));
  const apiKey = env['TYPESAFE_API_KEY'] ?? process.env['TYPESAFE_API_KEY'] ?? '';
  if (apiKey === '') {
    console.error('no TYPESAFE_API_KEY in .env or the environment');
    process.exitCode = 1;
    return;
  }

  const client = createJevClient(apiKey);
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

  console.log(`\ntokens        ${tokens}`);
  console.log(`calls         ${moodCalls + transitionCalls} (${failures} failed)`);
  console.log(`elapsed       ${(elapsedMs / 1000).toFixed(1)} s`);
  if (failures > 0) process.exitCode = 1;
}

void main();

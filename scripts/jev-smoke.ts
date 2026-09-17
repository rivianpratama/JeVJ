/**
 * One real call to Jev, end to end: `npx tsx scripts/jev-smoke.ts`.
 *
 * The unit tests run against a fake client, so nothing in them would notice if
 * the question shapes were rejected by the API, if a rubric came back with a
 * different number of levels than we asked for, or if a call cost five times
 * what we budgeted. This does notice, for the price of one request.
 *
 * It reads `.env` itself rather than adding a dotenv dependency, and it prints
 * the decoded mood, the token usage and the latency. The key is never printed
 * and never appears in the output.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createJevClient, handleMood } from '../server/moodHandler';
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
  onsetsPerSec: 4.2,
  slope4: 3.5,
  slope8: 6.1,
  onsetRatio: 2.1,
  centroidSlope: 0.4,
  gap: false,
  barsSinceChange: 14,
  barInPhrase: 14,
};

/** `KEY=value` lines, quotes stripped, `#` comments and blanks ignored. */
function readEnvFile(path: string): Record<string, string> {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key !== '') out[key] = value;
  }
  return out;
}

async function main(): Promise<void> {
  const env = readEnvFile(resolve(process.cwd(), '.env'));
  const apiKey = env['TYPESAFE_API_KEY'] ?? process.env['TYPESAFE_API_KEY'] ?? '';
  if (apiKey === '') {
    console.error('no TYPESAFE_API_KEY in .env or the environment');
    process.exitCode = 1;
    return;
  }

  const result = await handleMood(PAYLOAD, { client: createJevClient(apiKey) });
  if (result.status !== 200 || !('mood' in result.json)) {
    console.error(`status ${result.status}:`, result.json);
    process.exitCode = 1;
    return;
  }

  const { mood, usage, latencyMs } = result.json;
  console.log('mood   ', JSON.stringify(round(mood)));
  console.log('usage  ', JSON.stringify(usage));
  console.log('latency', `${latencyMs} ms`);
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

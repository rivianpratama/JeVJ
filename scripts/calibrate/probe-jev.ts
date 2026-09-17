/**
 * A whole cached track through both passes, live:
 * `npx tsx scripts/calibrate/probe-jev.ts [id...] [--seconds=N]`
 *
 * `probe-features.ts` measures the local DSP and can be run for nothing.
 * This is the other half: it runs `analyzeTrack` — the same function the app
 * runs — against the real model, and prints what pass 1 and pass 2 actually
 * said. It is what the numbers in `docs/tuning-notes.md` are taken from, and
 * it is the only way to tell a rubric that reads well from a rubric that
 * works, because the difference is a paragraph of English and a model's
 * opinion of it.
 *
 * **It spends money.** One four-minute track is 30-50 calls and 150k-190k
 * input tokens, and the totals are printed at the end of every run so that a
 * calibration pass can be accounted for. `--seconds` cuts the audio down when
 * only a section is in question; the whole track is the default because the
 * segmentation and the candidate cap are both properties of the whole.
 *
 * `--dry` costs nothing and asks nothing: both passes are stubbed, and what is
 * printed is the candidate list with the flags the model *would* have been
 * shown — `burst`, `beatless`, the beat confidence after the seam, the
 * harshness either side. That is where a flag's thresholds get tuned, because
 * a flag that never fires is a local bug and no number of live calls will say
 * so.
 *
 * It reads `.env` for `TYPESAFE_API_KEY` itself rather than adding a dotenv
 * dependency, exactly as `scripts/jev-smoke.ts` does, and the key is neither
 * printed nor passed anywhere but `createJevClient`. Nothing is written: the
 * cache is not touched, so a run here cannot make the app skip an analysis.
 */

import { resolve } from 'node:path';

import { readEnvFile } from '../../server/env';
import { createJevClient, handleMood, type JevLike } from '../../server/moodHandler';
import { handleTransition } from '../../server/transitionHandler';
import { analyzeTrack } from '../../src/app/trackAnalysis';
import { selectQuestionIds } from '../../src/mood/questions';
import {
  GENRES,
  TRANSITION_KINDS,
  type AnalyzedTransition,
  type Genre,
  type MoodVector,
  type TokenUsage,
  type TransitionKind,
  type TransitionVerdict,
} from '../../src/shared/types';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { decodeMono, SAMPLE_RATE, TRACKS } from './decode';

/** The tracks the speech, scream and swell work is judged on. */
const DEFAULT_IDS = ['Y6bbMQXQ180', '6fVE8kSM43I', '2WfaotSK3mI', 'OlaTeXX3uH8'];

/** `m:ss` for the per-transition lines. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** `{ a: 2, b: 1 }` as `a 2, b 1`, commonest first. */
function tally(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${n}`)
    .join(', ');
}

async function run(
  id: string,
  seconds: number | undefined,
  apiKey: string,
  dry: boolean,
): Promise<void> {
  const mono = await decodeMono(
    resolve(process.cwd(), 'cache', `${id}.mp4`),
    seconds === undefined ? {} : { seconds },
  );
  // Counted here rather than by `httpDeps`, which is the only other thing that
  // knows a `usage` field exists: this script talks to the handlers directly.
  const usage: TokenUsage = { calls: 0, input_tokens: 0, output_tokens: 0, lastLatencyMs: 0 };

  const started = Date.now();
  const analysis = await analyzeTrack(mono, SAMPLE_RATE, {
    title: TRACKS[id] ?? id,
    videoId: id,
    usage,
    askJev: dry
      ? async (): Promise<MoodVector> => ({ ...NEUTRAL_MOOD })
      : async (input) => {
          // The same question selection the client makes, so the bill and the
          // answers are the app's rather than this script's.
          const ask = selectQuestionIds({ callIndex: 0, input, previous: null });
          const result = await handleMood({ ...input, ask }, { client: client(apiKey) });
          if (result.status !== 200 || !('mood' in result.json)) {
            console.error(`  mood call failed: ${JSON.stringify(result.json)}`);
            return { ...NEUTRAL_MOOD };
          }
          add(usage, result.json);
          return result.json.mood;
        },
    askTransition: dry
      ? async (inputs): Promise<TransitionVerdict[]> => inputs.map(() => ({ ...NO_VERDICT }))
      : async (inputs) => {
          const result = await handleTransition(
            { transitions: inputs },
            { client: client(apiKey) },
          );
          if (result.status !== 200 || !('verdicts' in result.json)) {
            throw new Error(`transition call failed: ${JSON.stringify(result.json)}`);
          }
          add(usage, result.json);
          return result.json.verdicts;
        },
  });

  if (dry) {
    printDry(id, analysis.segments.length, analysis.transitions);
    return;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const moods: MoodVector[] = analysis.segments.map((s) => s.mood);
  const genres = moods.map((m) => m.genre);
  const kinds = analysis.transitions.map((t) => t.verdict.kind);

  console.log(`\n=== ${id} — ${TRACKS[id] ?? '?'} ===`);
  console.log(
    `${analysis.segments.length} segments, ${analysis.transitions.length} transitions, ${elapsed}s`,
  );
  console.log(`genre    ${tally(genres)}`);
  console.log(
    `spoken   mean ${mean(moods.map((m) => m.spoken)).toFixed(2)}` +
      `  >=0.7 in ${share(moods, (m) => m.spoken >= 0.7)} of ${moods.length} segments` +
      `  | aggression mean ${mean(moods.map((m) => m.aggression)).toFixed(2)}`,
  );
  console.log(`kinds    ${tally(kinds)}`);

  // The kinds the fixes are about, with the flags that should have steered
  // them, so a wrong answer can be read against what the model was shown.
  for (const t of analysis.transitions) {
    const k: TransitionKind = t.verdict.kind;
    if (k !== 'drop' && k !== 'scream_peak') continue;
    console.log(
      `  ${clock(t.at)} ${k.padEnd(12)} intensity ${t.verdict.intensity.toFixed(2)}` +
        `  burst ${t.input.burst ? 'Y' : 'n'} beatless ${t.input.beatless ? 'Y' : 'n'}` +
        `  afterBeatConf ${t.input.after.beatConf.toFixed(2)}` +
        `  harsh ${t.input.after.harsh.toFixed(1)} (${t.input.harshDelta >= 0 ? '+' : ''}${t.input.harshDelta.toFixed(2)})`,
    );
  }

  const shareOfGenre = (g: Genre): string =>
    `${((genres.filter((x) => x === g).length / Math.max(1, genres.length)) * 100).toFixed(0)}%`;
  console.log(`         ${GENRES.map((g) => `${g} ${shareOfGenre(g)}`).filter((s) => !s.endsWith(' 0%')).join(', ')}`);

  console.log(
    `tokens   ${usage.calls} calls, ${usage.input_tokens.toLocaleString()} in, ` +
      `${usage.output_tokens.toLocaleString()} out`,
  );
}

/**
 * The candidate list with the flags the model would have been shown.
 *
 * This is the table a threshold gets tuned against. `burst` and `beatless`
 * both exist to keep a moment from being called a drop, and both are computed
 * locally from numbers that are here in full — so a flag that never fires, or
 * one that fires on a chorus, is visible before a single call goes out.
 */
function printDry(id: string, segments: number, transitions: readonly AnalyzedTransition[]): void {
  console.log(`\n=== ${id} — ${TRACKS[id] ?? '?'} — dry ===`);
  console.log(`${segments} segments, ${transitions.length} candidates`);
  console.log('   at  jumpDb  gapB  burst  beatless  aftConf  aftReg  harshA  dHarsh  flatA   subA');
  for (const t of transitions) {
    console.log(
      clock(t.at).padStart(5) +
        t.input.jumpDb.toFixed(1).padStart(8) +
        t.input.gapBeforeSec.toFixed(2).padStart(6) +
        (t.input.burst ? 'Y' : '.').padStart(7) +
        (t.input.beatless ? 'Y' : '.').padStart(10) +
        t.input.after.beatConf.toFixed(2).padStart(9) +
        t.input.after.regular.toFixed(2).padStart(8) +
        t.input.after.harsh.toFixed(1).padStart(8) +
        t.input.harshDelta.toFixed(2).padStart(8) +
        t.input.after.noise.toFixed(2).padStart(7) +
        t.input.after.sub.toFixed(2).padStart(7),
    );
  }
  const n = Math.max(1, transitions.length);
  console.log(
    `burst ${transitions.filter((t) => t.input.burst).length}/${n}  ` +
      `beatless ${transitions.filter((t) => t.input.beatless).length}/${n}`,
  );
}

/** One client per track, made only when a track is actually going to ask. */
let cached: { key: string; value: JevLike } | null = null;
function client(apiKey: string): JevLike {
  if (cached === null || cached.key !== apiKey) {
    cached = { key: apiKey, value: createJevClient(apiKey) };
  }
  return cached.value;
}

/** The accounting a handler answered with, added to the running totals. */
function add(usage: TokenUsage, json: { usage: { input_tokens: number; output_tokens: number }; latencyMs: number }): void {
  usage.calls += 1;
  usage.input_tokens += json.usage.input_tokens;
  usage.output_tokens += json.usage.output_tokens;
  usage.lastLatencyMs = json.latencyMs;
}

/** What `--dry` answers with: a verdict that claims nothing. */
const NO_VERDICT: TransitionVerdict = {
  kind: 'none',
  kindP: Object.fromEntries(TRANSITION_KINDS.map((k) => [k, k === 'none' ? 1 : 0])) as Record<
    TransitionKind,
    number
  >,
  intensity: 0,
  dramatic: 0,
  release: 0.5,
  confidence: 0,
};

function share(moods: readonly MoodVector[], p: (m: MoodVector) => boolean): number {
  return moods.filter(p).length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const secondsArg = args.find((a) => a.startsWith('--seconds='));
  const seconds = secondsArg === undefined ? undefined : Number(secondsArg.split('=')[1]);
  const dry = args.includes('--dry');
  const ids = args.filter((a) => !a.startsWith('-'));

  const env = readEnvFile(resolve(process.cwd(), '.env'));
  const apiKey = env['TYPESAFE_API_KEY'] ?? process.env['TYPESAFE_API_KEY'] ?? '';
  if (apiKey === '' && !dry) {
    console.error('no TYPESAFE_API_KEY in .env or the environment');
    process.exitCode = 1;
    return;
  }

  for (const id of ids.length > 0 ? ids : DEFAULT_IDS) await run(id, seconds, apiKey, dry);
}

void main();

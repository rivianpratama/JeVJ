/**
 * What the analysis actually measures on real audio:
 * `npx tsx scripts/calibrate/probe-features.ts [id...] [--seconds=N]`
 *
 * The detectors in `src/analysis` were tuned against the synthetic fixtures in
 * `tests/helpers/synth.ts` — AM noise for speech, a click track for a beat, a
 * sawtooth chord for a pad. That is the right way to build them and it is not
 * enough to trust them: the first six real tracks through the app found a TED
 * talk reading `speech` 0.35 and two minutes of continuous screaming reading
 * `harsh` 0.31, which is what a Gymnopédie reads. This is the instrument that
 * says *why*, by sweeping a cached mp4 through the same `FeatureExtractor` +
 * `AnalysisPipeline` the app uses and printing the per-4 s means of every
 * feature the model is shown.
 *
 * No network, no key, no model, and nothing written: just the local DSP, so it
 * can be run as often as a constant is changed. The live half of the
 * calibration is `probe-jev.ts`.
 */

import { resolve } from 'node:path';

import { fftMagnitudes } from '../../src/analysis/fft';
import { FeatureExtractor } from '../../src/analysis/features';
import { AnalysisPipeline } from '../../src/analysis/pipeline';
import { OFFLINE_FFT_SIZE, OFFLINE_HOP_SEC } from '../../src/timeline/offlineAnalyzer';
import { decodeMono, SAMPLE_RATE, TRACKS } from './decode';

/** How much of each track is swept, and the window each row averages over. */
const DEFAULT_SECONDS = 60;
const BUCKET_SEC = 4;

/** The three the speech and scream work is measured against. */
const DEFAULT_IDS = ['Y6bbMQXQ180', '6fVE8kSM43I', '_ovdm2yX4MA'];

/** The fields a row carries, in the order they are printed. */
const FIELDS = [
  'speech',
  'pause',
  'pitchVar',
  'beatConf',
  'regular',
  'vocal',
  'harsh',
  'crest',
  'centroid',
  'onsetsPerSec',
  'flatness',
] as const;
type Field = (typeof FIELDS)[number];

/** One row of the printed table: the means over one bucket. */
export type Bucket = { t: number; n: number } & Record<Field, number>;

function emptyBucket(t: number): Bucket {
  const b = { t, n: 0 } as Bucket;
  for (const f of FIELDS) b[f] = 0;
  return b;
}

/** Sweep `mono` through the real chain and bucket every reading by time. */
export function sweep(mono: Float32Array, sampleRate: number): Bucket[] {
  const hop = Math.max(1, Math.round(OFFLINE_HOP_SEC * sampleRate));
  const extractor = new FeatureExtractor({ sampleRate, fftSize: OFFLINE_FFT_SIZE });
  const pipeline = new AnalysisPipeline();
  const window = new Float32Array(OFFLINE_FFT_SIZE);
  const frames = Math.ceil(mono.length / hop);
  const buckets: Bucket[] = [];

  for (let i = 0; i < frames; i++) {
    fillWindow(window, mono, i * hop);
    const t = (i * hop) / sampleRate;
    const f = extractor.extract(fftMagnitudes(window), window, t);
    const s = pipeline.step(f);

    const index = Math.floor(t / BUCKET_SEC);
    const b = (buckets[index] ??= emptyBucket(index * BUCKET_SEC));
    b.n += 1;
    b.speech += s.speech;
    b.pause += s.pause;
    b.pitchVar += s.pitchVar;
    b.beatConf += s.grid.confidence;
    b.regular += s.rhythm.regular;
    b.vocal += s.vocal;
    b.harsh += s.harsh;
    b.crest += s.dynamics.crest;
    b.centroid += f.centroid;
    b.onsetsPerSec += s.rhythm.onsetsPerSec;
    b.flatness += s.timbre.noise;
  }

  const out: Bucket[] = [];
  for (const b of buckets) {
    if (b === undefined || b.n === 0) continue;
    const mean = { ...b };
    for (const f of FIELDS) mean[f] = b[f] / b.n;
    out.push(mean);
  }
  return out;
}

function fillWindow(out: Float32Array, mono: Float32Array, end: number): void {
  const start = end - out.length;
  for (let j = 0; j < out.length; j++) {
    const at = start + j;
    out[j] = at >= 0 && at < mono.length ? mono[at]! : 0;
  }
}

/** Mean of one field over every bucket, which is the headline number. */
export function mean(buckets: readonly Bucket[], key: Field): number {
  if (buckets.length === 0) return 0;
  let sum = 0;
  for (const b of buckets) sum += b[key];
  return sum / buckets.length;
}

/** Share of buckets whose `key` is at or above `threshold`. */
export function share(buckets: readonly Bucket[], key: Field, threshold: number): number {
  if (buckets.length === 0) return 0;
  let n = 0;
  for (const b of buckets) if (b[key] >= threshold) n += 1;
  return n / buckets.length;
}

/** Column widths, wide enough for the header and for `-0.000`. */
const WIDTH: Record<Field | 't', number> = {
  t: 4,
  speech: 7,
  pause: 6,
  pitchVar: 9,
  beatConf: 9,
  regular: 8,
  vocal: 6,
  harsh: 6,
  crest: 6,
  centroid: 9,
  onsetsPerSec: 6,
  flatness: 9,
};

function header(): string {
  return [
    't'.padStart(WIDTH.t),
    ...FIELDS.map((f) => (f === 'onsetsPerSec' ? 'ons/s' : f).padStart(WIDTH[f])),
  ].join(' ');
}

function row(b: Bucket): string {
  return [
    String(b.t).padStart(WIDTH.t),
    ...FIELDS.map((f) =>
      (f === 'centroid' ? String(Math.round(b[f])) : b[f].toFixed(3)).padStart(WIDTH[f]),
    ),
  ].join(' ');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const secondsArg = args.find((a) => a.startsWith('--seconds='));
  const seconds = secondsArg === undefined ? DEFAULT_SECONDS : Number(secondsArg.split('=')[1]);
  const ids = args.filter((a) => !a.startsWith('-'));
  const wanted = ids.length > 0 ? ids : DEFAULT_IDS;

  for (const id of wanted) {
    const path = resolve(process.cwd(), 'cache', `${id}.mp4`);
    const mono = await decodeMono(path, { seconds });
    const buckets = sweep(mono, SAMPLE_RATE);

    console.log(`\n=== ${id} — ${TRACKS[id] ?? '?'} — first ${seconds}s ===`);
    console.log(header());
    for (const b of buckets) console.log(row(b));
    console.log(
      `mean  speech ${mean(buckets, 'speech').toFixed(3)}` +
        `  pause ${mean(buckets, 'pause').toFixed(3)}` +
        `  pitchVar ${mean(buckets, 'pitchVar').toFixed(3)}` +
        `  harsh ${mean(buckets, 'harsh').toFixed(3)}`,
    );
    console.log(
      `share speech>=0.6 ${(share(buckets, 'speech', 0.6) * 100).toFixed(0)}%` +
        `  speech<=0.25 ${(share(buckets, 'speech', 0.25) * 100).toFixed(0)}% above` +
        `  harsh>=0.6 ${(share(buckets, 'harsh', 0.6) * 100).toFixed(0)}%`,
    );
  }
}

void main();

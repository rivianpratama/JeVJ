/**
 * Cached media in, mono float samples out.
 *
 * The calibration scripts measure the analysis against *real* tracks, and the
 * real tracks are the mp4s already in `cache/`. Decoding them is the one thing
 * Node cannot do by itself, so this shells out to ffmpeg and asks for exactly
 * what `analyzeOffline` wants: one channel, 44.1 kHz, raw 32-bit floats on
 * stdout. No container, no resampler surprises, no temporary files.
 *
 * `FFMPEG` in the environment overrides the binary; the Homebrew path is the
 * default because that is where it lives on the machine this was tuned on.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Where ffmpeg is, unless the environment says otherwise. */
const FFMPEG = process.env['FFMPEG'] ?? '/opt/homebrew/bin/ffmpeg';

/** The rate the app's own analysis assumes; everything is tuned at it. */
export const SAMPLE_RATE = 44100;

export interface DecodeOptions {
  /** Stop after this many seconds of audio. Omit for the whole file. */
  seconds?: number;
  /** Skip this many seconds first. */
  fromSec?: number;
}

/** Mono 44.1 kHz samples from any file ffmpeg can open. */
export async function decodeMono(path: string, o: DecodeOptions = {}): Promise<Float32Array> {
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);

  const args = ['-v', 'error'];
  if (o.fromSec !== undefined) args.push('-ss', String(o.fromSec));
  args.push('-i', path);
  if (o.seconds !== undefined) args.push('-t', String(o.seconds));
  args.push('-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-');

  const chunks: Buffer[] = [];
  const errs: Buffer[] = [];
  const code = await new Promise<number>((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => errs.push(c));
    p.on('error', reject);
    p.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${Buffer.concat(errs).toString()}`);

  const buf = Buffer.concat(chunks);
  // Copy rather than view: a Buffer's byteOffset is rarely 4-aligned, and a
  // Float32Array view demands it.
  const out = new Float32Array(buf.byteLength >> 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** The tracks the tuning notes are written about, by cache id. */
export const TRACKS: Record<string, string> = {
  Y6bbMQXQ180: 'Richard St. John, Secrets of success (speech)',
  '6fVE8kSM43I': 'Slipknot, Duality (metal)',
  _ovdm2yX4MA: 'Avicii, Levels (EDM)',
  '2WfaotSK3mI': 'Satie, Gymnopedie No. 1 (classical)',
  OlaTeXX3uH8: 'Brian Eno, An Ending (Ascent) (ambient)',
  'd-JBBNg8YKs': 'Travis Scott, SICKO MODE (trap)',
};

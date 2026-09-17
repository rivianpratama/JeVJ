/**
 * The real yt-dlp process, which is the only thing in the download path that
 * cannot be tested.
 *
 * It is one function on purpose: everything above it — what to run, what the
 * output means, what a failure may say — is in `job.ts` and `parseProgress.ts`
 * against a canned transcript, and everything here is `child_process.spawn`
 * with its two streams cut into lines.
 */

import { spawn } from 'node:child_process';

import { LineSplitter } from './parseProgress';
import type { Spawner } from './job';

export function nodeSpawner(): Spawner {
  return (cmd, args, hooks, signal) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      pipeLines(child.stdout, (line) => hooks.stdout(line));
      pipeLines(child.stderr, (line) => hooks.stderr(line));

      // The caller's stall watchdog. `kill` is a signal, not a guarantee, so
      // nothing here resolves the promise: the process exits and `close` does
      // it, which keeps one exit path rather than two.
      const kill = (): void => void child.kill();
      signal?.addEventListener('abort', kill, { once: true });

      const done = (): void => signal?.removeEventListener('abort', kill);

      // A binary that is not there fails here rather than with an exit code,
      // and the job turns it into a message.
      child.on('error', (err) => {
        done();
        reject(err);
      });
      child.on('close', (code) => {
        done();
        resolve(code ?? 1);
      });
    });
}

type Stream = NodeJS.ReadableStream | null;

function pipeLines(stream: Stream, onLine: (line: string) => void): void {
  if (stream === null) return;
  const split = new LineSplitter();
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    for (const line of split.push(chunk)) onLine(line);
  });
  stream.on('end', () => {
    for (const line of split.flush()) onLine(line);
  });
}

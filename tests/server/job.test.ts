import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobRunner, type SpawnHooks } from '../../server/ytdlp/job';

const ID = 'jNQXAC9IVRw';

/** The info line yt-dlp prints for `--print-json`, trimmed to what we read. */
const INFO_LINE = JSON.stringify({
  id: ID,
  title: 'Me at the zoo',
  duration: 19,
  ext: 'mp4',
  formats: [{ format_id: '233' }],
});

/**
 * Real `yt-dlp --newline --progress --print-json` output for a two-format
 * download, in the order it actually arrives: the info line first, then one
 * run of progress per format.
 */
const CANNED = [
  INFO_LINE,
  '[download]   0.5% of  218.53KiB at  Unknown B/s ETA Unknown',
  '[download]  58.1% of  218.53KiB at    1.69MiB/s ETA 00:00',
  '[download] 100.0% of  218.53KiB at    2.12MiB/s ETA 00:00',
  '[download] 100% of  218.53KiB in 00:00:00 at 1.43MiB/s',
  '[download]   0.3% of  302.04KiB at  687.70KiB/s ETA 00:00',
  '[download]  84.4% of  302.04KiB at    1.80MiB/s ETA 00:00',
  '[download] 100% of  302.04KiB in 00:00:00 at 1.29MiB/s',
];

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jevj-job-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A spawner that replays canned lines and then leaves the file behind. */
function fakeSpawn(options: {
  stdout?: string[];
  stderr?: string[];
  exit?: number;
  writesFile?: boolean;
  calls?: { cmd: string; args: string[] }[];
  onProgress?: (percent: number) => void;
}) {
  return async (cmd: string, args: string[], hooks: SpawnHooks): Promise<number> => {
    options.calls?.push({ cmd, args });
    // A real process says nothing in the tick that started it.
    await Promise.resolve();
    for (const line of options.stdout ?? []) {
      hooks.stdout(line);
      options.onProgress?.(0);
      await Promise.resolve();
    }
    for (const line of options.stderr ?? []) hooks.stderr(line);
    if (options.writesFile ?? true) writeFileSync(join(dir, `${ID}.mp4`), 'video bytes');
    return options.exit ?? 0;
  };
}

describe('JobRunner, cache hit', () => {
  it('is done before it starts, and never spawns', async () => {
    writeFileSync(join(dir, `${ID}.mp4`), 'video bytes');
    writeFileSync(join(dir, `${ID}.info.json`), JSON.stringify({ title: 'Me at the zoo', durationSec: 19 }));
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new JobRunner(dir, fakeSpawn({ calls }));

    const job = runner.start(ID);

    expect(job.status).toBe('done');
    expect(job.percent).toBe(100);
    expect(job.mediaUrl).toBe(`/media/${ID}.mp4`);
    expect(job.title).toBe('Me at the zoo');
    expect(job.durationSec).toBe(19);
    expect(calls).toEqual([]);
  });

  it('is done without a title when no sidecar was written', () => {
    writeFileSync(join(dir, `${ID}.mp4`), 'video bytes');
    const runner = new JobRunner(dir, fakeSpawn({}));
    const job = runner.start(ID);
    expect(job.status).toBe('done');
    expect(job.title).toBeUndefined();
  });
});

describe('JobRunner, download', () => {
  it('starts queued and reports the id it was given', () => {
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED }));
    const job = runner.start(ID);
    expect(job.videoId).toBe(ID);
    expect(job.status).toBe('queued');
    expect(job.percent).toBe(0);
  });

  it('ends done with the title and duration off the info line', async () => {
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED }));
    runner.start(ID);

    const job = await runner.settled(ID);

    expect(job?.status).toBe('done');
    expect(job?.percent).toBe(100);
    expect(job?.title).toBe('Me at the zoo');
    expect(job?.durationSec).toBe(19);
    expect(job?.mediaUrl).toBe(`/media/${ID}.mp4`);
    expect(job?.error).toBeUndefined();
  });

  it('writes the sidecar so the next run does not need yt-dlp to know the title', async () => {
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED }));
    runner.start(ID);
    await runner.settled(ID);

    expect(JSON.parse(readFileSync(join(dir, `${ID}.info.json`), 'utf8'))).toEqual({
      title: 'Me at the zoo',
      durationSec: 19,
    });
  });

  it('never lets the percentage go backwards between the two formats', async () => {
    const seen: number[] = [];
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED }));
    const job = runner.start(ID);
    const tick = setInterval(() => seen.push(job.percent), 0);
    await runner.settled(ID);
    clearInterval(tick);

    expect(job.percent).toBe(100);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('runs yt-dlp with the cache directory as its output template', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED, calls }), '/opt/bin/yt-dlp');
    runner.start(ID);
    await runner.settled(ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('/opt/bin/yt-dlp');
    const args = calls[0]?.args ?? [];
    expect(args).toContain('--newline');
    expect(args).toContain('--print-json');
    expect(args).toContain('--no-playlist');
    expect(args[args.indexOf('-o') + 1]).toBe(join(dir, '%(id)s.%(ext)s'));
    expect(args.at(-1)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it('runs one process per video, however many times it is asked', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED, calls }));
    const first = runner.start(ID);
    const second = runner.start(ID);

    expect(second).toBe(first);
    await runner.settled(ID);
    expect(calls).toHaveLength(1);
  });

  it('hands out the finished job again rather than downloading twice', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED, calls }));
    runner.start(ID);
    await runner.settled(ID);

    expect(runner.start(ID).status).toBe('done');
    expect(calls).toHaveLength(1);
  });

  it('finds the job by id', async () => {
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED }));
    const job = runner.start(ID);
    expect(runner.get(job.id)).toBe(job);
    expect(runner.get('nope')).toBeUndefined();
  });
});

describe('JobRunner, failure', () => {
  it('reports the last error line yt-dlp printed', async () => {
    const runner = new JobRunner(
      dir,
      fakeSpawn({
        stderr: [
          'WARNING: [youtube] falling back to the generic n function search',
          'ERROR: [youtube] jNQXAC9IVRw: Video unavailable',
        ],
        exit: 1,
        writesFile: false,
      }),
    );
    runner.start(ID);

    const job = await runner.settled(ID);

    expect(job?.status).toBe('error');
    expect(job?.error).toBe('[youtube] jNQXAC9IVRw: Video unavailable');
    expect(job?.mediaUrl).toBeUndefined();
  });

  it('keeps the file system out of the message', async () => {
    const runner = new JobRunner(
      dir,
      fakeSpawn({
        stderr: [`ERROR: unable to open for writing: ${join(dir, `${ID}.f233.mp4.part`)}: permission denied`],
        exit: 1,
        writesFile: false,
      }),
    );
    runner.start(ID);

    const job = await runner.settled(ID);

    expect(job?.error).not.toContain(dir);
    expect(job?.error).not.toContain('/');
    expect(job?.error).toContain('permission denied');
  });

  it('says something rather than nothing when yt-dlp fails silently', async () => {
    const runner = new JobRunner(dir, fakeSpawn({ exit: 2, writesFile: false }));
    runner.start(ID);
    const job = await runner.settled(ID);
    expect(job?.status).toBe('error');
    expect(job?.error).toBe('download failed');
  });

  it('fails when the process succeeds but leaves no file', async () => {
    const runner = new JobRunner(dir, fakeSpawn({ stdout: CANNED, writesFile: false }));
    runner.start(ID);
    const job = await runner.settled(ID);
    expect(job?.status).toBe('error');
    expect(job?.error).toBe('download produced no file');
  });

  it('turns a spawn that never ran into an error, not a crash', async () => {
    const runner = new JobRunner(dir, async () => {
      throw new Error(`spawn ${join(dir, 'yt-dlp')} ENOENT`);
    });
    runner.start(ID);
    const job = await runner.settled(ID);
    expect(job?.status).toBe('error');
    expect(job?.error).not.toContain(dir);
  });

  it('lets a failed video be tried again', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const failing = new JobRunner(dir, fakeSpawn({ exit: 1, writesFile: false, calls }));
    failing.start(ID);
    await failing.settled(ID);

    const retry = failing.start(ID);

    expect(retry.status).not.toBe('error');
    await failing.settled(ID);
    expect(calls).toHaveLength(2);
  });

  it('refuses an id that is not a video id', () => {
    const runner = new JobRunner(dir, fakeSpawn({}));
    expect(() => runner.start('../../etc/passwd')).toThrow();
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JobRunner,
  STALL_MESSAGE,
  STALL_TIMEOUT_MS,
  type Spawner,
  type SpawnHooks,
} from '../../server/ytdlp/job';

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

describe('JobRunner, concurrency', () => {
  /** Eleven-character ids that differ, so each is its own job. */
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'];

  /**
   * A spawner that blocks until the test lets it finish, so the number of
   * processes actually in flight is observable.
   */
  function heldSpawn(): {
    spawn: (cmd: string, args: string[], hooks: SpawnHooks) => Promise<number>;
    running: string[];
    finish: (id: string) => void;
  } {
    const running: string[] = [];
    const gates = new Map<string, () => void>();
    return {
      running,
      finish: (id) => gates.get(id)?.(),
      spawn: async (_cmd, args, _hooks) => {
        const id = ids.find((x) => args.some((a) => a.includes(x))) ?? '?';
        running.push(id);
        await new Promise<void>((resolve) => gates.set(id, resolve));
        writeFileSync(join(dir, `${id}.mp4`), 'video bytes');
        return 0;
      },
    };
  }

  it('runs at most two downloads at once and queues the rest', async () => {
    const held = heldSpawn();
    const runner = new JobRunner(dir, held.spawn);

    const states = ids.slice(0, 3).map((id) => runner.start(id));
    await tick();

    expect(held.running).toEqual([ids[0], ids[1]]);
    expect(states[2]?.status).toBe('queued');

    held.finish(ids[0]!);
    await tick();
    expect(held.running).toEqual([ids[0], ids[1], ids[2]]);

    held.finish(ids[1]!);
    held.finish(ids[2]!);
    await runner.settled(ids[2]!);
    expect(runner.get(ids[2]!)?.status).toBe('done');
  });

  it('frees the slot even when the spawn itself throws', async () => {
    let calls = 0;
    const runner = new JobRunner(
      dir,
      async () => {
        calls += 1;
        throw new Error('no yt-dlp on this machine');
      },
      'yt-dlp',
      1,
    );

    runner.start(ids[0]!);
    runner.start(ids[1]!);
    await runner.settled(ids[0]!);
    await runner.settled(ids[1]!);

    expect(calls).toBe(2);
    expect(runner.get(ids[1]!)?.status).toBe('error');
  });
});

/** Let every already-resolved promise in the queue run. */
async function tick(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/* ----------------------------------------------------------- stall watchdog */

/** A second real video id, for the job that has to get the stalled one's slot. */
const OTHER_ID = 'dQw4w9WgXcQ';

/**
 * A yt-dlp that says what it is told to and otherwise sits there forever.
 *
 * `say` is the test's hand on the process's stdout, and the only thing that
 * ever ends it is the watchdog's signal — which is exactly a wedged download:
 * the socket is gone, the process is alive, and nothing will ever arrive.
 */
function wedgedSpawn(): {
  spawn: Spawner;
  say: (line: string) => void;
  started: () => boolean;
  killed: () => boolean;
} {
  let out: ((line: string) => void) | null = null;
  let killed = false;
  return {
    started: () => out !== null,
    killed: () => killed,
    say: (line) => out?.(line),
    spawn: (_cmd, _args, hooks, signal) =>
      new Promise<number>((resolve) => {
        out = hooks.stdout;
        signal?.addEventListener('abort', () => {
          killed = true;
          // A killed child exits non-zero with nothing on stderr.
          resolve(1);
        });
      }),
  };
}

describe('JobRunner, stall watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills a download that has said nothing for three minutes, and says so', async () => {
    const wedged = wedgedSpawn();
    const runner = new JobRunner(dir, wedged.spawn);
    const job = runner.start(ID);

    await vi.advanceTimersByTimeAsync(0);
    wedged.say(INFO_LINE);
    wedged.say('[download]  12.0% of  218.53KiB at    1.69MiB/s ETA 00:02');
    expect(job.status).toBe('downloading');

    // A minute short of the timeout it is still a download, not a casualty.
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 60_000);
    expect(wedged.killed()).toBe(false);
    expect(job.status).toBe('downloading');

    await vi.advanceTimersByTimeAsync(61_000);
    const settled = await runner.settled(ID);
    expect(wedged.killed()).toBe(true);
    expect(settled?.status).toBe('error');
    // Not 'download failed': a killed process exits non-zero with an empty
    // stderr, and the reason it exited is the thing worth reporting.
    expect(settled?.error).toBe(STALL_MESSAGE);
    expect(settled?.mediaUrl).toBeUndefined();
  });

  it('restarts the clock on every line, so a slow download is not a stalled one', async () => {
    const wedged = wedgedSpawn();
    const runner = new JobRunner(dir, wedged.spawn);
    runner.start(ID);
    await vi.advanceTimersByTimeAsync(0);

    // Four progress lines, each arriving with a minute to spare. A deadline
    // rather than a silence timeout would have killed this at three minutes.
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 60_000);
      wedged.say(`[download]  ${i * 20}.0% of  218.53KiB at  600.00KiB/s ETA 00:30`);
      expect(wedged.killed(), `after line ${i}`).toBe(false);
    }
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1);
    expect(wedged.killed()).toBe(true);
  });

  it('gives the slot back, so the job queued behind it runs', async () => {
    // The whole point of killing it. One wedged download holding one of the two
    // slots for the life of the server is the failure; holding it for three
    // minutes is merely a wait.
    const wedged = wedgedSpawn();
    const next = wedgedSpawn();
    let first = true;
    const spawn: Spawner = (cmd, args, hooks, signal) => {
      const which = first ? wedged : next;
      first = false;
      return which.spawn(cmd, args, hooks, signal);
    };

    const runner = new JobRunner(dir, spawn, 'yt-dlp', 1);
    runner.start(ID);
    const queued = runner.start(OTHER_ID);
    await vi.advanceTimersByTimeAsync(0);

    expect(queued.status).toBe('queued');
    expect(next.started()).toBe(false);

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 1);
    expect((await runner.settled(ID))?.error).toBe(STALL_MESSAGE);
    expect(next.started()).toBe(true);
  });
});

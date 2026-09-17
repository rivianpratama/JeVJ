/**
 * One download per video, watched from the outside.
 *
 * The browser cannot decode a YouTube stream, so v2 downloads the track first
 * and serves it back from the cache. That takes long enough that the request
 * that asks for it cannot wait: `start` returns a job immediately and the
 * client polls it. Everything that is a judgement — when a job is done, what a
 * failure is allowed to say, how two files of one video add up to a single
 * percentage — lives here, and the process itself arrives as a `Spawner` so
 * all of it can be tested against a canned yt-dlp transcript.
 *
 * Jobs are keyed by video id: asking twice for the same video joins the
 * download already running rather than starting a second yt-dlp on the same
 * output file.
 */

import { parseProgressLine } from './parseProgress';
import { cachedInfo, cachedMedia, isVideoId, writeInfo } from './cache';
import { join } from 'node:path';

export type JobStatus = 'queued' | 'downloading' | 'done' | 'error';

export interface JobState {
  id: string;
  videoId: string;
  status: JobStatus;
  /** 0–100 across the whole download, never decreasing. */
  percent: number;
  title?: string;
  durationSec?: number;
  /** Where the browser can fetch the file; only set once `status` is `done`. */
  mediaUrl?: string;
  /** Only set once `status` is `error`. Never names a file on this machine. */
  error?: string;
}

/** The two streams a spawned process talks on, one line at a time. */
export interface SpawnHooks {
  stdout(line: string): void;
  stderr(line: string): void;
}

/**
 * Runs a command to completion and resolves with its exit code.
 *
 * `signal` is how the caller stops one: aborting it kills the process, which
 * then settles the promise the way any other early exit does. It is optional so
 * that a spawner that cannot be interrupted is still a spawner — the watchdog
 * simply never lands.
 */
export type Spawner = (
  cmd: string,
  args: string[],
  hooks: SpawnHooks,
  signal?: AbortSignal,
) => Promise<number>;

/**
 * How long yt-dlp may say nothing at all before it is considered wedged.
 *
 * It is a *silence* timeout, not a deadline: a two-hour set downloading at
 * 200 kB/s prints a progress line every few hundred milliseconds and never goes
 * near this, while a process whose socket died holds its slot — one of two —
 * until the server restarts. Three minutes is long enough to cover the quiet
 * stretches yt-dlp does have (resolving formats, and the ffmpeg merge at the
 * end, which announces itself on stdout but then works in silence) and short
 * enough that a wedged download is not an afternoon.
 */
export const STALL_TIMEOUT_MS = 3 * 60 * 1000;

/** What a download that said nothing for `STALL_TIMEOUT_MS` reports. */
export const STALL_MESSAGE = 'download stalled';

/**
 * The format we ask for: 720p mp4 video plus m4a audio, merged — small enough
 * to download in seconds and a container every browser can decode.
 *
 * `--progress` is not decoration: `--print-json` quietens the console, and
 * without it no progress line is printed at all. `--newline` keeps each update
 * on its own line rather than rewriting one with carriage returns.
 */
const FORMAT = 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';

/**
 * How many files the format above makes yt-dlp fetch. The count is not printed
 * before the download starts, and the percentage restarts at zero for each, so
 * a two-file assumption is what turns two runs of 0–100 into one honest bar.
 * A single-file fallback simply finishes early, which the exit handles.
 */
const EXPECTED_FILES = 2;

/** Nothing in a message we hand a client may name a file on this machine. */
const PATHS = /(?:[A-Za-z]:)?(?:\/[^\s"']*)+/g;
const MAX_ERROR_CHARS = 200;

export function ytdlpArgs(cacheDir: string, videoId: string): string[] {
  return [
    '-f',
    FORMAT,
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '--newline',
    '--progress',
    '--print-json',
    '-o',
    join(cacheDir, '%(id)s.%(ext)s'),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

interface Job {
  state: JobState;
  settled: Promise<JobState>;
}

/**
 * How many yt-dlp processes may run at once.
 *
 * Each one is a process, two sockets and a few hundred megabytes a minute of
 * disk, and one paste is one job: a page that fires twenty resolves — or a
 * person who pastes ten links — should queue behind two rather than fork
 * twenty. The extra jobs exist immediately and honestly report `queued`, which
 * is a status the client already knows how to poll.
 */
export const MAX_RUNNING_JOBS = 2;

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  /** Videos with a yt-dlp actually running, so the cap counts processes. */
  private running = 0;
  /** Jobs waiting for a slot, in the order they were asked for. */
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly cacheDir: string,
    private readonly spawn: Spawner,
    private readonly binary = 'yt-dlp',
    private readonly maxRunning = MAX_RUNNING_JOBS,
  ) {}

  /**
   * The job for a video, starting one if there is not already a good one.
   *
   * A running or finished job is handed back as it is. A failed one is thrown
   * away, so asking again is a retry — a video that failed because the network
   * blinked should not stay broken for the life of the server.
   */
  start(videoId: string): JobState {
    if (!isVideoId(videoId)) throw new Error('not a video id');

    const existing = this.jobs.get(videoId);
    if (existing !== undefined && existing.state.status !== 'error') return existing.state;

    const state: JobState = { id: videoId, videoId, status: 'queued', percent: 0 };

    const cached = cachedMedia(this.cacheDir, videoId);
    if (cached !== null) {
      this.finish(state);
      this.jobs.set(videoId, { state, settled: Promise.resolve(state) });
      return state;
    }

    const settled = this.run(state);
    this.jobs.set(videoId, { state, settled });
    return state;
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id)?.state;
  }

  /**
   * The job once it has stopped moving. The HTTP layer polls instead — this is
   * for tests, and for anything that legitimately wants to wait.
   */
  async settled(id: string): Promise<JobState | undefined> {
    return await this.jobs.get(id)?.settled;
  }

  /**
   * Waits for a slot, then runs yt-dlp and folds its output into the job as it
   * arrives.
   *
   * The wait is the whole of the concurrency cap. A job that is waiting has
   * already been created and already been handed to the client — it simply
   * stays `queued`, which is what that status means — and the slot is released
   * in a `finally` so a spawn that threw cannot wedge the queue.
   */
  private async run(state: JobState): Promise<JobState> {
    await this.acquire();
    try {
      return await this.download(state);
    } finally {
      this.release();
    }
  }

  /** Resolves when fewer than `maxRunning` downloads are in flight. */
  private acquire(): Promise<void> {
    if (this.running < this.maxRunning) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }

  private async download(state: JobState): Promise<JobState> {
    const errors: string[] = [];
    let filesDone = 0;

    // The stall watchdog. Every line yt-dlp writes to stdout is a sign of life
    // — the progress lines are the overwhelming majority of them — so the timer
    // is restarted on each one and only ever fires when the process has gone
    // quiet altogether. It starts here rather than in `start`, so a job still
    // queued behind the concurrency cap is not timed out for waiting.
    const stopper = new AbortController();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const alive = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        stopper.abort();
      }, STALL_TIMEOUT_MS);
    };

    const onStdout = (line: string): void => {
      alive();
      // `queued` lasts until yt-dlp says something: resolving a video takes a
      // second or two before a single byte of media is fetched, and a bar that
      // sits at zero says less than a status that admits it has not started.
      if (state.status === 'queued') state.status = 'downloading';
      const info = parseInfoLine(line);
      if (info !== null) {
        if (info.title !== undefined) state.title = info.title;
        if (info.durationSec !== undefined) state.durationSec = info.durationSec;
        return;
      }
      const event = parseProgressLine(line);
      if (event === null) return;
      if (event.kind === 'fileDone') filesDone += 1;
      else if (event.kind === 'percent') this.advance(state, filesDone, event.percent);
      else if (event.kind === 'done') filesDone = EXPECTED_FILES;
    };

    let code: number;
    alive();
    try {
      code = await this.spawn(
        this.binary,
        ytdlpArgs(this.cacheDir, state.videoId),
        {
          stdout: onStdout,
          // yt-dlp puts its warnings and its one fatal line on stderr; only the
          // last of them is ever shown, and only if the process fails.
          stderr: (line) => void errors.push(line),
        },
        stopper.signal,
      );
    } catch (err) {
      // A killed process may reject rather than resolve, and a stall is a
      // stall whichever way it came back.
      if (stalled) return this.fail(state, STALL_MESSAGE);
      // The process never ran: a missing binary, usually.
      return this.fail(state, sanitize(err instanceof Error ? err.message : String(err)));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    // Before the exit code, because a killed process exits non-zero with
    // nothing on stderr and would otherwise report 'download failed'.
    if (stalled) return this.fail(state, STALL_MESSAGE);
    if (code !== 0) return this.fail(state, describe(errors));
    if (cachedMedia(this.cacheDir, state.videoId) === null) {
      return this.fail(state, 'download produced no file');
    }

    writeInfo(this.cacheDir, state.videoId, {
      ...(state.title === undefined ? {} : { title: state.title }),
      ...(state.durationSec === undefined ? {} : { durationSec: state.durationSec }),
    });
    this.finish(state);
    return state;
  }

  /** Moves the bar, never backwards, and never to 100 before the file is there. */
  private advance(state: JobState, filesDone: number, percentOfFile: number): void {
    const overall = ((filesDone + percentOfFile / 100) / EXPECTED_FILES) * 100;
    state.percent = Math.max(state.percent, Math.min(99, Math.round(overall * 10) / 10));
  }

  private finish(state: JobState): void {
    const info = cachedInfo(this.cacheDir, state.videoId);
    if (state.title === undefined && info?.title !== undefined) state.title = info.title;
    if (state.durationSec === undefined && info?.durationSec !== undefined) state.durationSec = info.durationSec;
    state.status = 'done';
    state.percent = 100;
    state.mediaUrl = `/media/${state.videoId}.mp4`;
    delete state.error;
  }

  private fail(state: JobState, message: string): JobState {
    state.status = 'error';
    state.error = message;
    delete state.mediaUrl;
    return state;
  }
}

/**
 * The `--print-json` line, which is the only stdout line that is JSON and is
 * hundreds of kilobytes of format descriptions we have no use for. Title and
 * duration are all we take.
 */
function parseInfoLine(line: string): { title?: string; durationSec?: number } | null {
  if (!line.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw['id'] !== 'string') return null;
  const out: { title?: string; durationSec?: number } = {};
  if (typeof raw['title'] === 'string') out.title = raw['title'];
  if (typeof raw['duration'] === 'number' && Number.isFinite(raw['duration'])) out.durationSec = raw['duration'];
  return out;
}

/** What a failed download is allowed to say. */
function describe(errorLines: string[]): string {
  const fatal = [...errorLines].reverse().find((line) => line.startsWith('ERROR:'));
  const last = fatal ?? [...errorLines].reverse().find((line) => line.trim() !== '');
  return last === undefined ? 'download failed' : sanitize(last);
}

function sanitize(line: string): string {
  const message = line.replace(/^\s*(?:ERROR|WARNING):\s*/, '').replace(PATHS, '<path>').trim();
  if (message === '') return 'download failed';
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…` : message;
}

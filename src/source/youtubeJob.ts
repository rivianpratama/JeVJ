/**
 * The browser side of a download: one link in, one playable file out.
 *
 * v2 analyses the audio itself, which means it has to have the audio: the
 * server downloads the track and serves it back. That is a job rather than a request — it takes seconds, and
 * the page has a progress caption to fill while it runs — so this is the one
 * place that knows the job protocol: resolve the link, poll the job, hand back
 * something a `<video>` can load.
 *
 * `fetch` and the wait between polls are arguments so the whole thing can be
 * driven in a test at full speed with no server running.
 */

export type JobStatus = 'queued' | 'downloading' | 'done' | 'error';

/** The server's job, as it comes over the wire. */
export interface JobState {
  id: string;
  videoId: string;
  status: JobStatus;
  /** 0–100 across the whole download. */
  percent: number;
  title?: string;
  durationSec?: number;
  mediaUrl?: string;
  error?: string;
}

export interface ResolvedMedia {
  /** A URL this origin serves; a `<video>` can use it directly. */
  mediaUrl: string;
  title: string;
  durationSec: number;
}

/** Slow enough to be nothing, often enough that a bar does not look stuck. */
const POLL_MS = 500;

/** A download that has not finished in this long is not going to. */
const MAX_POLLS = (20 * 60 * 1000) / POLL_MS;

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function resolveYouTube(
  url: string,
  onProgress: (job: JobState) => void,
  fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<ResolvedMedia> {
  const started = await fetchFn('/api/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const accepted = (await readJson(started)) as { jobId?: unknown; error?: unknown };
  if (!started.ok || typeof accepted.jobId !== 'string') {
    throw new Error(typeof accepted.error === 'string' ? accepted.error : 'could not start the download');
  }

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    // The first poll goes out at once: a track already in the cache is done
    // before it is asked about, and waiting half a second to find that out is
    // half a second of a blank screen.
    if (poll > 0) await sleep(POLL_MS);

    const res = await fetchFn(`/api/job/${encodeURIComponent(accepted.jobId)}`);
    if (!res.ok) throw new Error('the download stopped answering');
    const job = (await readJson(res)) as JobState;
    onProgress(job);

    if (job.status === 'error') throw new Error(job.error ?? 'the download failed');
    if (job.status === 'done') {
      if (typeof job.mediaUrl !== 'string') throw new Error('the download finished with no file');
      return {
        mediaUrl: job.mediaUrl,
        // A missing title costs a caption, not a playback; a missing duration
        // is read off the media element once it loads.
        title: job.title ?? '',
        durationSec: job.durationSec ?? 0,
      };
    }
  }
  throw new Error('the download took too long');
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

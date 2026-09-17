/**
 * What one line of yt-dlp's console output means, and nothing else.
 *
 * yt-dlp is a moving target: its flags change between releases and its
 * messages are meant for a human. Everything we are willing to believe about
 * that output is stated here, as a pure function over one line, so the job
 * runner can be tested against canned transcripts and so a future yt-dlp that
 * words something differently breaks one small test rather than a download.
 *
 * Recorded from `yt-dlp 2026.08.19 --newline --progress --print-json`:
 *
 *     {"id": "jNQXAC9IVRw", "title": "Me at the zoo", ...}
 *     [download]   0.5% of  218.53KiB at  Unknown B/s ETA Unknown
 *     [download] 100.0% of  218.53KiB at    2.12MiB/s ETA 00:00
 *     [download] 100% of  218.53KiB in 00:00:00 at 1.43MiB/s
 *
 * The percentage restarts at zero for each file of a video+audio pair, and the
 * summary line — the one that says "in" where a progress line says "ETA" — is
 * how we know one file ended. `--print-json` quietens the `Destination:` and
 * `[Merger]` lines, but older versions and single-format downloads still print
 * them, so they are read too.
 */

export type ProgressEvent =
  /** A percentage of the file currently downloading, 0–100. */
  | { kind: 'percent'; percent: number }
  /** A file has started; the path is yt-dlp's, not necessarily the final one. */
  | { kind: 'fileStart'; path: string }
  /** One file of the download finished. */
  | { kind: 'fileDone' }
  /** The whole download finished, and this is the file it left behind. */
  | { kind: 'done'; path: string };

/** `[download]  37.2% of  218.53KiB at  999.23KiB/s ETA 00:01` */
const PERCENT = /^\[download\]\s+(\d+(?:\.\d+)?)% of\s/;
/** `[download] 100% of  218.53KiB in 00:00:00 at 1.43MiB/s` */
const FILE_DONE = /^\[download\]\s+\d+(?:\.\d+)?% of\s.*\sin\s/;
/** `[download] Destination: cache/jNQXAC9IVRw.f233.mp4` */
const DESTINATION = /^\[download\] Destination:\s*(.+)$/;
/** `[Merger] Merging formats into "cache/jNQXAC9IVRw.mp4"` */
const MERGED = /^\[Merger\] Merging formats into "(.+)"\s*$/;
/** `[download] cache/jNQXAC9IVRw.mp4 has already been downloaded` */
const ALREADY = /^\[download\] (.+) has already been downloaded/;

export function parseProgressLine(line: string): ProgressEvent | null {
  const merged = MERGED.exec(line);
  if (merged?.[1] !== undefined) return { kind: 'done', path: merged[1] };

  const already = ALREADY.exec(line);
  if (already?.[1] !== undefined) return { kind: 'done', path: already[1] };

  const destination = DESTINATION.exec(line);
  if (destination?.[1] !== undefined) return { kind: 'fileStart', path: destination[1].trim() };

  // Order matters: the summary line also carries a percentage, and it is the
  // "in <elapsed>" rather than "ETA <remaining>" that tells the two apart.
  if (FILE_DONE.test(line)) return { kind: 'fileDone' };

  const percent = PERCENT.exec(line);
  if (percent?.[1] !== undefined) return { kind: 'percent', percent: Number(percent[1]) };

  return null;
}

/**
 * Turns a stream of chunks into lines.
 *
 * `--newline` asks yt-dlp for one line per progress update, but a chunk can
 * still split a line in half, and without that flag — or from ffmpeg, which we
 * do not control — progress arrives as carriage returns rewriting one line. A
 * `\r` is treated as a line ending so those updates are not lost in a chunk
 * that never sees a `\n`.
 */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const parts = text.split(/\r\n|\r|\n/);
    // Whatever followed the last separator is not a line yet.
    this.rest = parts.pop() ?? '';
    return parts.filter((line) => line !== '');
  }

  /** The unterminated tail, once the stream has closed. */
  flush(): string[] {
    const rest = this.rest;
    this.rest = '';
    return rest === '' ? [] : [rest];
  }
}

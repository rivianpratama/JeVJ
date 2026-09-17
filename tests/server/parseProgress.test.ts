import { describe, expect, it } from 'vitest';

import { LineSplitter, parseProgressLine } from '../../server/ytdlp/parseProgress';

describe('parseProgressLine', () => {
  it('reads the percentage off a download line', () => {
    expect(parseProgressLine('[download]  37.2% of  218.53KiB at  999.23KiB/s ETA 00:01')).toEqual({
      kind: 'percent',
      percent: 37.2,
    });
    expect(parseProgressLine('[download]   0.5% of  218.53KiB at  Unknown B/s ETA Unknown')).toEqual({
      kind: 'percent',
      percent: 0.5,
    });
    expect(parseProgressLine('[download] 100.0% of  302.04KiB at    2.08MiB/s ETA 00:00')).toEqual({
      kind: 'percent',
      percent: 100,
    });
  });

  it('tells a finished file apart from a progress update', () => {
    // The summary line says "in <elapsed>" where a progress line says "ETA".
    expect(parseProgressLine('[download] 100% of  218.53KiB in 00:00:00 at 1.43MiB/s')).toEqual({
      kind: 'fileDone',
    });
  });

  it('notices a file starting', () => {
    expect(parseProgressLine('[download] Destination: cache/jNQXAC9IVRw.f233.mp4')).toEqual({
      kind: 'fileStart',
      path: 'cache/jNQXAC9IVRw.f233.mp4',
    });
  });

  it('treats a merge as the whole download being done', () => {
    expect(parseProgressLine('[Merger] Merging formats into "cache/jNQXAC9IVRw.mp4"')).toEqual({
      kind: 'done',
      path: 'cache/jNQXAC9IVRw.mp4',
    });
  });

  it('treats an already-downloaded file as done', () => {
    expect(parseProgressLine('[download] cache/jNQXAC9IVRw.mp4 has already been downloaded')).toEqual({
      kind: 'done',
      path: 'cache/jNQXAC9IVRw.mp4',
    });
  });

  it('ignores everything else, JSON included', () => {
    expect(parseProgressLine('[youtube] jNQXAC9IVRw: Downloading webpage')).toBeNull();
    expect(parseProgressLine('{"id": "jNQXAC9IVRw", "title": "Me at the zoo"}')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine('[download] Resuming download at byte 1024')).toBeNull();
  });

  it('does not mistake a percentage inside a title for progress', () => {
    expect(parseProgressLine('[info] 50% off: Downloading 1 format(s): 233+234')).toBeNull();
  });
});

describe('LineSplitter', () => {
  it('splits on newlines and keeps the remainder for the next chunk', () => {
    const split = new LineSplitter();
    expect(split.push('[download]   1.0% of 1MiB\n[download]   2.0')).toEqual(['[download]   1.0% of 1MiB']);
    expect(split.push('% of 1MiB\n')).toEqual(['[download]   2.0% of 1MiB']);
    expect(split.flush()).toEqual([]);
  });

  it('splits carriage-return progress updates too', () => {
    const split = new LineSplitter();
    expect(split.push('[download]   1.0%\r[download]   2.0%\r\n[download]   3.0%\n')).toEqual([
      '[download]   1.0%',
      '[download]   2.0%',
      '[download]   3.0%',
    ]);
  });

  it('flushes a trailing line that never got its newline', () => {
    const split = new LineSplitter();
    expect(split.push('ERROR: nope')).toEqual([]);
    expect(split.flush()).toEqual(['ERROR: nope']);
    expect(split.flush()).toEqual([]);
  });
});

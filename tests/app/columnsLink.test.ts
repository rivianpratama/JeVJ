import { ANALYSIS_VERSION } from '../../src/shared/moodSchema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createColumnsLink, splitLog } from '../../src/app/columnsLink';
import type { ColumnEntry, JsonColumns } from '../../src/ui/jsonColumns';
import type { TrackAnalysis } from '../../src/shared/types';

/** The columns, recording what they were told rather than drawing anything. */
function fakeColumns(): JsonColumns & {
  calls: { set: Array<[number, number, number]>; visible: boolean[]; frames: number[] };
} {
  const calls = { set: [] as Array<[number, number, number]>, visible: [] as boolean[], frames: [] as number[] };
  return {
    calls,
    set(left: readonly ColumnEntry[], right: readonly ColumnEntry[], duration: number): void {
      calls.set.push([left.length, right.length, duration]);
    },
    frame(t: number): void {
      calls.frames.push(t);
    },
    setVisible(on: boolean): void {
      calls.visible.push(on);
    },
    dispose(): void {},
  };
}

/** A record with one question and one answer in it, so there is something to clear. */
function analysis(): TrackAnalysis {
  return {
    version: ANALYSIS_VERSION,
    title: 'a track',
    durationSec: 90,
    segments: [{ start: 0, end: 90, input: {} as never, mood: {} as never }],
    transitions: [],
    cues: [],
    log: [
      { t: 0, dir: 'req', json: '{"a":1}' },
      { t: 0, dir: 'res', json: '{"b":2}' },
    ],
  };
}

/**
 * The link's own `requestAnimationFrame`, driven by hand. The scroll runs on
 * one for the life of the page, so "stopped scrolling" is only observable by
 * stepping it.
 */
function fakeRaf(): { step: () => void } {
  let next: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    next = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  return {
    step(): void {
      const cb = next;
      next = null;
      cb?.(0);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('splitLog', () => {
  it('numbers each side from one and reads the kind off the position', () => {
    const { left, right } = splitLog(
      [
        { t: 1, dir: 'req', json: '{}' },
        { t: 1, dir: 'res', json: '{}' },
        { t: 2, dir: 'req', json: '{}' },
        { t: 2, dir: 'res', json: '{}' },
      ],
      1,
    );
    expect(left.map((e) => [e.index, e.kind])).toEqual([
      [1, 'segment'],
      [2, 'transition'],
    ]);
    expect(right.map((e) => [e.index, e.kind])).toEqual([
      [1, 'segment'],
      [2, 'transition'],
    ]);
  });
});

describe('createColumnsLink', () => {
  it('clears the walls when the analysis goes away', () => {
    // `main` calls this the moment a new track takes over. What is on the walls
    // is the last track's transcript, and leaving it up through a download and
    // two model passes is a page describing music that is not playing.
    const columns = fakeColumns();
    const raf = fakeRaf();
    const link = createColumnsLink({ root: {} as HTMLElement, position: () => 12, columns });
    link.start();

    link.setAnalysis(analysis());
    expect(columns.calls.set.at(-1)).toEqual([1, 1, 90]);
    expect(columns.calls.visible.at(-1)).toBe(true);
    raf.step();
    expect(columns.calls.frames).toEqual([12]);

    link.setAnalysis(null);
    expect(columns.calls.set.at(-1)).toEqual([0, 0, 0]);
    expect(columns.calls.visible.at(-1)).toBe(false);
    // And the scroll stops: a hidden column still stepped is two style writes a
    // frame against a transcript that is no longer there.
    raf.step();
    expect(columns.calls.frames).toEqual([12]);
  });

  it('stays hidden for a track whose transcript is empty', () => {
    const columns = fakeColumns();
    fakeRaf();
    const link = createColumnsLink({ root: {} as HTMLElement, position: () => 0, columns });
    link.setAnalysis({ ...analysis(), log: [] });
    expect(columns.calls.visible.at(-1)).toBe(false);
  });
});

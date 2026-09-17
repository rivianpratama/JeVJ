/**
 * The analysis record, turned into the two scrolling columns.
 *
 * `TrackAnalysis.log` is a flat transcript — request, response, request,
 * response, in the order they were asked, each stamped with the track time it
 * is about. The columns want it split by direction and paired by position, so
 * that the answer on the right is level with the question on the left, and
 * that is all this file does: split, pretty-print, and drive the scroll off
 * the media element's own clock.
 *
 * It owns a `requestAnimationFrame` of its own rather than riding the HUD's
 * interval, because the scroll is continuous and a column stepped four times a
 * second is a column that judders. It costs two style writes a frame.
 */

import { createJsonColumns, type ColumnEntry, type JsonColumns } from '../ui/jsonColumns';
import type { AnalysisLogEntry, TrackAnalysis } from '../shared/types';

export interface ColumnsLinkOptions {
  root: HTMLElement;
  /** Where the track is, in track seconds. */
  position: () => number;
  columns?: JsonColumns;
}

export interface ColumnsLink {
  /** A track was analyzed, or null when the page goes back to empty. */
  setAnalysis(a: TrackAnalysis | null): void;
  start(): void;
  stop(): void;
}

/**
 * The log, split into one column's worth of entries.
 *
 * The transcript is already in the order the columns want — every segment,
 * then every transition — so the split preserves it and numbers each column
 * from one. The kind is read off the position rather than stored: pass 1 asks
 * about passages and pass 2 about moments, and pass 1 is done before pass 2
 * starts, so the first `segmentCount` entries of each column are the segments.
 */
export function splitLog(log: readonly AnalysisLogEntry[], segments: number): {
  left: ColumnEntry[];
  right: ColumnEntry[];
} {
  const left: ColumnEntry[] = [];
  const right: ColumnEntry[] = [];
  for (const e of log) {
    const side = e.dir === 'req' ? left : right;
    side.push({
      index: side.length + 1,
      t: e.t,
      kind: side.length < segments ? 'segment' : 'transition',
      json: pretty(e.json),
    });
  }
  return { left, right };
}

/** The body as the column prints it: two-space JSON, or the raw text if it is not JSON. */
function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function createColumnsLink(o: ColumnsLinkOptions): ColumnsLink {
  const columns = o.columns ?? createJsonColumns(o.root);
  let handle = 0;
  let on = false;

  function step(): void {
    handle = requestAnimationFrame(step);
    if (on) columns.frame(o.position());
  }

  return {
    setAnalysis(a: TrackAnalysis | null): void {
      if (a === null) {
        on = false;
        columns.setVisible(false);
        columns.set([], [], 0);
        return;
      }
      const { left, right } = splitLog(a.log, a.segments.length);
      columns.set(left, right, a.durationSec);
      on = left.length > 0 || right.length > 0;
      columns.setVisible(on);
    },
    start(): void {
      if (handle === 0) handle = requestAnimationFrame(step);
    },
    stop(): void {
      if (handle !== 0) cancelAnimationFrame(handle);
      handle = 0;
    },
  };
}

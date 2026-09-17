/**
 * The transcript, on the walls: every request Jev was sent down the left of
 * the screen and every answer down the right, scrolling past at the speed of
 * the track.
 *
 * It is the one place the app shows its working. The picture is a judgment
 * about the music and the judgment was made in words, so the words go on
 * screen — paced so that the entry level with the eye is the one that is
 * about the passage currently playing, and dim enough that they are texture
 * until you decide to read them.
 *
 * Two things here are worth knowing.
 *
 * **Nothing is laid out per frame.** The whole transcript is built into two
 * containers once, when the analysis arrives, and a frame is two writes of
 * `transform: translateY(...)`. A column that rebuilt its text as it scrolled
 * would be a full layout sixty times a second next to a feedback loop that has
 * already spent the frame budget.
 *
 * **The pacing is arithmetic, not animation.** `columnOffset` maps track time
 * straight onto the translation, so a seek jumps, a pause holds, and nothing
 * has to be told that either happened — the columns read the same clock the
 * cues do and cannot drift from it.
 */

/** Which way a column travels: `up` is bottom → top, `down` is top → bottom. */
export type ColumnDirection = 'up' | 'down';

/** One request or one response, as the column prints it. */
export interface ColumnEntry {
  /** Where the entry sits in its own column, 1-based; printed as `#12`. */
  index: number;
  /** Track seconds the entry is about. */
  t: number;
  kind: 'segment' | 'transition';
  /** The body, already pretty-printed. */
  json: string;
}

/**
 * How far a column of `contentHeight` is translated at `t`.
 *
 * The travel is `contentHeight + viewportHeight`, which is exactly the distance
 * from "entirely off one end" to "entirely off the other": at t = 0 nothing is
 * on screen, at t = duration nothing is on screen again, and in between the
 * whole transcript has gone past once. An `up` column starts below the screen
 * and leaves at the top; a `down` column starts above it and leaves at the
 * bottom.
 *
 * Pure, and the only arithmetic in the feature. A track with no duration — the
 * element has not said yet — parks both columns at their start rather than
 * dividing by zero.
 */
export function columnOffset(
  t: number,
  duration: number,
  contentHeight: number,
  viewportHeight: number,
  direction: ColumnDirection,
): number {
  const p = duration > 0 && Number.isFinite(t) ? Math.min(1, Math.max(0, t / duration)) : 0;
  const distance = contentHeight + viewportHeight;
  return direction === 'up' ? viewportHeight - p * distance : -contentHeight + p * distance;
}

/**
 * When each entry stops being the current one.
 *
 * A column holds the segments first and then the transitions, each group in
 * track order, so the list as a whole is not monotone: the first transition is
 * usually earlier than the last segment. An entry's span therefore runs to the
 * next entry *of its own kind*, and to the end of the track for the last of
 * each. That gives at most two live entries at any instant — the passage being
 * played and the moment last asked about — which is what is true.
 */
export function entryEnds(entries: readonly ColumnEntry[], duration: number): number[] {
  const ends = entries.map(() => duration);
  for (let i = entries.length - 1; i >= 0; i--) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j]!.kind === entries[i]!.kind) {
        ends[i] = entries[j]!.t;
        break;
      }
    }
  }
  return ends;
}

/** `93.4` → `1:33`. */
export function stamp(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface JsonColumns {
  /** Lay both columns out. Called once per track. */
  set(left: readonly ColumnEntry[], right: readonly ColumnEntry[], duration: number): void;
  /** One frame, at `t` track seconds. Allocates nothing. */
  frame(t: number): void;
  setVisible(on: boolean): void;
  dispose(): void;
}

interface Column {
  root: HTMLElement;
  scroller: HTMLElement;
  entries: readonly ColumnEntry[];
  ends: number[];
  nodes: HTMLElement[];
  active: boolean[];
  height: number;
  direction: ColumnDirection;
}

function buildColumn(root: HTMLElement, side: 'left' | 'right', direction: ColumnDirection): Column {
  const el = document.createElement('div');
  el.className = `jsoncol jsoncol--${side}`;
  el.setAttribute('aria-hidden', 'true');
  const scroller = document.createElement('div');
  scroller.className = 'jsoncol-scroll';
  el.append(scroller);
  root.append(el);
  return {
    root: el,
    scroller,
    entries: [],
    ends: [],
    nodes: [],
    active: [],
    height: 0,
    direction,
  };
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * The body as HTML, with the key names in their own span.
 *
 * Escaped first and marked up second, so a string in the JSON that happens to
 * contain a `<` is text rather than a tag — the transcript is model output and
 * a track title goes into it verbatim.
 */
function markup(json: string): string {
  const safe = json.replace(/[&<>]/g, (c) => ESCAPE[c]!);
  return safe.replace(/"([^"\\]*)":/g, '<span class="jsoncol-k">"$1"</span>:');
}

function fill(col: Column, entries: readonly ColumnEntry[], duration: number): void {
  col.entries = entries;
  col.ends = entryEnds(entries, duration);
  col.nodes = [];
  col.active = entries.map(() => false);
  col.scroller.textContent = '';
  const html = entries
    .map(
      (e) =>
        `<div class="jsoncol-entry"><div class="jsoncol-head">#${e.index} · ${stamp(e.t)} · ${e.kind}</div><pre class="jsoncol-body">${markup(e.json)}</pre></div>`,
    )
    .join('');
  col.scroller.innerHTML = html;
  for (const node of col.scroller.children) col.nodes.push(node as HTMLElement);
  col.height = col.scroller.scrollHeight;
}

export function createJsonColumns(root: HTMLElement): JsonColumns {
  const left = buildColumn(root, 'left', 'up');
  const right = buildColumn(root, 'right', 'down');
  let duration = 0;

  function paint(col: Column, t: number, viewport: number): void {
    if (col.entries.length === 0) return;
    const y = columnOffset(t, duration, col.height, viewport, col.direction);
    col.scroller.style.transform = `translateY(${y.toFixed(1)}px)`;
    // The highlight, without allocating: the flags are compared in place and
    // only a class that actually changed is touched.
    for (let i = 0; i < col.entries.length; i++) {
      const on = t >= col.entries[i]!.t && t < col.ends[i]!;
      if (on !== col.active[i]) {
        col.active[i] = on;
        col.nodes[i]?.classList.toggle('is-now', on);
      }
    }
  }

  return {
    set(l, r, d): void {
      duration = d;
      fill(left, l, d);
      fill(right, r, d);
    },
    frame(t: number): void {
      const viewport = left.root.clientHeight || window.innerHeight;
      paint(left, t, viewport);
      paint(right, t, viewport);
    },
    setVisible(on: boolean): void {
      left.root.classList.toggle('is-on', on);
      right.root.classList.toggle('is-on', on);
    },
    dispose(): void {
      left.root.remove();
      right.root.remove();
    },
  };
}

import { describe, expect, it } from 'vitest';
import {
  APP_EVENTS,
  APP_STATES,
  createAppMachine,
  transition,
  type AppEvent,
  type AppState,
} from '../../src/app/state';

describe('transition', () => {
  it('walks the whole v2 path: empty → resolving → analyzing → ready → playing ⇄ paused → ended', () => {
    expect(transition('empty', 'url:submit')).toBe('resolving');
    expect(transition('resolving', 'resolved')).toBe('analyzing');
    expect(transition('analyzing', 'analyzed')).toBe('ready');
    expect(transition('ready', 'play')).toBe('playing');
    expect(transition('playing', 'pause')).toBe('paused');
    expect(transition('paused', 'play')).toBe('playing');
    expect(transition('playing', 'ended')).toBe('ended');
  });

  it('starts a dropped file over from empty, ready and ended', () => {
    for (const from of ['empty', 'ready', 'ended'] as const) {
      expect(transition(from, 'file:drop')).toBe('analyzing');
    }
  });

  it('ignores a file dropped into a track that is already under way', () => {
    // The input is gone once a track is loaded and a reload is how you change
    // it; a drop landing mid-analysis would put two pipelines on one graph.
    for (const from of ['resolving', 'analyzing', 'playing', 'paused'] as const) {
      expect(transition(from, 'file:drop')).toBe(from);
    }
  });

  it('returns to empty from anywhere when something fails', () => {
    for (const from of APP_STATES) expect(transition(from, 'failed')).toBe('empty');
  });

  it('plays again from the end of the track', () => {
    expect(transition('ended', 'play')).toBe('playing');
  });

  it('takes a link only from empty', () => {
    expect(transition('empty', 'url:submit')).toBe('resolving');
    for (const from of APP_STATES) {
      if (from === 'empty') continue;
      expect(transition(from, 'url:submit')).toBe(from);
    }
  });

  it('is the whole table, row by row', () => {
    // Every event reaches the machine from something the user or the browser
    // did — a media element emits `pause` as it is torn down, `ended` fires on
    // a seek past the end — and none of it is worth a thrown exception in a
    // handler that is halfway through swapping a track. So every cell has an
    // answer, and the answer is written down here rather than checked for
    // membership: "it returned *some* state" passes for a table that sends
    // every event to `empty`.
    const table: Record<AppState, Partial<Record<AppEvent, AppState>>> = {
      empty: { 'url:submit': 'resolving', 'file:drop': 'analyzing' },
      resolving: { resolved: 'analyzing' },
      analyzing: { analyzed: 'ready' },
      ready: { 'file:drop': 'analyzing', play: 'playing' },
      playing: { pause: 'paused', ended: 'ended' },
      paused: { play: 'playing', ended: 'ended' },
      ended: { 'file:drop': 'analyzing', play: 'playing' },
    };

    for (const from of APP_STATES) {
      for (const event of APP_EVENTS) {
        // `failed` is the one event every state answers, and it always answers
        // `empty`; anything else the row does not name leaves the state alone.
        const expected = event === 'failed' ? 'empty' : (table[from][event] ?? from);
        expect(transition(from, event), `${from} + ${event}`).toBe(expected);
      }
    }
  });
});

describe('createAppMachine', () => {
  it('starts empty and moves with what it is sent', () => {
    const m = createAppMachine();
    expect(m.state()).toBe('empty');
    expect(m.send('url:submit')).toEqual({ next: 'resolving', changed: true });
    expect(m.state()).toBe('resolving');
  });

  it('says so when an event changed nothing', () => {
    const m = createAppMachine();
    expect(m.send('play')).toEqual({ next: 'empty', changed: false });
    expect(m.send('pause')).toEqual({ next: 'empty', changed: false });
    expect(m.state()).toBe('empty');
  });

  it('reports only the changes, with what caused them', () => {
    const seen: [AppState, AppState, AppEvent][] = [];
    const m = createAppMachine((to, from, event) => seen.push([to, from, event]));
    m.send('file:drop');
    // A second drop while the first is still being analyzed: no move, nobody
    // is told.
    m.send('file:drop');
    m.send('analyzed');
    expect(seen).toEqual([
      ['analyzing', 'empty', 'file:drop'],
      ['ready', 'analyzing', 'analyzed'],
    ]);
  });
});

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
  it('walks the live path: idle → loaded → capturing → playing → paused', () => {
    expect(transition('idle', 'url:cued')).toBe('loaded');
    expect(transition('loaded', 'capture:started')).toBe('capturing');
    expect(transition('capturing', 'play')).toBe('playing');
    expect(transition('playing', 'pause')).toBe('paused');
    expect(transition('paused', 'play')).toBe('playing');
  });

  it('walks the file path: analyzing → playing', () => {
    expect(transition('idle', 'file:drop')).toBe('analyzing');
    expect(transition('analyzing', 'play')).toBe('playing');
  });

  it('takes a dropped file from any state at all', () => {
    for (const from of APP_STATES) expect(transition(from, 'file:drop')).toBe('analyzing');
  });

  it('takes a pasted link from any state at all', () => {
    for (const from of APP_STATES) expect(transition(from, 'url:cued')).toBe('loaded');
  });

  it('returns to idle when a link fails to load', () => {
    for (const from of APP_STATES) expect(transition(from, 'url:failed')).toBe('idle');
  });

  it('returns to loaded when the user stops sharing the tab', () => {
    expect(transition('capturing', 'capture:ended')).toBe('loaded');
    expect(transition('playing', 'capture:ended')).toBe('loaded');
    expect(transition('paused', 'capture:ended')).toBe('loaded');
  });

  it('takes the share picker\'s answer from any state at all', () => {
    // The picker is open for as long as the user takes over it, and everything
    // else stays live underneath: they can paste a link that fails (→ idle) or
    // drop a file (→ analyzing) while it is up. The answer still has to land.
    // A `playing` machine is the one exception and it was already here: the
    // player usually reports itself playing while the picker is still open.
    for (const from of APP_STATES) {
      expect(transition(from, 'capture:started')).toBe(from === 'playing' ? 'playing' : 'capturing');
    }
  });

  it('takes the share ending from any state at all', () => {
    // `capture:ended` comes from the browser's own bar and can arrive whenever
    // the user presses it — including after a link failed (idle) or a file was
    // dropped (analyzing), neither of which stops a share that is still
    // running. Nothing is loaded in those two, so the machine stays where it
    // is; everywhere else a video is still cued and the app falls back to it.
    expect(transition('idle', 'capture:ended')).toBe('idle');
    expect(transition('analyzing', 'capture:ended')).toBe('analyzing');
    expect(transition('loaded', 'capture:ended')).toBe('loaded');
    expect(transition('capturing', 'capture:ended')).toBe('loaded');
    expect(transition('playing', 'capture:ended')).toBe('loaded');
    expect(transition('paused', 'capture:ended')).toBe('loaded');
  });

  it('throws on a transition that means nothing', () => {
    expect(() => transition('idle', 'play')).toThrow(/idle/);
    expect(() => transition('idle', 'pause')).toThrow(/pause/);
  });

  it('is defined for every state and event it does not throw on', () => {
    for (const from of APP_STATES) {
      for (const event of APP_EVENTS) {
        let to: AppState | null = null;
        try {
          to = transition(from, event);
        } catch {
          to = null;
        }
        if (to !== null) expect(APP_STATES).toContain(to);
      }
    }
  });
});

describe('createAppMachine', () => {
  it('starts idle and moves with what it is sent', () => {
    const m = createAppMachine();
    expect(m.state()).toBe('idle');
    expect(m.send('url:cued')).toBe('loaded');
    expect(m.state()).toBe('loaded');
  });

  it('reports only the changes, with what caused them', () => {
    const seen: [AppState, AppState, AppEvent][] = [];
    const m = createAppMachine((to, from, event) => seen.push([to, from, event]));
    m.send('url:cued');
    // A second link over the first: the state is the same, so nobody is told.
    m.send('url:cued');
    m.send('capture:started');
    expect(seen).toEqual([
      ['loaded', 'idle', 'url:cued'],
      ['capturing', 'loaded', 'capture:started'],
    ]);
  });

  it('keeps its state when a transition throws', () => {
    const m = createAppMachine();
    expect(() => m.send('play')).toThrow();
    expect(m.state()).toBe('idle');
  });
});

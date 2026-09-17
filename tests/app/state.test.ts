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

  it('throws on a transition that means nothing', () => {
    expect(() => transition('idle', 'play')).toThrow(/idle/);
    expect(() => transition('idle', 'pause')).toThrow(/pause/);
    expect(() => transition('idle', 'capture:started')).toThrow();
    expect(() => transition('idle', 'capture:ended')).toThrow();
    expect(() => transition('loaded', 'capture:ended')).toThrow();
    expect(() => transition('analyzing', 'capture:started')).toThrow();
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

/**
 * Which of seven things the app is doing, as a table rather than as five flags.
 *
 * v2 is one pipeline with one shape — a link or a file goes in, a whole track
 * comes out analyzed, and only then does anything play — so the states are the
 * stages of that pipeline and the screen is a function of which one we are in:
 * `empty` is the input bar alone in the middle of the page, `resolving` and
 * `analyzing` are the caption counting up, and everything from `ready` on is
 * the card and the button at the centre of the screen.
 *
 * Nothing here throws. That is a change from v1 and it is deliberate: every
 * event arrives from something outside our control — a media element emits
 * `pause` while it is being torn down, `ended` fires on a seek past the end,
 * a file lands on the page in the middle of a download — and an exception
 * thrown inside one of those handlers strands the pipeline halfway. So an
 * event that means nothing where it arrives leaves the state alone and says
 * so, and the caller decides whether a no-op is worth reacting to.
 *
 * Pure: no DOM, no timers. The caller sends the events and reads the state.
 */

export const APP_STATES = [
  'empty',
  'resolving',
  'analyzing',
  'ready',
  'playing',
  'paused',
  'ended',
] as const;
export type AppState = (typeof APP_STATES)[number];

export const APP_EVENTS = [
  'url:submit',
  'resolved',
  'file:drop',
  'analyzed',
  'failed',
  'play',
  'pause',
  'ended',
] as const;
export type AppEvent = (typeof APP_EVENTS)[number];

/**
 * What every state does with the one event that can arrive anywhere.
 *
 * A failure is the only thing the app is always willing to hear. A download
 * that 404s, a file that will not decode, an analysis that threw — all of them
 * land the page back where it started, with the input bar and a toast saying
 * what happened, because there is nothing else the user could do next.
 */
const ANYWHERE = {
  failed: 'empty',
} as const satisfies Partial<Record<AppEvent, AppState>>;

/**
 * The moves. Anything missing from a row is an event that does nothing there.
 *
 * Two rows are worth reading twice. A file dropped on the page starts the
 * whole pipeline over, but only from `empty`, `ready` and `ended` — the three
 * states where nothing is in flight. Dropping one into a running download or a
 * half-finished analysis would put two pipelines through one audio graph, and
 * the input bar is gone by then anyway: changing the track mid-play is a
 * reload, which is the same decision the missing URL bar makes.
 *
 * And `play` is legal from `ended`, because pressing the button at the end of
 * a track is how you hear it again.
 */
const TABLE: Record<AppState, Partial<Record<AppEvent, AppState>>> = {
  empty: { ...ANYWHERE, 'url:submit': 'resolving', 'file:drop': 'analyzing' },
  resolving: { ...ANYWHERE, resolved: 'analyzing' },
  analyzing: { ...ANYWHERE, analyzed: 'ready' },
  ready: { ...ANYWHERE, 'file:drop': 'analyzing', play: 'playing' },
  playing: { ...ANYWHERE, pause: 'paused', ended: 'ended' },
  paused: { ...ANYWHERE, play: 'playing', ended: 'ended' },
  ended: { ...ANYWHERE, 'file:drop': 'analyzing', play: 'playing' },
};

/** Where `event` leads from `from` — `from` itself when it leads nowhere. */
export function transition(from: AppState, event: AppEvent): AppState {
  return TABLE[from][event] ?? from;
}

/** Where a move landed, and whether it was a move at all. */
export interface AppMove {
  next: AppState;
  changed: boolean;
}

export interface AppMachine {
  state(): AppState;
  /** Move, and say where we are now and whether anything happened. */
  send(event: AppEvent): AppMove;
}

/**
 * A machine holding one state. `onChange` hears only actual changes — a
 * `pause` while paused is a fact about the user, not about the app.
 */
export function createAppMachine(
  onChange?: (to: AppState, from: AppState, event: AppEvent) => void,
): AppMachine {
  let state: AppState = 'empty';
  return {
    state: () => state,
    send(event: AppEvent): AppMove {
      const to = transition(state, event);
      if (to === state) return { next: state, changed: false };
      const from = state;
      state = to;
      onChange?.(to, from, event);
      return { next: state, changed: true };
    },
  };
}

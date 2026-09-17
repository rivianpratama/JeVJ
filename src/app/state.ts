/**
 * Which of six things the app is doing, as a table rather than as five flags.
 *
 * `transport` already knows whether a video is loaded, whether a file is
 * playing and whether a capture is running, and every one of those is a
 * boolean somebody has to keep in step with the others. The bug that costs is
 * always the same one — two of them true at once, a file playing under a video
 * that has just been cued — and it is invisible until the analysis is being fed
 * by a source nobody thinks is running.
 *
 * So the six states are named and the legal moves between them are written
 * down, once. An event that means nothing where it arrives throws rather than
 * being swallowed: "pause while nothing is loaded" is not a state this app has,
 * and a machine that silently stays put would hide the wiring mistake that sent
 * it. Two moves are legal from everywhere, because the user can always do them:
 * dropping a file and pasting a link.
 *
 * Pure: no DOM, no timers. The caller sends the events and reads the state.
 */

export const APP_STATES = [
  'idle',
  'loaded',
  'analyzing',
  'capturing',
  'playing',
  'paused',
] as const;
export type AppState = (typeof APP_STATES)[number];

export const APP_EVENTS = [
  'url:cued',
  'url:failed',
  'file:drop',
  'capture:started',
  'capture:ended',
  'play',
  'pause',
] as const;
export type AppEvent = (typeof APP_EVENTS)[number];

/**
 * What every state does with the three events the user can raise anywhere:
 * a link that cued, a link that did not, and a file dropped on the page.
 */
const ANYWHERE = {
  'url:cued': 'loaded',
  'url:failed': 'idle',
  'file:drop': 'analyzing',
} as const satisfies Partial<Record<AppEvent, AppState>>;

/**
 * The moves. Anything missing from a row is an event that cannot happen there.
 *
 * `capture:started` is legal while already playing because the two arrive in
 * whichever order the browser feels like: pressing play on a cued video starts
 * the player and opens the share picker, and the player usually reports itself
 * playing while the picker is still up.
 */
const TABLE: Record<AppState, Partial<Record<AppEvent, AppState>>> = {
  idle: { ...ANYWHERE },
  loaded: { ...ANYWHERE, 'capture:started': 'capturing', play: 'playing', pause: 'loaded' },
  // A file being swept can already be paused — the sweep runs before the first
  // sample, and the user may press play into it.
  analyzing: { ...ANYWHERE, play: 'playing', pause: 'paused' },
  capturing: { ...ANYWHERE, 'capture:started': 'capturing', 'capture:ended': 'loaded', play: 'playing', pause: 'paused' },
  playing: { ...ANYWHERE, 'capture:started': 'playing', 'capture:ended': 'loaded', play: 'playing', pause: 'paused' },
  paused: { ...ANYWHERE, 'capture:started': 'capturing', 'capture:ended': 'loaded', play: 'playing', pause: 'paused' },
};

/** Where `event` leads from `from`. Throws when it leads nowhere. */
export function transition(from: AppState, event: AppEvent): AppState {
  const to = TABLE[from][event];
  if (to === undefined) throw new Error(`JeVJ: no transition for ${event} in ${from}`);
  return to;
}

export interface AppMachine {
  state(): AppState;
  /** Move, and return where we are now. Throws if the move is not a move. */
  send(event: AppEvent): AppState;
}

/**
 * A machine holding one state. `onChange` hears only actual changes — a
 * `pause` while paused is a fact about the user, not about the app.
 */
export function createAppMachine(
  onChange?: (to: AppState, from: AppState, event: AppEvent) => void,
): AppMachine {
  let state: AppState = 'idle';
  return {
    state: () => state,
    send(event: AppEvent): AppState {
      const to = transition(state, event);
      if (to === state) return state;
      const from = state;
      state = to;
      onChange?.(to, from, event);
      return state;
    },
  };
}

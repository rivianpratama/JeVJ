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
 *
 * `capture:started` belongs here too, and for a related reason: the share
 * picker is open for as long as the user takes over it, and nothing else in the
 * app is frozen meanwhile. They can paste a link that fails — which lands in
 * `idle` — or drop a file — which lands in `analyzing` — and then pick a tab.
 * The answer is a fact about the app whatever state it finds, and a `send` that
 * threw there left the page capturing audio while the machine said it was doing
 * nothing. `playing` overrides it below.
 */
const ANYWHERE = {
  'url:cued': 'loaded',
  'url:failed': 'idle',
  'file:drop': 'analyzing',
  'capture:started': 'capturing',
} as const satisfies Partial<Record<AppEvent, AppState>>;

/**
 * The moves. Anything missing from a row is an event that cannot happen there.
 *
 * `capture:started` is legal while already playing, and stays there, because
 * the two arrive in whichever order the browser feels like: pressing play on a
 * cued video starts the player and opens the share picker, and the player
 * usually reports itself playing while the picker is still up.
 *
 * `capture:ended` is legal everywhere, because it is the browser's own bar and
 * the user may press it at any moment — including after a link failed or a
 * file was dropped, neither of which stops a share that is already running
 * (only `playFile` does, and only for the file it is about to play). In `idle`
 * and `analyzing` there is nothing for the app to fall back to, so it stays
 * where it is; everywhere else a video is still cued and `loaded` is what is
 * left. This is not a nicety: these events cross an `await` on a share picker
 * the user can take half a minute over, and a throw in the handler that
 * receives them leaves the page capturing audio nobody is analysing.
 */
const TABLE: Record<AppState, Partial<Record<AppEvent, AppState>>> = {
  idle: { ...ANYWHERE, 'capture:ended': 'idle' },
  loaded: { ...ANYWHERE, 'capture:ended': 'loaded', play: 'playing', pause: 'loaded' },
  // A file being swept can already be paused — the sweep runs before the first
  // sample, and the user may press play into it.
  analyzing: { ...ANYWHERE, 'capture:ended': 'analyzing', play: 'playing', pause: 'paused' },
  capturing: { ...ANYWHERE, 'capture:ended': 'loaded', play: 'playing', pause: 'paused' },
  playing: { ...ANYWHERE, 'capture:started': 'playing', 'capture:ended': 'loaded', play: 'playing', pause: 'paused' },
  paused: { ...ANYWHERE, 'capture:ended': 'loaded', play: 'playing', pause: 'paused' },
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

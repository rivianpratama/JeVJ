/**
 * Something to step a loop with when the browser stops handing out frames.
 *
 * `requestAnimationFrame` is the right clock for anything that draws, and the
 * wrong one for anything that must keep up with sound. A hidden tab, or a pane
 * the desktop app has moved off screen, is throttled to about one frame a
 * second — measured at 1.3 in Chrome — while the audio keeps playing at full
 * rate. An analysis loop on rAF then looks at one analyser window in twenty:
 * the tempo confidence collapses, the beat grid drifts off the music, and every
 * cue written from it is late by however long the user was looking elsewhere.
 *
 * So the analysis runs on frames while anyone can see it and on a 33 ms timer
 * while nobody can. `setInterval` is throttled too — to a 1 s floor in a
 * *backgrounded* tab — but a hidden pane in a foreground window is not
 * backgrounded, which is the case this exists for, and even the worst case is
 * a floor rather than a stall.
 *
 * The page is behind a `DriverHost` so that all of this is testable in Node:
 * the default host is the real one, and a test hands it frames, timers and
 * visibility changes of its own.
 */

/** The hidden-page step, in milliseconds: a little over 30 a second. */
export const HIDDEN_STEP_MS = 33;

/** As much of the page as the driver touches. */
export interface DriverHost {
  requestFrame(cb: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(handle: number): void;
  hidden(): boolean;
  /** Subscribe to visibility changes; the return value unsubscribes. */
  onVisibilityChange(cb: () => void): () => void;
}

/** The real page. */
export const browserHost: DriverHost = {
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (h) => cancelAnimationFrame(h),
  setTimer: (cb, ms) => setInterval(cb, ms) as unknown as number,
  clearTimer: (h) => clearInterval(h),
  hidden: () => document.hidden,
  onVisibilityChange(cb) {
    document.addEventListener('visibilitychange', cb);
    return () => document.removeEventListener('visibilitychange', cb);
  },
};

/** Which clock is driving the step, or none. */
export type DriverMode = 'stopped' | 'frames' | 'timer';

export interface LoopDriver {
  /** Start stepping, on whichever clock suits the page right now. */
  start(): void;
  /** Stop stepping, and stop listening for visibility changes. */
  stop(): void;
  mode(): DriverMode;
}

export function createLoopDriver(step: () => void, host: DriverHost = browserHost): LoopDriver {
  let mode: DriverMode = 'stopped';
  let frame = 0;
  let timer = 0;
  let unsubscribe: (() => void) | null = null;

  /** Tear down whichever clock is running, without touching `mode`. */
  function detach(): void {
    if (frame !== 0) host.cancelFrame(frame);
    if (timer !== 0) host.clearTimer(timer);
    frame = 0;
    timer = 0;
  }

  const onFrame = (): void => {
    // Re-queued first, so a throw in `step` cannot end the loop for the rest of
    // the page's life.
    frame = host.requestFrame(onFrame);
    step();
  };

  /**
   * Put the loop on the clock the page deserves. Both are torn down first: a
   * frame callback that is already queued still fires once after the page is
   * hidden, and stepping from both clocks in one period would double-count
   * every analyser read.
   */
  function attach(): void {
    detach();
    if (host.hidden()) {
      mode = 'timer';
      timer = host.setTimer(step, HIDDEN_STEP_MS);
    } else {
      mode = 'frames';
      frame = host.requestFrame(onFrame);
    }
  }

  return {
    start(): void {
      if (mode !== 'stopped') return;
      unsubscribe ??= host.onVisibilityChange(() => {
        if (mode !== 'stopped') attach();
      });
      attach();
    },

    stop(): void {
      detach();
      unsubscribe?.();
      unsubscribe = null;
      mode = 'stopped';
    },

    mode: () => mode,
  };
}

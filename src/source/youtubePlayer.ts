/**
 * A small, promise-shaped wrapper over the YouTube IFrame API.
 *
 * The rest of the app never touches `YT.*`: it loads a video id, presses play
 * or pause, and subscribes to state and error callbacks. Errors arrive as
 * human-readable messages so the UI can toast them unchanged.
 */

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

export type PlayerState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

export interface YouTubePlayer {
  load(videoId: string, startSeconds?: number): Promise<void>;
  play(): void;
  pause(): void;
  currentTime(): number;
  duration(): number;
  title(): string;
  onState(cb: (s: PlayerState) => void): () => void;
  onError(cb: (code: number, message: string) => void): () => void;
}

const STATES: Record<number, PlayerState> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

const ERRORS: Record<number, string> = {
  2: 'invalid video id',
  5: 'html5 player error',
  100: 'video not found or private',
  101: 'the owner disabled embedding for this video — try another link',
  150: 'the owner disabled embedding for this video — try another link',
};

/** How long the player has to say it is ready, or to cue a video. */
const READY_TIMEOUT_MS = 10_000;
const NO_RESPONSE = 'the youtube player did not respond — try again';

/** Loads the IFrame API script once per page; later calls reuse the promise. */
let apiPromise: Promise<typeof YT> | null = null;

function loadIframeApi(): Promise<typeof YT> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<typeof YT>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      const api = window.YT;
      if (api?.Player) resolve(api);
      else reject(new Error('the youtube player failed to initialise'));
    };

    if (!document.querySelector(`script[src="${IFRAME_API_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = IFRAME_API_SRC;
      script.async = true;
      script.onerror = () => reject(new Error('could not reach youtube — check your connection'));
      document.head.appendChild(script);
    }
  });

  // A failure is not a fact about the page for the rest of its life: an offline
  // moment, a blocked script, a network that came back. Forgetting the rejected
  // promise is what lets the next attempt actually be an attempt.
  return apiPromise.catch((err: unknown) => {
    apiPromise = null;
    throw err;
  });
}

/** `promise`, or a rejection with `message` after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function createYouTubePlayer(mount: HTMLElement): YouTubePlayer {
  let player: YT.Player | null = null;
  /** Settles when the first load has finished, successfully or not. */
  let ready: Promise<void> | null = null;
  const stateSubs = new Set<(s: PlayerState) => void>();
  const errorSubs = new Set<(code: number, message: string) => void>();

  const emitState = (code: number): void => {
    const state = STATES[code];
    if (state === undefined) return;
    for (const cb of stateSubs) cb(state);
  };

  const emitError = (code: number): void => {
    const message = ERRORS[code] ?? `the youtube player failed (error ${code})`;
    for (const cb of errorSubs) cb(code, message);
  };

  /**
   * The next time the player reaches `want`, or the next time it fails.
   *
   * Both outcomes unsubscribe: a cue that errors must not leave a listener
   * waiting for a state it will never reach, and the next cue installs its own.
   */
  const reaches = (want: PlayerState): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onState = (s: PlayerState): void => {
        if (s !== want) return;
        done();
        resolve();
      };
      const onError = (_code: number, message: string): void => {
        done();
        reject(new Error(message));
      };
      const done = (): void => {
        stateSubs.delete(onState);
        errorSubs.delete(onError);
      };
      stateSubs.add(onState);
      errorSubs.add(onError);
    });

  const create = (api: typeof YT, videoId: string, startSeconds: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      player = new api.Player(mount, {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          rel: 0,
          playsinline: 1,
          modestbranding: 1,
          // Nothing drawn over the video but the video: annotations and
          // captions are someone else's text on top of a picture the
          // visualizer is reading colour and motion from.
          iv_load_policy: 3,
          cc_load_policy: 0,
          origin: location.origin,
          start: startSeconds,
        },
        events: {
          onReady: () => {
            if (settled) return;
            settled = true;
            resolve();
          },
          onStateChange: (e) => emitState(e.data),
          onError: (e) => {
            emitError(e.data);
            if (settled) return;
            settled = true;
            reject(new Error(ERRORS[e.data] ?? `the youtube player failed (error ${e.data})`));
          },
        },
      });
    });

  return {
    async load(videoId: string, startSeconds = 0): Promise<void> {
      const api = await loadIframeApi();

      if (ready === null) {
        // The player is an iframe on someone else's origin: if it never calls
        // back there is nothing to catch, and the UI would sit on "loading…"
        // for the rest of the session.
        ready = withTimeout(create(api, videoId, startSeconds), READY_TIMEOUT_MS, NO_RESPONSE);
        await ready;
        return;
      }

      // A second link: wait for the first attempt to settle before touching
      // the player. Whether it succeeded or failed, the instance is reusable —
      // destroying it would take the mount element with it.
      await ready.catch(() => undefined);

      // Cue rather than load: playback stays under our play button's control.
      // And resolve when the player says it is *cued*, not when the call
      // returns: `cueVideoById` returns immediately, so resolving there told
      // the caller a video was loaded while the old one was still on screen,
      // and a bad id reported itself through `onError` long afterwards.
      const cued = reaches('cued');
      player?.cueVideoById({ videoId, startSeconds });
      await withTimeout(cued, READY_TIMEOUT_MS, NO_RESPONSE);
    },

    play(): void {
      player?.playVideo();
    },

    pause(): void {
      player?.pauseVideo();
    },

    currentTime(): number {
      try {
        return player?.getCurrentTime() ?? 0;
      } catch {
        return 0;
      }
    },

    duration(): number {
      try {
        return player?.getDuration() ?? 0;
      } catch {
        return 0;
      }
    },

    title(): string {
      try {
        return player?.getVideoData().title ?? '';
      } catch {
        return '';
      }
    },

    onState(cb: (s: PlayerState) => void): () => void {
      stateSubs.add(cb);
      return () => stateSubs.delete(cb);
    },

    onError(cb: (code: number, message: string) => void): () => void {
      errorSubs.add(cb);
      return () => errorSubs.delete(cb);
    },
  };
}

/**
 * The slice of the YouTube IFrame API this app actually calls.
 *
 * Hand-written on purpose (no `@types/youtube`): the surface is small, and
 * keeping it here documents exactly which parts of the API we depend on.
 * Loaded at runtime from https://www.youtube.com/iframe_api.
 */

declare namespace YT {
  interface PlayerVars {
    autoplay?: 0 | 1;
    controls?: 0 | 1;
    rel?: 0 | 1;
    playsinline?: 0 | 1;
    modestbranding?: 0 | 1;
    /** 3 hides video annotations; there is no 0. */
    iv_load_policy?: 1 | 3;
    /** 0 leaves captions off unless the viewer's account turns them on. */
    cc_load_policy?: 0 | 1;
    origin?: string;
    start?: number;
  }

  interface PlayerEvent {
    target: Player;
  }

  interface OnStateChangeEvent extends PlayerEvent {
    /** One of the YT.PlayerState values. */
    data: number;
  }

  interface OnErrorEvent extends PlayerEvent {
    /** 2, 5, 100, 101 or 150. */
    data: number;
  }

  interface PlayerEvents {
    onReady?: (event: PlayerEvent) => void;
    onStateChange?: (event: OnStateChangeEvent) => void;
    onError?: (event: OnErrorEvent) => void;
  }

  interface PlayerOptions {
    videoId?: string;
    playerVars?: PlayerVars;
    events?: PlayerEvents;
  }

  interface VideoData {
    video_id: string;
    title: string;
    author: string;
  }

  interface VideoRequest {
    videoId: string;
    startSeconds?: number;
  }

  class Player {
    constructor(element: HTMLElement | string, options: PlayerOptions);
    playVideo(): void;
    pauseVideo(): void;
    getCurrentTime(): number;
    getDuration(): number;
    getVideoData(): VideoData;
    /** Loads and starts playing. */
    loadVideoById(request: VideoRequest): void;
    /** Loads without playing — the state we want before the user presses play. */
    cueVideoById(request: VideoRequest): void;
    destroy(): void;
  }

  const PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
}

interface Window {
  YT?: typeof YT;
  /** The IFrame API calls this once, globally, when it has finished loading. */
  onYouTubeIframeAPIReady?: () => void;
}

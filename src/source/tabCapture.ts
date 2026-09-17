/**
 * Borrowing the sound of the tab the user is already watching.
 *
 * A YouTube iframe gives us no audio — cross-origin, and the IFrame API
 * exposes no stream. `getDisplayMedia` does, if the user shares this very tab
 * with audio. The options below push the picker as close to "just say yes" as
 * the platform allows: current tab preselected, no monitor or window choices,
 * no system audio (which would loop our own output back in).
 *
 * Chromium only. Firefox and Safari share no tab audio at all, which is what
 * `isTabCaptureSupported` is for — ask before sending the user into a dialog
 * that cannot succeed.
 *
 * Never connect the returned node to `destination`: the tab is already audible.
 */

/** Non-standard keys (every one after `audio`) are Chromium-only, hence the cast. */
const CAPTURE_OPTIONS = {
  video: true,
  audio: true,
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
  systemAudio: 'exclude',
  surfaceSwitching: 'exclude',
  monitorTypeSurfaces: 'exclude',
} as unknown as DisplayMediaStreamOptions;

export interface TabCapture {
  node: MediaStreamAudioSourceNode;
  stop(): void;
  /** Fires when the user ends the share from the browser's own bar. */
  onEnded(cb: () => void): void;
}

export function isTabCaptureSupported(): boolean {
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  return !!devices && 'getDisplayMedia' in devices && /Chrom/.test(navigator.userAgent);
}

export async function captureTabAudio(ctx: AudioContext): Promise<TabCapture> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(CAPTURE_OPTIONS);
  } catch (err) {
    throw new Error(describe(err));
  }

  // We asked for video only because Chromium will not offer a tab without it;
  // the frames are of no use to us and cost real CPU, so drop them at once.
  for (const track of stream.getVideoTracks()) track.stop();

  const audio = stream.getAudioTracks()[0];
  if (!audio) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('share the tab with "Also share tab audio" ticked');
  }

  const node = ctx.createMediaStreamSource(stream);
  let stopped = false;

  const endedSubs = new Set<() => void>();
  audio.addEventListener('ended', () => {
    if (stopped) return;
    stopped = true;
    for (const cb of endedSubs) cb();
  });

  return {
    node,
    stop(): void {
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      node.disconnect();
    },
    onEnded(cb: () => void): void {
      endedSubs.add(cb);
    },
  };
}

/** Turns a DOMException into something worth putting in a toast. */
function describe(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'tab sharing was declined — press play again to try once more';
  if (name === 'NotFoundError') return 'no tab was shared';
  if (name === 'NotSupportedError') return 'this browser cannot share tab audio';
  return err instanceof Error && err.message !== '' ? err.message : 'could not capture this tab';
}

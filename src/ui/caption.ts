/**
 * The one line of text the page ever says about itself.
 *
 * A whole-track analysis takes tens of seconds, and the user has just pasted a
 * link into an otherwise empty screen: something has to say that the wait is
 * deliberate. But a progress *bar* would be a piece of chrome sitting over a
 * visualizer whose whole point is that there is no chrome, so this is plain
 * text at the top of the screen — no box, no fill, no border — counting up and
 * then getting out of the way.
 *
 * `ready` is the last thing it says, and it says it for a second and a half.
 * That is long enough to be read and short enough that nobody has to dismiss
 * it; from then on the page is the card, the button and the smoke.
 */

/** How long `ready` stays up before it fades. */
export const READY_MS = 1500;
/** The last word, spelled once so the test and the page agree on it. */
export const READY_CAPTION = 'ready';

/** `analyzing track 37%` — the caption for a bar at `percent`. */
export function analyzingCaption(percent: number): string {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
  return `analyzing track ${p}%`;
}

export interface Caption {
  /** Count the bar up. Cheap enough to call on every progress report. */
  progress(percent: number): void;
  /** `ready`, which fades out on its own. */
  ready(): void;
  /** Take it away now — a failure, or a track being started over. */
  hide(): void;
}

export function createCaption(root: HTMLElement): Caption {
  const el = document.createElement('div');
  el.className = 'caption';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  root.append(el);

  /** The pending fade after `ready`, if one is pending. */
  let fade: ReturnType<typeof setTimeout> | undefined;

  function show(text: string): void {
    clearTimeout(fade);
    el.textContent = text;
    el.classList.add('is-in');
  }

  return {
    progress(percent: number): void {
      show(analyzingCaption(percent));
    },

    ready(): void {
      show(READY_CAPTION);
      fade = setTimeout(() => el.classList.remove('is-in'), READY_MS);
    },

    hide(): void {
      clearTimeout(fade);
      el.classList.remove('is-in');
    },
  };
}

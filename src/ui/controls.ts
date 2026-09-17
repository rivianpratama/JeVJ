/**
 * Everything the user touches to get sound going: the top URL bar, the drop
 * zone for local audio, and the play/pause pill under the card.
 *
 * Owns no playback state of its own beyond what it needs to draw itself — it
 * reports intent through the handlers and is told what to show via setPlaying.
 */

import { toast } from './toast';

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|aiff?)$/i;

export interface ControlHandlers {
  onSubmitUrl(url: string): void;
  onPlay(): void;
  onPause(): void;
  onFile(f: File): void;
}

export interface Controls {
  setPlaying(b: boolean): void;
  setBusy(b: boolean): void;
}

export function createControls(root: HTMLElement, h: ControlHandlers): Controls {
  let playing = false;

  // ---- top bar -----------------------------------------------------------
  const topbar = document.createElement('div');
  topbar.className = 'topbar';

  const form = document.createElement('form');
  form.className = 'urlbar';
  form.autocomplete = 'off';

  const input = document.createElement('input');
  input.className = 'urlbar-input';
  input.type = 'text';
  input.placeholder = 'paste a youtube link';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'youtube link');

  form.append(input);
  // The bar has no submit button, so don't rely on implicit submission.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (value !== '') h.onSubmitUrl(value);
  });

  const hint = document.createElement('button');
  hint.className = 'drophint';
  hint.type = 'button';
  hint.textContent = 'or drop an audio file';

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'audio/*';
  picker.className = 'visually-hidden';
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file) offerFile(file);
    picker.value = '';
  });
  hint.addEventListener('click', () => picker.click());

  topbar.append(form, hint, picker);

  // ---- transport ---------------------------------------------------------
  const transport = document.createElement('div');
  transport.className = 'transport';

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.textContent = '▶';
  toggle.setAttribute('aria-label', 'play');
  toggle.addEventListener('click', () => fire());
  transport.append(toggle);

  root.append(topbar, transport);

  function fire(): void {
    if (toggle.disabled) return;
    if (playing) h.onPause();
    else h.onPlay();
  }

  function offerFile(file: File): void {
    if (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)) h.onFile(file);
    else toast('that is not an audio file', 'error');
  }

  // ---- whole-page drag and drop -----------------------------------------
  let dragDepth = 0;
  const endDrag = (): void => {
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
  };

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth -= 1;
    if (dragDepth <= 0) endDrag();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    endDrag();
    const file = e.dataTransfer?.files?.[0];
    if (file) offerFile(file);
  });

  // ---- fullscreen --------------------------------------------------------
  /**
   * `F` puts the visualizer on the whole screen and takes the chrome away with
   * it — the link bar and the label fade out, and the play button with them.
   * They are still *there*: everything comes back under the pointer, because a
   * control you cannot find is worse than one you can see. The class does the
   * hiding (see `styles.css`); this only follows the browser's own event, so
   * leaving fullscreen by any route — Escape, the system chrome — restores the
   * UI as well.
   */
  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast('this browser would not go fullscreen', 'error');
    }
  }

  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-immersive', document.fullscreenElement !== null);
  });

  // ---- keyboard ----------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      fire();
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      void toggleFullscreen();
    }
  });

  return {
    setPlaying(b: boolean): void {
      playing = b;
      toggle.textContent = b ? '❚❚' : '▶';
      toggle.setAttribute('aria-label', b ? 'pause' : 'play');
      toggle.classList.toggle('is-playing', b);
    },
    setBusy(b: boolean): void {
      toggle.disabled = b;
      toggle.classList.toggle('is-busy', b);
      form.classList.toggle('is-busy', b);
    },
  };
}

/** True when the event target is a field the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

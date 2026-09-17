/**
 * Everything the user touches: the input bar, and the one button.
 *
 * v2 has two screens and this file draws both. Before a track there is nothing
 * on the page but a text field in the middle of it and a line under it saying
 * a file would do as well — no header, no logo, no buttons, because there is
 * exactly one thing to do next. After a track is loaded the field is gone for
 * good (changing track is a reload) and what is left is a single glass circle
 * at the exact centre of the screen, over the card, which fades out two
 * seconds after the pointer stops and comes back the moment it moves.
 *
 * It owns no playback state beyond what it needs to draw itself: it reports
 * intent through the handlers and is told what to show.
 */

import { toast } from './toast';

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|aiff?)$/i;

/** How long the button waits after the pointer stops before it fades out. */
const IDLE_HIDE_MS = 2000;

export interface ControlHandlers {
  onSubmitUrl(url: string): void;
  onPlay(): void;
  onPause(): void;
  onFile(f: File): void;
}

export interface Controls {
  setPlaying(b: boolean): void;
  /** The input bar: up in `empty`, gone from the moment a track is taken. */
  setInputVisible(b: boolean): void;
  /** The centre button: up from `ready` onward, never while analyzing. */
  setButtonVisible(b: boolean): void;
}

export function createControls(root: HTMLElement, h: ControlHandlers): Controls {
  let playing = false;

  // ---- the input, centred in an empty page --------------------------------
  const inputbar = document.createElement('div');
  inputbar.className = 'inputbar is-on';

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

  inputbar.append(form, hint, picker);

  // ---- the button, at the exact centre of the screen ----------------------
  const transport = document.createElement('div');
  transport.className = 'transport';

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.textContent = '▶';
  toggle.setAttribute('aria-label', 'play');
  toggle.addEventListener('click', () => fire());
  transport.append(toggle);

  root.append(inputbar, transport);

  function fire(): void {
    if (playing) h.onPause();
    else h.onPlay();
  }

  function offerFile(file: File): void {
    if (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)) h.onFile(file);
    else toast('that is not an audio file', 'error');
  }

  // ---- the button's own idle timer ---------------------------------------
  /**
   * The button is the only thing on screen while a track plays, so it is the
   * only thing that can be in the way. It goes when the pointer stops and
   * comes back when it moves — never while paused, because a paused page with
   * no visible way to resume it is a broken page.
   */
  let idle: ReturnType<typeof setTimeout> | undefined;

  function wake(): void {
    transport.classList.remove('is-idle');
    clearTimeout(idle);
    if (!playing) return;
    idle = setTimeout(() => transport.classList.add('is-idle'), IDLE_HIDE_MS);
  }

  window.addEventListener('pointermove', wake);
  window.addEventListener('pointerdown', wake);

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
   * it. Everything comes back under the pointer, because a control you cannot
   * find is worse than one you can see. The class does the hiding (see
   * `styles.css`); this only follows the browser's own event, so leaving
   * fullscreen by any route — Escape, the system chrome — restores the UI.
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
      // A focused button activates itself on space, and the pointer leaves the
      // button focused after every press. Preventing the default here would
      // cancel that activation, and firing here as well would toggle twice and
      // land back where it started — so when the button has it, it is the
      // button's key.
      if (e.target === toggle) return;
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
      // Paused: the button stays. Playing: it starts counting down again.
      wake();
    },
    setInputVisible(b: boolean): void {
      inputbar.classList.toggle('is-on', b);
    },
    setButtonVisible(b: boolean): void {
      transport.classList.toggle('is-on', b);
      if (b) wake();
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

/**
 * The one failure this app has: anything the pipeline throws puts the page back
 * on the empty screen with a toast.
 *
 * `createTransport` reaches for the document (the controls, the toast stack)
 * and for Web Audio (the graph is built inside the gesture), and the suite runs
 * in plain Node. Rather than take a DOM implementation as a dependency for one
 * path, the handful of things those two modules actually touch are stubbed
 * below — `createElement` and its five properties, the window's listeners, an
 * `AudioContext` with an analyser on it. It is about sixty lines, and what it
 * buys is the only test in the suite that drives a real failure the whole way
 * from "this file will not decode" to "the input bar is back".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Listener {
  (event: unknown): void;
}

/** Every element the controls, the caption and the toast build. */
function fakeElement(tag: string): Record<string, unknown> {
  const listeners = new Map<string, Listener[]>();
  const classes = new Set<string>();
  const el: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    type: '',
    style: {},
    dataset: {},
    children: [] as unknown[],
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      toggle: (c: string, on?: boolean) => void (on === true ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    append: (...nodes: unknown[]) => void (el['children'] as unknown[]).push(...nodes),
    remove: () => undefined,
    requestSubmit: () => undefined,
    click: () => undefined,
    focus: () => undefined,
    addEventListener(type: string, fn: Listener): void {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: () => undefined,
    fire(type: string, event: unknown): void {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
  return el;
}

/** The window's and document's listeners, so a drop can be delivered. */
function installDom(): { fire: (type: string, event: unknown) => void } {
  const listeners = new Map<string, Listener[]>();
  const on = (type: string, fn: Listener): void => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  };
  const body = fakeElement('body');
  const doc = {
    body,
    documentElement: fakeElement('html'),
    fullscreenElement: null,
    createElement: (tag: string) => fakeElement(tag),
    addEventListener: on,
    removeEventListener: () => undefined,
    exitFullscreen: async () => undefined,
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    addEventListener: on,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  // The graph is built inside the gesture that starts a track, so it has to
  // exist even though nothing in this test listens to a single sample.
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createAnalyser(): unknown {
      return {
        fftSize: 4096,
        frequencyBinCount: 2048,
        smoothingTimeConstant: 0,
        minDecibels: -100,
        maxDecibels: 0,
        connect: () => undefined,
        getFloatFrequencyData: () => undefined,
        getFloatTimeDomainData: () => undefined,
      };
    }
    createMediaElementSource(): unknown {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    async resume(): Promise<void> {}
    async decodeAudioData(): Promise<never> {
      throw new Error('EncodingError');
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);

  return { fire: (type, event) => void (listeners.get(type) ?? []).forEach((fn) => fn(event)) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../../src/ui/toast');
  vi.resetModules();
});

describe('createTransport', () => {
  let dom: { fire: (type: string, event: unknown) => void };

  beforeEach(() => {
    dom = installDom();
  });

  it('lands back on the empty screen, with a toast, when a track will not decode', async () => {
    const shown: Array<[string, string | undefined]> = [];
    // The toast module keeps a stack of its own at module scope, so it is
    // mocked rather than driven: what is under test is that a failure reaches
    // it at all, and with what words.
    vi.doMock('../../src/ui/toast', () => ({
      toast: (message: string, kind?: string) => void shown.push([message, kind]),
    }));

    const { createTransport } = await import('../../src/app/transport');
    const { CueTimeline } = await import('../../src/timeline/timeline');

    const caption = { progress: () => undefined, ready: () => undefined, hide: vi.fn() };
    const card = {
      video: fakeElement('video') as unknown as HTMLVideoElement,
      frame: null,
      setVisible: () => undefined,
      dispose: () => undefined,
    };

    const transport = createTransport({
      root: fakeElement('div') as unknown as HTMLElement,
      card: card as never,
      caption,
      timeline: new CueTimeline(),
      onGraph: () => undefined,
    });
    expect(transport.state()).toBe('empty');

    const file = new File([new Uint8Array(8)], 'broken.wav', { type: 'audio/wav' });
    dom.fire('drop', { preventDefault: () => undefined, dataTransfer: { files: [file] } });
    // The drop is synchronous up to the first await; the decode rejects a
    // microtask later and the catch runs after that.
    expect(transport.state()).toBe('analyzing');
    await vi.waitFor(() => expect(transport.state()).toBe('empty'));

    expect(shown).toEqual([['that audio could not be decoded', 'error']]);
    expect(caption.hide).toHaveBeenCalled();
  });
});

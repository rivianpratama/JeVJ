import { describe, expect, it, vi } from 'vitest';
import { createFileFlow } from '../../src/app/fileFlow';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
import { CueTimeline } from '../../src/timeline/timeline';
import { clickTrack } from '../helpers/synth';
import type { DecodedFile } from '../../src/app/sources';
import type { MoodClient } from '../../src/mood/moodClient';

// The flow toasts its progress, and a toast wants a document. Nothing here is
// about what the user was told.
vi.mock('../../src/ui/toast', () => ({ toast: () => {} }));

const SR = 44100;
const SECONDS = 12;

/**
 * The half of `HTMLAudioElement` the flow is allowed to touch, with a record
 * of everything it did touch.
 *
 * The point of the fake is what it is *missing*: the only methods on it are
 * the two listener calls and a `currentTime` to read. A flow that paused the
 * element, reloaded it or revoked its source would throw here rather than
 * quietly stopping the music, which is the failure this file is about.
 */
function fakeElement(): {
  el: HTMLAudioElement;
  listeners: string[];
  fire: (event: string) => void;
  paused: number;
} {
  const handlers = new Map<string, Array<() => void>>();
  const log = { listeners: [] as string[], paused: 0 };

  const el = {
    currentTime: 3,
    pause(): void {
      log.paused += 1;
    },
    addEventListener(event: string, handler: () => void): void {
      log.listeners.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    removeEventListener(): void {},
  } as unknown as HTMLAudioElement;

  return {
    el,
    get listeners() {
      return log.listeners;
    },
    get paused() {
      return log.paused;
    },
    fire(event: string): void {
      for (const h of handlers.get(event) ?? []) h();
    },
  };
}

/** A decoded file the sweep can actually chew on: 12 s of 128 BPM clicks. */
function decoded(el: HTMLAudioElement): DecodedFile {
  const mono = clickTrack(128, SECONDS, SR);
  const buffer = {
    sampleRate: SR,
    numberOfChannels: 1,
    length: mono.length,
    duration: SECONDS,
    getChannelData: () => mono,
  } as unknown as AudioBuffer;
  return { el, buffer, ctx: {} as AudioContext };
}

/** A client that answers instantly, and counts how often it was asked. */
function fakeClient(): { client: MoodClient; calls: () => number } {
  let calls = 0;
  const client = {
    ask: async () => {
      calls += 1;
      return { mood: NEUTRAL_MOOD, latencyMs: 1, tokens: 1 };
    },
  } as unknown as MoodClient;
  return { client, calls: () => calls };
}

describe('createFileFlow', () => {
  /** The audio clock is 20 s in by the time the sweep finishes. */
  const CTX_NOW = 20;

  function build(): {
    timeline: CueTimeline;
    flow: ReturnType<typeof createFileFlow>;
    calls: () => number;
  } {
    const timeline = new CueTimeline();
    const { client, calls } = fakeClient();
    const flow = createFileFlow({
      timeline,
      client,
      ctx: () => ({ currentTime: CTX_NOW }) as AudioContext,
    });
    return { timeline, flow, calls };
  }

  /**
   * The bug report this file was written for said a dropped file stopped
   * playing mid-track, around the moment the offline sweep finished. It does
   * not: the sweep never touches the element except to listen to it. Measured
   * in Chrome, the element played its whole 30 s and fired `ended` on time —
   * what stopped was the *analysis*, because `requestAnimationFrame` runs at
   * 1.3 Hz in a hidden pane and the HUD then reads `rms 0.000`. See the
   * `fps` row on the overlay and `AnalysisLoop.stepsPerSec`.
   */
  it('never pauses or reloads the element it was handed', async () => {
    const { flow } = build();
    const audio = fakeElement();

    await flow.preAnalyse(decoded(audio.el));
    audio.fire('play');

    expect(audio.paused).toBe(0);
    // Listening is all it may do, and only for the two events that move the
    // mapping between track time and the audio clock.
    expect(new Set(audio.listeners)).toEqual(new Set(['play', 'seeked']));
  });

  it('puts the swept cues on the audio clock when the element plays', async () => {
    const { timeline, flow } = build();
    const audio = fakeElement();

    await flow.preAnalyse(decoded(audio.el));
    // Nothing until it plays: only the transport knows where track time sits.
    expect(timeline.cues().filter((c) => c.source === 'offline')).toHaveLength(0);

    audio.fire('play');
    const offline = timeline.cues().filter((c) => c.source === 'offline');
    expect(offline.length).toBeGreaterThan(0);
    // Track time plus the offset between the clocks: 20 s of context against
    // 3 s of element.
    expect(Math.min(...offline.map((c) => c.t))).toBeGreaterThanOrEqual(CTX_NOW - 3);
  });

  it('writes nothing for a file that has since been replaced', async () => {
    const { timeline, flow } = build();
    const audio = fakeElement();

    const sweep = flow.preAnalyse(decoded(audio.el));
    flow.cancel();
    await sweep;
    audio.fire('play');

    expect(timeline.cues().filter((c) => c.source === 'offline')).toHaveLength(0);
    expect(audio.paused).toBe(0);
  });

  it('leaves the element of a superseded pass alone', async () => {
    const { timeline, flow } = build();
    const first = fakeElement();
    const second = fakeElement();

    const early = flow.preAnalyse(decoded(first.el));
    const late = flow.preAnalyse(decoded(second.el));
    await Promise.all([early, late]);

    // The second pass owns the timeline; the first one's element is untouched
    // — dropping it is the source switch's job, not the sweep's.
    first.fire('play');
    expect(timeline.cues().filter((c) => c.source === 'offline')).toHaveLength(0);
    expect(first.paused).toBe(0);

    second.fire('play');
    expect(timeline.cues().filter((c) => c.source === 'offline').length).toBeGreaterThan(0);
    expect(second.paused).toBe(0);
  });
});

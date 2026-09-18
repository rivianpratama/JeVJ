import { describe, expect, it } from 'vitest';

import {
  analysisPercent,
  createTrackFlow,
  DOWNLOAD_END,
  downloadPercent,
  downmix,
} from '../../src/app/trackFlow';
import { NEUTRAL_MOOD, ANALYSIS_VERSION } from '../../src/shared/moodSchema';
import { CueTimeline } from '../../src/timeline/timeline';
import { clickTrack } from '../helpers/synth';
import type { TrackAnalysisDeps } from '../../src/app/trackAnalysis';
import type { TrackAnalysis } from '../../src/shared/types';

const SR = 44100;
const SECONDS = 12;
/** The audio clock the element starts playing on. */
const CTX_NOW = 20;
/** Where in the track the element is when it starts. */
const EL_AT = 3;

describe('the progress bar', () => {
  it('gives the download the first 40% of it', () => {
    expect(downloadPercent(0)).toBe(0);
    expect(downloadPercent(50)).toBe(20);
    expect(downloadPercent(100)).toBe(DOWNLOAD_END);
  });

  it('gives the analysis whatever is left of it', () => {
    // A link: the download has already filled 40%.
    expect(analysisPercent(0, DOWNLOAD_END)).toBe(40);
    expect(analysisPercent(0.5, DOWNLOAD_END)).toBe(70);
    expect(analysisPercent(1, DOWNLOAD_END)).toBe(100);
    // A dropped file has no download, so the bar is all analysis.
    expect(analysisPercent(0, 0)).toBe(0);
    expect(analysisPercent(0.5, 0)).toBe(50);
    expect(analysisPercent(1, 0)).toBe(100);
  });

  it('never reports a number off the end of it', () => {
    expect(downloadPercent(-10)).toBe(0);
    expect(downloadPercent(400)).toBe(DOWNLOAD_END);
    expect(downloadPercent(Number.NaN)).toBe(0);
    expect(analysisPercent(2, DOWNLOAD_END)).toBe(100);
    expect(analysisPercent(-1, DOWNLOAD_END)).toBe(40);
    expect(analysisPercent(Number.NaN, DOWNLOAD_END)).toBe(40);
  });
});

describe('downmix', () => {
  it('averages the channels into one', () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 1, 1]);
    const buffer = {
      numberOfChannels: 2,
      getChannelData: (c: number) => (c === 0 ? left : right),
    } as unknown as AudioBuffer;
    expect([...downmix(buffer)]).toEqual([0.5, 0.5, 0]);
  });
});

/** The half of a media element the flow is allowed to touch. */
function fakeElement(): {
  el: HTMLMediaElement;
  fire: (event: string) => void;
  src: () => string;
  /** Move the playhead, as a seek does before `seeked` fires. */
  seekTo: (t: number) => void;
} {
  const handlers = new Map<string, Array<() => void>>();
  const el = {
    src: '',
    currentTime: EL_AT,
    load(): void {},
    addEventListener(event: string, handler: () => void): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as HTMLMediaElement;

  return {
    el,
    src: () => el.src,
    seekTo(t: number): void {
      el.currentTime = t;
    },
    fire(event: string): void {
      for (const h of handlers.get(event) ?? []) h();
    },
  };
}

/** A context that decodes whatever it is handed into 12 s of clicks. */
function fakeCtx(o: { decodes?: boolean } = {}): AudioContext {
  const mono = clickTrack(128, SECONDS, SR);
  const buffer = {
    sampleRate: SR,
    numberOfChannels: 1,
    length: mono.length,
    duration: SECONDS,
    getChannelData: () => mono,
  } as unknown as AudioBuffer;
  return {
    currentTime: CTX_NOW,
    decodeAudioData: async () => {
      // What a browser does with a file that is not audio: the promise
      // rejects, and the name of the error is not something to show anyone.
      if (o.decodes === false) throw new Error('EncodingError: Unable to decode audio data');
      return buffer;
    },
  } as unknown as AudioContext;
}

/** A model that answers instantly, and counts how often it was asked. */
function fakeDeps(): {
  deps: (o: { title?: string; videoId?: string }) => TrackAnalysisDeps;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    // The ids are passed through, so the record the flow caches carries them.
    deps: (about) => ({
      ...about,
      askJev: async () => {
        calls += 1;
        return NEUTRAL_MOOD;
      },
      askTransition: async (inputs) => {
        calls += 1;
        return inputs.map(() => ({
          kind: 'none' as const,
          kindP: {
            drop: 0, build_start: 0, breakdown: 0, break_silence: 0, vocal_entry: 0,
            scream_peak: 0, quiet_fall: 0, tempo_change: 0, key_change: 0, none: 1,
          },
          intensity: 0,
          dramatic: 0,
          release: 0.5,
          confidence: 0.5,
        }));
      },
    }),
  };
}

/** An empty but valid analysis record, as the cache would hand one back. */
function cachedRecord(): TrackAnalysis {
  return {
    version: ANALYSIS_VERSION,
    title: 'from the cache',
    durationSec: SECONDS,
    segments: [],
    transitions: [],
    cues: [{ t: 1.5, source: 'offline', impact: 0.9 }],
    log: [],
  };
}

/** The local API, faked: the analysis cache, the job, and the media file. */
function fakeFetch(o: { cached?: TrackAnalysis } = {}): {
  fetchFn: typeof fetch;
  posted: () => TrackAnalysis | null;
  urls: string[];
} {
  const urls: string[] = [];
  let posted: TrackAnalysis | null = null;

  const json = (body: unknown, ok = true): Response =>
    ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response;

  const fetchFn = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/resolve') return json({ jobId: 'job-1' });
    if (url.startsWith('/api/job/')) {
      return json({
        id: 'job-1',
        videoId: 'jNQXAC9IVRw',
        status: 'done',
        percent: 100,
        title: 'me at the zoo',
        durationSec: SECONDS,
        mediaUrl: '/media/jNQXAC9IVRw.mp4',
      });
    }
    if (url.startsWith('/api/analysis/')) {
      if (init?.method === 'POST') {
        posted = JSON.parse(String(init.body)) as TrackAnalysis;
        return json({ ok: true });
      }
      return o.cached === undefined ? json({ error: 'nope' }, false) : json(o.cached);
    }
    if (url.startsWith('/media/')) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response;
    }
    throw new Error(`unexpected fetch of ${url}`);
  }) as unknown as typeof fetch;

  return { fetchFn, urls, posted: () => posted };
}

function build(o: { cached?: TrackAnalysis; decodes?: boolean } = {}): {
  flow: ReturnType<typeof createTrackFlow>;
  timeline: CueTimeline;
  progress: number[];
  element: ReturnType<typeof fakeElement>;
  model: ReturnType<typeof fakeDeps>;
  api: ReturnType<typeof fakeFetch>;
  resolved: () => number;
} {
  const timeline = new CueTimeline();
  const element = fakeElement();
  const model = fakeDeps();
  const api = fakeFetch(o);
  const progress: number[] = [];
  let resolved = 0;

  const ctx = fakeCtx(o);
  const flow = createTrackFlow({
    timeline,
    el: element.el,
    ctx: () => ctx,
    onProgress: (p) => progress.push(p),
    onResolved: () => {
      resolved += 1;
    },
    fetchFn: api.fetchFn,
    deps: model.deps,
  });
  return { flow, timeline, progress, element, model, api, resolved: () => resolved };
}

/**
 * The object URLs handed out and given back, in order.
 *
 * There is exactly one media element for the life of the page, so a file's blob
 * URL is only released when the *next* track takes the element — and a leak
 * here is a decoded track held in memory for as long as the tab is open.
 */
function trackObjectUrls(): { created: string[]; revoked: string[]; restore: () => void } {
  const created: string[] = [];
  const revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let n = 0;
  URL.createObjectURL = (() => {
    const url = `blob:jevj/${++n}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => void revoked.push(url)) as typeof URL.revokeObjectURL;
  return {
    created,
    revoked,
    restore(): void {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    },
  };
}

describe('createTrackFlow', () => {
  it('decodes, analyzes and maps a dropped file onto the audio clock', async () => {
    const { flow, timeline, progress, element } = build();
    const file = new File([new Uint8Array(8)], 'track.wav', { type: 'audio/wav' });

    const opened = await flow.openFile(file);
    expect(opened).toEqual({ video: false, durationSec: SECONDS });
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(100);

    // Nothing is on the timeline until the element actually starts: only then
    // is there an offset between track time and the audio clock.
    expect([...timeline.cues()]).toHaveLength(0);
    element.fire('playing');
    const cues = [...timeline.cues()];
    expect(cues.length).toBeGreaterThan(0);
    // Track time plus (ctx.currentTime - el.currentTime). A cue that is merely
    // "somewhere after the offset" could be anywhere in the track, so what is
    // asserted is the whole mapping: every cue lands inside the twelve seconds
    // of audio there actually are, the first one at the top of the track — the
    // sweep backfills the grid to 0 — and the last before the end of it.
    // (The *exact* arithmetic is pinned against a known cue in the cached-record
    // case below, where the track time is a number this file chose.)
    const offset = CTX_NOW - EL_AT;
    const trackTimes = cues.map((c) => c.t - offset).sort((a, b) => a - b);
    expect(trackTimes[0]).toBeLessThan(1);
    expect(trackTimes[0]).toBeGreaterThanOrEqual(0);
    expect(trackTimes[trackTimes.length - 1]).toBeLessThanOrEqual(SECONDS);
    // And the mapping is a function of the two clocks alone: firing `playing`
    // again from the same place reproduces every time exactly.
    element.fire('playing');
    expect([...timeline.cues()].map((c) => c.t - offset).sort((a, b) => a - b)).toEqual(trackTimes);
  }, 60_000);

  it('downloads a link, plays the file it got, and caches what it learned', async () => {
    const { flow, progress, element, api, resolved } = build();

    const opened = await flow.open('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(opened?.video).toBe(true);
    expect(resolved()).toBe(1);
    expect(element.src()).toBe('/media/jNQXAC9IVRw.mp4');
    // The download filled the first 40% and the analysis the rest.
    expect(progress.some((p) => p === DOWNLOAD_END)).toBe(true);
    expect(progress[progress.length - 1]).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    // And the record went back to the cache under its video id.
    expect(api.posted()?.videoId).toBe('jNQXAC9IVRw');
  }, 60_000);

  it('skips the analysis entirely when the server has already done it', async () => {
    const { flow, timeline, progress, element, model } = build({ cached: cachedRecord() });

    const opened = await flow.open('https://youtu.be/jNQXAC9IVRw');
    expect(opened?.video).toBe(true);
    expect(model.calls()).toBe(0);
    expect(progress[progress.length - 1]).toBe(100);

    element.fire('playing');
    expect([...timeline.cues()].map((c) => c.t)).toEqual([1.5 + CTX_NOW - EL_AT]);
  }, 60_000);

  it('refuses something that is not a youtube link', async () => {
    const { flow } = build();
    await expect(flow.open('https://example.com/song')).rejects.toThrow(/youtube/);
  });

  it('starts the next track over: no cues from the last one, and its blob let go', async () => {
    const urls = trackObjectUrls();
    try {
      // A dropped file has no video id, so nothing is read from or written to
      // the analysis cache: both tracks are analyzed for real.
      const { flow, timeline, element } = build();

      await flow.openFile(new File([new Uint8Array(8)], 'first.wav', { type: 'audio/wav' }));
      element.fire('playing');
      const firstTrack = [...timeline.cues()].length;
      expect(firstTrack).toBeGreaterThan(0);
      expect(urls.created).toHaveLength(1);

      // The second track's `begin()` runs before a byte of it is read, so the
      // first track's cues are off the timeline for the whole of the second
      // one's analysis rather than only once it finishes.
      const second = flow.openFile(new File([new Uint8Array(8)], 'second.wav', { type: 'audio/wav' }));
      expect([...timeline.cues()]).toHaveLength(0);
      await second;

      // One element for the life of the page means the first blob is only
      // released when the second takes its place.
      expect(urls.revoked).toEqual([urls.created[0]]);
      expect(element.src()).toBe(urls.created[1]);
      element.fire('playing');
      expect([...timeline.cues()]).toHaveLength(firstTrack);
    } finally {
      urls.restore();
    }
  }, 60_000);

  it('re-maps the offset on a seek, so a cue still lands where the ear is', async () => {
    const { flow, timeline, element } = build({ cached: cachedRecord() });
    await flow.open('https://youtu.be/jNQXAC9IVRw');

    element.fire('playing');
    expect([...timeline.cues()].map((c) => c.t)).toEqual([1.5 + CTX_NOW - EL_AT]);

    // A seek moves the element's clock without moving the audio context's, so
    // the offset between the two is a different number afterwards. Nothing
    // else on the timeline is re-derived — `replaceSource` rewrites the whole
    // offline source — so a stale offset would put every cue in the track at
    // the wrong instant for the rest of the session.
    const to = 95;
    element.seekTo(to);
    element.fire('seeked');
    expect([...timeline.cues()].map((c) => c.t)).toEqual([1.5 + CTX_NOW - to]);
  }, 60_000);

  it('refuses a file the decoder will not take, in words worth showing', async () => {
    const { flow, timeline } = build({ decodes: false });
    const file = new File([new Uint8Array(8)], 'notes.txt', { type: 'audio/wav' });

    // Not the browser's own message: `EncodingError: Unable to decode audio
    // data` is a sentence about a codec. `transport` puts whatever this throws
    // straight into a toast, and lands the page back on `empty` — see
    // tests/app/transport.test.ts.
    await expect(flow.openFile(file)).rejects.toThrow('that audio could not be decoded');
    expect([...timeline.cues()]).toHaveLength(0);
  });

  it('writes nothing once its track has been replaced', async () => {
    const { flow, timeline, element } = build({ cached: cachedRecord() });
    const pending = flow.open('https://youtu.be/jNQXAC9IVRw');
    flow.cancel();
    expect(await pending).toBeNull();

    element.fire('playing');
    expect([...timeline.cues()]).toHaveLength(0);
  }, 60_000);
});

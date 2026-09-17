import { describe, expect, it } from 'vitest';

import {
  analysisPercent,
  createTrackFlow,
  DOWNLOAD_END,
  downloadPercent,
  downmix,
} from '../../src/app/trackFlow';
import { NEUTRAL_MOOD } from '../../src/shared/moodSchema';
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
    fire(event: string): void {
      for (const h of handlers.get(event) ?? []) h();
    },
  };
}

/** A context that decodes whatever it is handed into 12 s of clicks. */
function fakeCtx(): AudioContext {
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
    decodeAudioData: async () => buffer,
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

function build(o: { cached?: TrackAnalysis } = {}): {
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

  const flow = createTrackFlow({
    timeline,
    el: element.el,
    ctx: fakeCtx,
    onProgress: (p) => progress.push(p),
    onResolved: () => {
      resolved += 1;
    },
    fetchFn: api.fetchFn,
    deps: model.deps,
  });
  return { flow, timeline, progress, element, model, api, resolved: () => resolved };
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
    element.fire('play');
    const cues = [...timeline.cues()];
    expect(cues.length).toBeGreaterThan(0);
    // Track time plus (ctx.currentTime - el.currentTime).
    expect(cues[0]!.t).toBeGreaterThanOrEqual(CTX_NOW - EL_AT);
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

    element.fire('play');
    expect([...timeline.cues()].map((c) => c.t)).toEqual([1.5 + CTX_NOW - EL_AT]);
  }, 60_000);

  it('refuses something that is not a youtube link', async () => {
    const { flow } = build();
    await expect(flow.open('https://example.com/song')).rejects.toThrow(/youtube/);
  });

  it('writes nothing once its track has been replaced', async () => {
    const { flow, timeline, element } = build({ cached: cachedRecord() });
    const pending = flow.open('https://youtu.be/jNQXAC9IVRw');
    flow.cancel();
    expect(await pending).toBeNull();

    element.fire('play');
    expect([...timeline.cues()]).toHaveLength(0);
  }, 60_000);
});

/**
 * The visuals as one object: analysis in, pixels out.
 *
 * `main.ts` should not have to know that the mood the renderer draws with is
 * not quite the mood the mood layer is holding — that the timeline's own
 * answers, which are latency-compensated and may come from a pass over the
 * whole track, win wherever they exist. Nor that "a downbeat happened" is an
 * event on an analysis frame that has to be turned into a decaying number
 * before a shader can use it. That is all here; `main` calls `start()`.
 *
 * It owns its own `requestAnimationFrame`, separate from the analysis loop's.
 * They run at the same rate and could share one, but they are answerable to
 * different things: the analysis must step once per spectrum, and the visuals
 * must draw once per display frame, and a frame where the analyser has nothing
 * new is still a frame the ink has to advance through. Both read the same
 * clock — `features.t`, the audio clock — so a stall in one cannot make the
 * other's time drift.
 *
 * Before there is any audio it runs an idle mode: a 60 BPM clock, bands from
 * slow sines, and `IDLE_MOOD`. The page is never a dead black rectangle.
 */

import { IDLE_MOOD, direct, type FastFrame, type RenderParams } from '../visuals/director';
import { InkFeedback } from '../visuals/scenes/InkFeedback';
import { createVisuals, type Visuals } from '../visuals/renderer';
import type { AnalysisLoop } from './analysisLoop';
import type { CueReader } from './cueReader';
import type { MoodVector } from '../shared/types';

/** How fast a downbeat's flash fades, per the brief. */
const DOWNBEAT_TAU = 0.3;
/** The idle clock: one beat a second, four to the bar. */
const IDLE_BPM = 60;
const IDLE_BEATS_PER_BAR = 4;

export interface VisualLinkOptions {
  canvas: HTMLCanvasElement;
  loop: AnalysisLoop;
  cues: CueReader;
  /** The mood layer's current vector, before the timeline overrides it. */
  mood: () => MoodVector;
}

export interface VisualLink {
  start(): void;
  stop(): void;
  dispose(): void;
}

export function createVisualLink(o: VisualLinkOptions): VisualLink {
  const visuals: Visuals = createVisuals(o.canvas);
  const ink = new InkFeedback();
  visuals.addScene(ink);

  const reduceQuery =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  // One FastFrame and one band array for the life of the page: the render loop
  // must not allocate.
  const bands = new Float32Array(8);
  const fast: FastFrame = {
    rms: 0,
    bands,
    sub: 0,
    onset: 0,
    beatPhase: 0,
    downbeatPulse: 0,
    impact: 0,
    build: 0,
  };
  // The effective mood, rebuilt in place from the mood layer and the timeline
  // — one object for the life of the page, like the FastFrame.
  const mood: MoodVector = { ...IDLE_MOOD };

  let params: RenderParams | null = null;
  let handle = 0;
  let lastTime = Number.NaN;
  /** Audio time of the last downbeat seen, so each one is counted once. */
  let lastDownbeatAt = Number.NEGATIVE_INFINITY;

  function step(): void {
    handle = requestAnimationFrame(step);

    const snap = o.loop.latest();
    const wall = performance.now() / 1000;
    const time = snap === null ? wall : snap.features.t;

    const dt = Number.isFinite(lastTime) ? time - lastTime : 1 / 60;
    lastTime = time;
    // A seek, a source change or a first frame can hand back anything.
    const step_ = dt > 0 && dt < 1 ? dt : 1 / 60;

    if (snap === null) {
      idleFrame(time);
      Object.assign(mood, IDLE_MOOD);
    } else {
      const f = snap.features;
      fast.rms = f.rms;
      bands.set(f.bands.subarray(0, 8));
      fast.sub = f.sub;
      fast.onset = snap.onset;
      fast.beatPhase = snap.phase;

      for (const beat of snap.beats) {
        if (beat.downbeat && beat.t > lastDownbeatAt) lastDownbeatAt = beat.t;
      }
      fast.downbeatPulse = pulseAt(time - lastDownbeatAt);

      // The timeline is read at `now + latency`, so impact and build are what
      // the listener is hearing rather than what the analyser has reached.
      const reading = o.cues.at(time);
      fast.impact = reading.impact;
      fast.build = reading.build;
      merge(mood, o.mood(), reading.mood);

      ink.setMeter(snap.grid.barLength);
    }

    params = direct(mood, fast, step_, params, reduceQuery?.matches === true);
    visuals.frame(step_, params, fast, time);
  }

  /** What the page does before it has heard anything: breathe. */
  function idleFrame(t: number): void {
    const beats = (t * IDLE_BPM) / 60;
    fast.beatPhase = beats - Math.floor(beats);
    for (let i = 0; i < bands.length; i++) {
      // Slow sines at incommensurate rates, so the lobes never line up twice.
      bands[i] = 0.18 + 0.16 * Math.sin(t * (0.11 + i * 0.037) + i * 1.7);
    }
    fast.rms = 0.12 + 0.04 * Math.sin(t * 0.13);
    fast.sub = 0.1 + 0.05 * Math.sin(t * 0.09);
    fast.onset = 0;
    fast.impact = 0;
    fast.build = 0;
    const barPhase = beats / IDLE_BEATS_PER_BAR;
    fast.downbeatPulse = pulseAt((barPhase - Math.floor(barPhase)) * IDLE_BEATS_PER_BAR);
  }

  return {
    start(): void {
      if (handle === 0) handle = requestAnimationFrame(step);
    },
    stop(): void {
      if (handle !== 0) cancelAnimationFrame(handle);
      handle = 0;
      lastTime = Number.NaN;
    },
    dispose(): void {
      if (handle !== 0) cancelAnimationFrame(handle);
      handle = 0;
      visuals.dispose();
    },
  };
}

/** 1 at the instant of a downbeat, decaying with τ = 0.3 s. */
function pulseAt(since: number): number {
  if (!Number.isFinite(since) || since < 0) return 0;
  return Math.exp(-since / DOWNBEAT_TAU);
}

/**
 * The mood the renderer draws with, written into `out`: the mood layer's, with
 * the timeline's overrides on top wherever it has one.
 *
 * The timeline wins because it is the later and better-informed answer — its
 * cues are latency-compensated, and for a dropped file they come from a pass
 * over the whole track that knew what was coming. Where it says nothing, the
 * live mood stands.
 */
function merge(out: MoodVector, base: MoodVector, over: Partial<MoodVector>): void {
  Object.assign(out, base);
  for (const key of Object.keys(over) as (keyof MoodVector)[]) {
    const v = over[key];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[key] = v;
  }
}

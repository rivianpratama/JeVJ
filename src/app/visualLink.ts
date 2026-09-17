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

import {
  IDLE_MOOD,
  createDirector,
  direct,
  type FastFrame,
  type RenderParams,
} from '../visuals/director';
import { InkFeedback } from '../visuals/scenes/InkFeedback';
import { ParticleField } from '../visuals/scenes/ParticleField';
import { Strands } from '../visuals/scenes/Strands';
import { createFrameClock } from './frameClock';
import { createVisuals, type Visuals } from '../visuals/renderer';
import { mergeMood, type MoodSource } from './effectiveMood';
import type { AnalysisLoop } from './analysisLoop';
import type { CueReader } from './cueReader';
import type { MoodVector } from '../shared/types';

/** How fast a downbeat's flash fades, per the brief. */
const DOWNBEAT_TAU = 0.3;
/** The idle clock: one beat a second, four to the bar. */
const IDLE_BPM = 60;
const IDLE_BEATS_PER_BAR = 4;
/**
 * The band energies the idle mode pretends to hear. They never reach zero:
 * the ambient injection is scaled by them, and a field that breathes down to
 * nothing is a field that empties.
 */
const IDLE_BAND_MID = 0.35;
const IDLE_BAND_SWING = 0.15;

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
  /**
   * The mood the renderer is drawing with, live. The object is rebuilt in
   * place every frame, so read it, print it, and do not keep it.
   */
  mood(): MoodVector;
  /** Which layer that mood came from. */
  moodSource(): MoodSource;
}

export function createVisualLink(o: VisualLinkOptions): VisualLink {
  const visuals: Visuals = createVisuals(o.canvas);
  const ink = new InkFeedback();
  // Slot order does not matter to the renderer — it matches scenes to weights
  // by name — but the ink is added first because it is the bed the others are
  // mixed over.
  visuals.addScene(ink);
  visuals.addScene(new ParticleField());
  visuals.addScene(new Strands());

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
  let moodSrc: MoodSource = 'idle';

  const director = createDirector();
  // The renderer's own clock. The audio clock jumps on a seek and stalls
  // whenever the analyser has no new snapshot; `uTime` may do neither.
  const clock = createFrameClock();

  let params: RenderParams | null = null;
  let handle = 0;
  /** Audio time of the last downbeat seen, so each one is counted once. */
  let lastDownbeatAt = Number.NEGATIVE_INFINITY;

  function step(): void {
    handle = requestAnimationFrame(step);

    const snap = o.loop.latest();
    const wall = performance.now() / 1000;
    const audioTime = snap === null ? wall : snap.features.t;
    const tick = clock.advance(audioTime, wall);

    if (snap === null) {
      idleFrame(tick.time);
      Object.assign(mood, IDLE_MOOD);
      moodSrc = 'idle';
    } else {
      const f = snap.features;
      fast.rms = f.rms;
      bands.set(f.bands);
      fast.sub = f.sub;
      fast.onset = snap.onset;
      fast.beatPhase = snap.phase;

      for (const beat of snap.beats) {
        if (beat.downbeat && beat.t > lastDownbeatAt) lastDownbeatAt = beat.t;
      }
      fast.downbeatPulse = pulseAt(audioTime - lastDownbeatAt);

      // The timeline is read at `now + latency`, so impact and build are what
      // the listener is hearing rather than what the analyser has reached.
      const reading = o.cues.at(audioTime);
      fast.impact = reading.impact;
      fast.build = reading.build;
      moodSrc = mergeMood(mood, o.mood(), reading.mood);

      ink.setMeter(snap.grid.barLength);
    }

    params = direct(director, mood, fast, tick.step, params, reduceQuery?.matches === true);
    visuals.frame(tick.step, params, fast, tick.time);
  }

  /** What the page does before it has heard anything: breathe. */
  function idleFrame(t: number): void {
    const beats = (t * IDLE_BPM) / 60;
    fast.beatPhase = beats - Math.floor(beats);
    for (let i = 0; i < bands.length; i++) {
      // Slow sines at incommensurate rates, so the lobes never line up twice.
      bands[i] = IDLE_BAND_MID + IDLE_BAND_SWING * Math.sin(t * (0.11 + i * 0.037) + i * 1.7);
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
    },
    dispose(): void {
      if (handle !== 0) cancelAnimationFrame(handle);
      handle = 0;
      visuals.dispose();
    },
    mood: () => mood,
    moodSource: () => moodSrc,
  };
}

/** 1 at the instant of a downbeat, decaying with τ = 0.3 s. */
function pulseAt(since: number): number {
  if (!Number.isFinite(since) || since < 0) return 0;
  return Math.exp(-since / DOWNBEAT_TAU);
}


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
import { Breath } from '../visuals/scenes/Breath';
import { Smoke } from '../visuals/scenes/Smoke';
import { ParticleField } from '../visuals/scenes/ParticleField';
import { Relief } from '../visuals/scenes/Relief';
import { Strands } from '../visuals/scenes/Strands';
import { createFrameClock } from './frameClock';
import { createDprState, stepDpr } from '../visuals/dprGovernor';
import { PROBE_WINDOW_SEC, createVisuals, drawsAtWeight, type Visuals } from '../visuals/renderer';
import { annulusFor } from '../visuals/smokeMath';
import { mergeMood, type MoodSource } from './effectiveMood';
import type { AnalysisLoop } from './analysisLoop';
import type { CueReader } from './cueReader';
import type { MoodVector, TransitionKind } from '../shared/types';

/** How fast a downbeat's flash fades, per the brief. */
const DOWNBEAT_TAU = 0.3;
/**
 * How long the frame cost is worth measuring once audio starts. The first
 * seconds of a track are when the particle tier makes its decision, and on a
 * machine without a GPU timer that is the only stretch the fallback probe runs.
 */
const PROBE_ON_AUDIO_SEC = 10;
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
/**
 * The onset an idle beat reports, and how many beats apart they are.
 *
 * An idle page has no transients, so before v2 it reported none — and the
 * smoke's filaments are seeded by onsets, which meant the one thing that makes
 * the picture read as *smoke* rather than as a wash never happened on a page
 * that had heard nothing. The direction asks for exactly this: "sparse
 * filaments on the 60 BPM idle clock". Every other beat, so they are sparse:
 * one filament burst every two seconds, each alight for about one.
 */
const IDLE_ONSET = 0.8;
const IDLE_ONSET_EVERY = 2;

export interface VisualLinkOptions {
  canvas: HTMLCanvasElement;
  loop: AnalysisLoop;
  cues: CueReader;
  /** The mood layer's current vector, before the timeline overrides it. */
  mood: () => MoodVector;
  /**
   * The square the smoke is born around: the card's own box.
   *
   * Optional, and absent is a supported answer rather than a missing one — an
   * audio file plays with no card at all, and the annulus then goes round a
   * virtual square of the same size at the middle of the frame. See
   * `annulusFor`.
   */
  card?: () => HTMLElement | null;
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
  /** How many points the particle cloud is running, as the HUD prints it. */
  particleTier(): string;
  /** What a frame costs on the GPU, in milliseconds, or `NaN` before one has been measured. */
  frameMs(): number;
  /** The device pixel ratio the renderer is drawing at. */
  pixelRatio(): number;
}

export function createVisualLink(o: VisualLinkOptions): VisualLink {
  const visuals: Visuals = createVisuals(o.canvas);
  const smoke = new Smoke();
  const particles = new ParticleField();
  // Slot order does not matter to the renderer — it matches scenes to weights
  // by name — but the ink is added first because it is the bed the others are
  // mixed over.
  visuals.addScene(smoke);
  visuals.addScene(particles);
  visuals.addScene(new Strands());
  visuals.addScene(new Relief());
  visuals.addScene(new Breath());

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
    beatConf: 0,
    regular: 0,
  };
  // The effective mood, rebuilt in place from the mood layer and the timeline
  // — one object for the life of the page, like the FastFrame.
  const mood: MoodVector = { ...IDLE_MOOD };
  let moodSrc: MoodSource = 'idle';

  const director = createDirector();
  // How many pixels this machine can afford. It watches the same measured
  // frame time the particle tier does, and for the same reason: what the
  // renderer can spend is a fact about the machine, and the only honest way to
  // learn it is to try.
  const dpr = createDprState();
  // The renderer's own clock. The audio clock jumps on a seek and stalls
  // whenever the analyser has no new snapshot; `uTime` may do neither.
  const clock = createFrameClock();

  let params: RenderParams | null = null;
  let handle = 0;
  /**
   * The transition kinds that went by since the last frame. One array for the
   * life of the page, emptied and refilled — the usual answer is nothing, and
   * the render loop must not allocate.
   */
  const transitions: TransitionKind[] = [];
  /** The audio time the last frame read the timeline at, so no cue is seen twice. */
  let lastCueRead = Number.NaN;
  /** The canvas size the card rectangle was last measured against. */
  let annulusW = 0;
  let annulusH = 0;
  /** Audio time of the last downbeat seen, so each one is counted once. */
  let lastDownbeatAt = Number.NEGATIVE_INFINITY;
  /** Whether the last frame had audio, so the start of it can be noticed. */
  let wasPlaying = false;

  // A tab coming back from the background has been throttled, composited
  // differently, possibly moved to another GPU. Measure again before trusting
  // anything about what a frame costs.
  const onVisibility = (): void => {
    if (!document.hidden) visuals.requestFrameTiming(PROBE_WINDOW_SEC);
  };
  document.addEventListener('visibilitychange', onVisibility);

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
      // What the rotation is driven by: how sure the grid is, and how even the
      // onsets are. Both are the analysis's own readings rather than judgments.
      fast.beatConf = snap.grid.confidence;
      fast.regular = snap.rhythm.regular;

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

      smoke.setMeter(snap.grid.barLength);
    }

    // The seams that went by since the last frame. In idle mode there is no
    // timeline to read, and `lastCueRead` is NaN on the very first frame of
    // audio — a frame with no previous instant has no interval to report.
    transitions.length = 0;
    if (snap !== null) {
      if (Number.isFinite(lastCueRead)) o.cues.passed(lastCueRead, audioTime, transitions);
      lastCueRead = audioTime;
    } else {
      lastCueRead = Number.NaN;
    }

    updateAnnulus();

    const reduced = reduceQuery?.matches === true;
    const playing = snap !== null;
    if (playing && !wasPlaying) visuals.requestFrameTiming(PROBE_ON_AUDIO_SEC);
    wasPlaying = playing;

    // What the *last* frame cost decides how much work this one is given, and
    // `params` is that same frame's mix — so the cost and the question "was the
    // cloud even in it" come from one frame rather than two. The cloud only
    // earns a promotion while there is audio: an idle page draws almost nothing
    // and would promote every machine within three seconds.
    const drawn = params !== null && drawsAtWeight(params.weights.particles);
    if (particles.tune(visuals.frameMs(), tick.step, playing, drawn, reduced)) {
      // The cloud is a different size now; what a frame cost a moment ago is
      // not what it costs from here.
      visuals.requestFrameTiming(PROBE_WINDOW_SEC);
    }

    // And the same question about the frame itself. The cloud is asked first
    // because it is the cheaper thing to give up: half a million points is a
    // layer the mood may not even want, where the pixel ratio is every pass in
    // the chain at once.
    const cap = stepDpr(dpr, { dt: tick.step, frameMs: visuals.frameMs(), playing });
    if (visuals.setPixelRatioCap(cap)) visuals.requestFrameTiming(PROBE_WINDOW_SEC);

    params = direct(director, mood, fast, tick.step, params, reduced, transitions);
    visuals.frame(tick.step, params, fast, tick.time);
  }

  /**
   * Where the card is, in the shader's own coordinates.
   *
   * Measured on a resize rather than every frame: `getBoundingClientRect`
   * allocates a `DOMRect` and forces layout, and the card does not move except
   * when the page does. The canvas's own client size is the cheap proxy for
   * "the page has moved" — it is the same box the `ResizeObserver` inside the
   * renderer watches, and reading it costs nothing.
   */
  function updateAnnulus(): void {
    const w = o.canvas.clientWidth || window.innerWidth;
    const h = o.canvas.clientHeight || window.innerHeight;
    if (w === annulusW && h === annulusH) return;
    annulusW = w;
    annulusH = h;
    const el = o.card?.() ?? null;
    smoke.setAnnulus(annulusFor(el === null ? null : el.getBoundingClientRect(), w, h));
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
    // A transient on every other beat. The smoke reads it as a rising edge, so
    // reporting it for the whole first tenth of the beat still seeds one burst.
    const beat = Math.floor(beats);
    const intoBeat = beats - beat;
    fast.onset = beat % IDLE_ONSET_EVERY === 0 && intoBeat < 0.1 ? IDLE_ONSET : 0;
    fast.impact = 0;
    fast.build = 0;
    // A page that has heard nothing has no beat and no rhythm, and says so:
    // the 60 BPM clock above is a fiction for the lobes and the filaments, not
    // evidence of a metre. With both at zero the rotation is `SPIN_DRIFT` —
    // one turn in twenty-six minutes, which is the difference between a still
    // picture and a living one and is not a picture that is spinning.
    fast.beatConf = 0;
    fast.regular = 0;
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
      document.removeEventListener('visibilitychange', onVisibility);
      visuals.dispose();
    },
    mood: () => mood,
    moodSource: () => moodSrc,
    particleTier: () => particles.tierName(),
    // The smoothed reading the governor is deciding on, not the raw one: the
    // HUD is there to explain the decision, and a number that jumps 8 ms
    // between two frames explains nothing.
    frameMs: () => (dpr.seeded ? dpr.frameMs : Number.NaN),
    pixelRatio: () => visuals.pixelRatio(),
  };
}

/** 1 at the instant of a downbeat, decaying with τ = 0.3 s. */
function pulseAt(since: number): number {
  if (!Number.isFinite(since) || since < 0) return 0;
  return Math.exp(-since / DOWNBEAT_TAU);
}


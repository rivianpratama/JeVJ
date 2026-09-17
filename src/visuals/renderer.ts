/**
 * The WebGL end: one renderer, one composer, a list of scenes.
 *
 * Everything above this file is numbers; everything below it is a GPU. It owns
 * the three decisions that are about the machine rather than about the music:
 *
 *  - the device pixel ratio is capped at 1.5, because the ink is a per-pixel
 *    feedback loop and a Retina display would quadruple its cost for a texture
 *    nobody can resolve anyway;
 *  - the scenes render at half that again, which is where the frame budget
 *    actually goes and where it is least visible — the ink has no edges to
 *    soften, and the bloom and grain that follow run at full resolution;
 *  - resizes come from a `ResizeObserver` on the canvas, not from a window
 *    event, so a change in the page layout is caught as well as a change in
 *    the window.
 *
 * It does not own a clock. `frame()` is called with `dt` and `time` from
 * whoever is driving, which in this app is the audio clock.
 */

import * as THREE from 'three';
import { Composer } from './post/Composer';
import type { Scene } from './scenes/Scene';
import type { FastFrame, RenderParams } from './director';

/** Above this the ink costs four times as much for nothing anyone can see. */
const MAX_PIXEL_RATIO = 1.5;
/** Scenes render at this fraction of the drawing buffer. */
const SCENE_SCALE = 0.5;
/** The longest step the simulation will take; a backgrounded tab returns huge dt. */
const MAX_DT = 0.1;
/**
 * How often the *fallback* probe drains, when it is running at all — every two
 * seconds, and only inside a measurement window. See `Visuals.frameMs`.
 */
const SYNC_EVERY = 120;
/** How long a measurement window stays open after something changes. */
export const PROBE_WINDOW_SEC = 5;

/** The slot order the Composer mixes in; matches `RenderParams.weights`. */
const SLOTS: (keyof RenderParams['weights'])[] = ['ink', 'particles', 'strands', 'relief', 'breath'];

/**
 * Below this weight a layer is not worth a draw call.
 *
 * At 0.01 a scene contributes at most one part in a hundred of the frame's
 * light, which after tone mapping is under a single code value — and it costs a
 * full-resolution pass and, for the particles, a quarter of a million points.
 * The slot is simply left empty; the blend pass already binds a 1×1 black
 * texture at weight 0 for the layers that do not exist yet, so nothing else has
 * to know.
 */
export const MIN_DRAW_WEIGHT = 0.01;

/** Whether a layer at this weight earns its draw this frame. */
export function drawsAtWeight(weight: number): boolean {
  return Number.isFinite(weight) && weight >= MIN_DRAW_WEIGHT;
}

export interface Visuals {
  frame(dt: number, p: RenderParams, fast: FastFrame, time: number): void;
  resize(): void;
  addScene(s: Scene): void;
  /**
   * What a frame costs on the GPU, in milliseconds, or `NaN` before anything
   * has been measured.
   *
   * Timing `frame()` with `performance.now()` alone does not measure this:
   * WebGL calls queue and return, so the whole chain "costs" about 2 ms of
   * submission while the GPU is doing five times that. A tier decision taken on
   * that number would promote every machine ever built.
   *
   * Where `EXT_disjoint_timer_query_webgl2` exists — every Chrome this app has
   * been run on — the frame is wrapped in a `TIME_ELAPSED_EXT` query and the
   * result is collected on a *later* frame, when the driver says it is ready.
   * Nothing blocks, one query is in flight at a time, and a result the driver
   * flags as disjoint (a clock change, a context switch mid-frame) is thrown
   * away rather than believed.
   *
   * Without the extension there is only one honest option left, and it is
   * expensive: drain the pipe, start the clock, draw, drain again. Draining
   * only at the end would charge one frame for every frame queued behind it —
   * 250 ms, measured, with thirty frames in flight. That probe runs once every
   * two seconds and only while a decision is actually live, so a settled page
   * never pays for it at all.
   */
  frameMs(): number;
  /**
   * Open a measurement window for `seconds`: something changed and the frame
   * cost is worth knowing again. Only the fallback probe consults it — a timer
   * query is free enough to leave running.
   */
  requestFrameTiming(seconds: number): void;
  /** The device pixel ratio actually in use, after the cap. */
  pixelRatio(): number;
  dispose(): void;
}

export function createVisuals(canvas: HTMLCanvasElement): Visuals {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = true;

  let width = Math.max(1, canvas.clientWidth || window.innerWidth);
  let height = Math.max(1, canvas.clientHeight || window.innerHeight);
  let pixelRatio = renderer.getPixelRatio();
  renderer.setSize(width, height, false);

  const composer = new Composer(renderer, width, height);
  const scenes: Scene[] = [];

  // Reused every frame: the slot arrays are filled in place so the render loop
  // allocates nothing at all.
  const textures: (THREE.Texture | null)[] = [null, null, null, null, null];
  const weights: number[] = [0, 0, 0, 0, 0];

  /**
   * The last GPU frame cost. Read by the particle tier, nothing else. `NaN`
   * until something has actually been measured — there is no sensible number
   * to stand in, and a zero would read as an infinitely fast machine.
   */
  let lastFrameMs = Number.NaN;
  let sinceSync = 0;
  /** Seconds of fallback probing left; see `requestFrameTiming`. */
  let probeWindow = 0;
  /** The one pixel the fallback probe reads back. Allocated once. */
  const syncPixel = new Uint8Array(4);
  /** A 1×1 target of our own, so the probe never touches the presented frame. */
  let probeTarget: THREE.WebGLRenderTarget | null = null;

  // three has been WebGL2-only since r163, so the union the types still carry
  // is not a case that can occur; the query calls below are all core WebGL2.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  /**
   * The GPU's own stopwatch, where the driver exposes one. `TIME_ELAPSED_EXT`
   * and `GPU_DISJOINT_EXT` come from the extension object; everything else
   * about queries is core WebGL2.
   */
  const timer =
    typeof gl.createQuery === 'function'
      ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
          TIME_ELAPSED_EXT: number;
          GPU_DISJOINT_EXT: number;
        } | null)
      : null;
  /** The one query in flight, if any. */
  let pending: WebGLQuery | null = null;

  console.info(
    timer !== null
      ? 'JeVJ: GPU frame timing via EXT_disjoint_timer_query_webgl2'
      : 'JeVJ: GPU frame timing via periodic readback (no timer query extension)',
  );

  const sceneSize = (): [number, number] => {
    const pr = renderer.getPixelRatio();
    return [
      Math.max(2, Math.floor(width * pr * SCENE_SCALE)),
      Math.max(2, Math.floor(height * pr * SCENE_SCALE)),
    ];
  };

  /**
   * The CSS size is not the whole of it: dragging the window onto a display
   * with a different device pixel ratio changes how many real pixels the same
   * layout needs, and the `ResizeObserver` fires for that too. Comparing only
   * the CSS size would leave every buffer in the chain at the old resolution.
   */
  function resize(): void {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    if (w === width && h === height && dpr === pixelRatio) return;
    // Every buffer in the chain is about to change size; what a frame cost at
    // the old one is not what it will cost at the new one.
    probeWindow = Math.max(probeWindow, PROBE_WINDOW_SEC);
    width = w;
    height = h;
    pixelRatio = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    const [sw, sh] = sceneSize();
    for (const s of scenes) s.resize(sw, sh);
  }

  /**
   * Wait for the GPU to catch up, by asking it for something it must finish.
   *
   * The read comes off a 1×1 target of our own rather than the presented
   * backbuffer: reading the frame the compositor is about to show drags the
   * compositor into the stall as well.
   */
  function drain(): void {
    if (probeTarget === null) {
      probeTarget = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: false,
        stencilBuffer: false,
      });
      // Give three a reason to allocate it before anything reads it back.
      renderer.setRenderTarget(probeTarget);
      renderer.clear();
      renderer.setRenderTarget(null);
    }
    renderer.readRenderTargetPixels(probeTarget, 0, 0, 1, 1, syncPixel);
  }

  /** Collect a finished timer query. Never blocks: it asks, it does not wait. */
  function collectTimer(): void {
    if (timer === null || pending === null) return;
    // A disjoint means the GPU's clock was interrupted during *some* query, so
    // whatever is in flight is not a measurement of anything.
    if (gl.getParameter(timer.GPU_DISJOINT_EXT) === true) {
      gl.deleteQuery(pending);
      pending = null;
      return;
    }
    if (gl.getQueryParameter(pending, gl.QUERY_RESULT_AVAILABLE) !== true) return;
    lastFrameMs = (gl.getQueryParameter(pending, gl.QUERY_RESULT) as number) / 1e6;
    gl.deleteQuery(pending);
    pending = null;
  }

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);

  return {
    addScene(s: Scene): void {
      const [sw, sh] = sceneSize();
      s.init(renderer, sw, sh);
      scenes.push(s);
    },

    frame(dt: number, p: RenderParams, fast: FastFrame, time: number): void {
      const step = Math.max(0, Math.min(MAX_DT, dt));
      probeWindow = Math.max(0, probeWindow - step);

      // Whatever the last query measured, if the driver has it ready by now.
      collectTimer();

      let query: WebGLQuery | null = null;
      if (timer !== null && pending === null) {
        query = gl.createQuery();
        if (query !== null) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      }

      // The fallback: drain, time, drain. Only without the extension, only
      // inside a window, and only every other second even then.
      sinceSync++;
      const drained = timer === null && probeWindow > 0 && sinceSync >= SYNC_EVERY;
      if (drained) {
        sinceSync = 0;
        drain();
      }
      const startedAt = drained ? performance.now() : 0;

      for (let i = 0; i < SLOTS.length; i++) {
        textures[i] = null;
        weights[i] = 0;
      }
      for (const s of scenes) {
        const slot = SLOTS.indexOf(s.name);
        if (slot < 0) continue;
        const weight = p.weights[s.name];
        // `update` runs whatever the weight: a scene that carries simulation
        // state — the ink's feedback, the particles' cloud — has to keep
        // stepping while it is out of the mix, or it fades back in holding
        // whatever it was doing seconds ago.
        s.update(step, p, fast, time);
        if (!drawsAtWeight(weight)) continue;
        textures[slot] = s.render(renderer);
        weights[slot] = weight;
      }

      composer.render(textures, weights, p, fast, time);

      if (query !== null && timer !== null) {
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        pending = query;
      }
      if (drained) {
        drain();
        lastFrameMs = performance.now() - startedAt;
      }
    },

    frameMs: () => lastFrameMs,

    requestFrameTiming(seconds: number): void {
      probeWindow = Math.max(probeWindow, Math.max(0, seconds));
    },

    pixelRatio: () => pixelRatio,

    resize,

    dispose(): void {
      observer.disconnect();
      if (pending !== null) gl.deleteQuery(pending);
      pending = null;
      probeTarget?.dispose();
      probeTarget = null;
      for (const s of scenes) s.dispose();
      scenes.length = 0;
      composer.dispose();
      renderer.dispose();
    },
  };
}

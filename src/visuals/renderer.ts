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

/** The slot order the Composer mixes in; matches `RenderParams.weights`. */
const SLOTS: (keyof RenderParams['weights'])[] = ['ink', 'particles', 'strands', 'relief', 'breath'];

export interface Visuals {
  frame(dt: number, p: RenderParams, fast: FastFrame, time: number): void;
  resize(): void;
  addScene(s: Scene): void;
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
    width = w;
    height = h;
    pixelRatio = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    const [sw, sh] = sceneSize();
    for (const s of scenes) s.resize(sw, sh);
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

      for (let i = 0; i < SLOTS.length; i++) {
        textures[i] = null;
        weights[i] = 0;
      }
      for (const s of scenes) {
        const slot = SLOTS.indexOf(s.name);
        if (slot < 0) continue;
        const weight = p.weights[s.name];
        s.update(step, p, fast, time);
        textures[slot] = s.render(renderer);
        weights[slot] = weight;
      }

      composer.render(textures, weights, p, fast, time);
    },

    resize,

    dispose(): void {
      observer.disconnect();
      for (const s of scenes) s.dispose();
      scenes.length = 0;
      composer.dispose();
      renderer.dispose();
    },
  };
}

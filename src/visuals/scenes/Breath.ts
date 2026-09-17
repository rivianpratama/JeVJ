/**
 * The voice layer: a fullscreen shader that has one job and one prohibition.
 *
 * The job is to be something to look at while a person talks — a glow with a
 * six-second breath in it and a band of soft ridges that swells when the voice
 * does. The prohibition is that it must never flash, and that is not a matter
 * of taste: a podcast runs for an hour, it is watched in the dark, and an
 * envelope follower on speech produces a strobe.
 *
 * So none of the audio reaches the shader raw. `uRms` is lagged 0.15 s and only
 * ever *shapes* — it sets the band's height and a little of the glow's width.
 * `uLevel`, the one number that scales the whole output, is rate-limited to
 * 0.08 of full scale per frame, so the widest swing the scene can make takes
 * about thirteen frames. Both live in `breathLevel.ts`, which is pure and
 * tested; this class is the wiring.
 *
 * The palette arrives through `desaturate(palette, 0.2)`, so the scene is near
 * monochrome by construction — the lightness ramp the mood chose, with its hue
 * taken almost all the way out — rather than by the shader deciding to ignore
 * colour.
 */

import * as THREE from 'three';
import { FULLSCREEN_VERT, withCommon } from '../shaders/glsl';
import breathFrag from '../shaders/breath.frag.glsl?raw';
import { levelFor, slewLevel, smoothRms } from '../breathLevel';
import { desaturate } from '../palette';
import type { Scene } from './Scene';
import type { FastFrame, RenderParams } from '../director';

/** How much of the palette's chroma survives. */
export const BREATH_CHROMA = 0.2;
/** The scene's own film grain, per the brief. */
const GRAIN = 0.05;

export class Breath implements Scene {
  readonly name = 'breath' as const;

  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad = new THREE.PlaneGeometry(2, 2);
  private readonly scene = new THREE.Scene();
  private readonly material: THREE.ShaderMaterial;

  private target: THREE.WebGLRenderTarget | null = null;
  private width = 1;
  private height = 1;

  /** The lagged loudness, and the rate-limited brightness. */
  private rms = 0;
  private level = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(breathFrag),
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uLevel: { value: 0 },
        uRms: { value: 0 },
        uAspect: { value: 1 },
        uBg: { value: new THREE.Vector3() },
        uStops: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()) },
        uGrain: { value: GRAIN },
      },
    });
    this.scene.add(new THREE.Mesh(this.quad, this.material));
  }

  init(_r: THREE.WebGLRenderer, w: number, h: number): void {
    this.allocate(w, h);
  }

  resize(w: number, h: number): void {
    this.allocate(w, h);
  }

  /** The brightness the scene is actually drawing at. Read by the tests. */
  currentLevel(): number {
    return this.level;
  }

  update(dt: number, p: RenderParams, fast: FastFrame, time: number): void {
    this.rms = smoothRms(this.rms, fast.rms, dt);
    // Rate-limited per *frame*, not per second: what must not flash is the
    // sequence of frames the eye sees, and a long frame does not earn a bigger
    // jump — it is the frame most likely to be followed by a short one.
    this.level = slewLevel(this.level, levelFor(this.rms));

    const u = this.material.uniforms;
    u['uTime']!.value = time;
    u['uRms']!.value = this.rms;
    u['uLevel']!.value = this.level;

    const grey = desaturate(p.palette, BREATH_CHROMA);
    const stops = u['uStops']!.value as THREE.Vector3[];
    for (let s = 0; s < stops.length; s++) {
      const rgb = grey.stops[s] ?? grey.stops[grey.stops.length - 1]!;
      stops[s]!.set(rgb[0], rgb[1], rgb[2]);
    }
    (u['uBg']!.value as THREE.Vector3).set(grey.bg[0], grey.bg[1], grey.bg[2]);
  }

  render(r: THREE.WebGLRenderer): THREE.Texture {
    const target = this.target;
    if (!target) throw new Error('Breath: render before init');

    const autoClear = r.autoClear;
    r.setRenderTarget(target);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.autoClear = autoClear;
    r.setRenderTarget(null);
    return target.texture;
  }

  dispose(): void {
    this.quad.dispose();
    this.material.dispose();
    this.target?.dispose();
    this.target = null;
  }

  private allocate(w: number, h: number): void {
    const width = Math.max(2, Math.floor(w));
    const height = Math.max(2, Math.floor(h));
    this.material.uniforms['uAspect']!.value = width / height;
    if (this.target && width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;

    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }
}

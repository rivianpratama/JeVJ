/**
 * The post chain, built once and driven by uniforms.
 *
 * Scene textures → blend → mirror → chroma → bloom → grain/vignette → output.
 * Nothing in here is ever rebuilt: every frame sets numbers on materials that
 * were compiled at startup, because a shader recompile mid-track is a dropped
 * frame the eye reads as a stutter, and because the director's whole design —
 * slewed scalars, `folds = 0` meaning off — assumes the passes are always
 * there and merely quiet.
 *
 * The buffers are half-float. The ink is a feedback loop whose output is
 * bloomed and then filmic-tone-mapped, and an 8-bit intermediate would band
 * visibly in the long fades — which is most of what the picture is.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BlendPass } from './BlendPass';
import { ChromaPass } from './ChromaPass';
import { GrainVignettePass } from './GrainVignettePass';
import { MirrorPass } from './MirrorPass';
import type { FastFrame, RenderParams } from '../director';

/** Fixed by the brief; only strength and threshold are steered. */
const BLOOM_RADIUS = 0.6;

export class Composer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly blend = new BlendPass();
  private readonly mirror = new MirrorPass();
  private readonly chroma = new ChromaPass();
  private readonly bloom: UnrealBloomPass;
  private readonly grain = new GrainVignettePass();
  private readonly target: THREE.WebGLRenderTarget;
  private aspect = 1;

  constructor(renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.renderer = renderer;
    const halfFloat =
      renderer.extensions.has('EXT_color_buffer_half_float') ||
      renderer.extensions.has('EXT_color_buffer_float');

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.composer = new EffectComposer(renderer, this.target);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, BLOOM_RADIUS, 0.8);

    this.composer.addPass(this.blend);
    this.composer.addPass(this.mirror);
    this.composer.addPass(this.chroma);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grain);
    // Tone mapping and sRGB encoding, once, at the very end.
    this.composer.addPass(new OutputPass());

    this.setSize(width, height);
  }

  /**
   * `width` and `height` are CSS pixels; the pixel ratio is read back off the
   * renderer, which may have changed it — a window dragged onto a second
   * display changes the device pixel ratio without changing the layout.
   *
   * The composer scales every pass it owns, the bloom included, so sizing the
   * bloom again here would set it to the CSS size and undo that.
   */
  setSize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  /**
   * One frame. `textures` is in the same slot order as `RenderParams.weights`.
   */
  render(
    textures: readonly (THREE.Texture | null)[],
    weights: readonly number[],
    p: RenderParams,
    fast: FastFrame,
    time: number,
  ): void {
    this.blend.setLayers(textures, weights);
    this.mirror.set(p.mirrorFolds, p.mirrorMix, this.aspect, time);
    this.chroma.set(p.chroma, p.posterize, fast.beatPhase);
    this.bloom.strength = p.bloomStrength;
    this.bloom.threshold = p.bloomThreshold;
    this.bloom.radius = BLOOM_RADIUS;
    this.grain.set(p.grain, p.vignette, time, this.aspect);
    this.composer.render();
  }

  dispose(): void {
    this.blend.dispose();
    this.mirror.dispose();
    this.chroma.dispose();
    this.bloom.dispose();
    this.grain.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}

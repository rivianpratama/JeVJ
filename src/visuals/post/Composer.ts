/**
 * The post chain, built once and driven by uniforms.
 *
 * Scene textures → blend → mirror → chroma → afterimage → bloom → grain/vignette
 * → output.
 * Nothing in here is ever rebuilt: every frame sets numbers on materials that
 * were compiled at startup, because a shader recompile mid-track is a dropped
 * frame the eye reads as a stutter, and because the director's whole design —
 * slewed scalars, `folds = 0` meaning off — assumes the passes are always
 * there and merely quiet.
 *
 * The buffers are half-float. The smoke is a feedback loop whose output is
 * bloomed and then filmic-tone-mapped, and an 8-bit intermediate would band
 * visibly in the long fades — which is most of what the picture is.
 *
 * The afterimage sits *before* the bloom, and that ordering is the whole point
 * of it: smearing the frame and then blooming the smear gives a soft comet
 * behind every bright thing, where blooming first and smearing after would
 * leave a trail of already-bloomed haloes, which reads as a dirty lens rather
 * than as motion. It is also the one pass in the chain that holds state of its
 * own — two feedback targets, ping-ponged — so it is the one pass that has to
 * be told about a resize separately from the composer.
 */

import * as THREE from 'three';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
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
/**
 * The bloom's own working resolution, as a fraction of the frame.
 *
 * `UnrealBloomPass` is five downsamples, five gaussian blurs and five upsamples
 * on top of a bright pass, and every one of them is a full-screen draw: it was
 * the single most expensive thing in the chain, measured. Halving its base
 * resolution quarters all of that, and the result is a *blur* — the one pass in
 * the app whose output has no detail in it to lose. What the eye sees is a
 * slightly wider, slightly softer glow, which is what a bloom is for.
 */
const BLOOM_SCALE = 0.5;

export class Composer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly blend = new BlendPass();
  private readonly mirror = new MirrorPass();
  private readonly chroma = new ChromaPass();
  /**
   * The motion smear. Constructed at the damp the director hands out at idle;
   * it is driven per frame from `RenderParams.afterimage`, and 0 is off.
   */
  private readonly afterimage = new AfterimagePass(0.85);
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
    this.composer.addPass(this.afterimage);
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
   * bloom again here would set it to the CSS size and undo that — which is
   * exactly why the bloom is re-sized *after* it, in device pixels, to half the
   * frame it was just handed.
   */
  setSize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
    const ratio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.bloom.setSize(
      Math.max(2, Math.floor(width * ratio * BLOOM_SCALE)),
      Math.max(2, Math.floor(height * ratio * BLOOM_SCALE)),
    );
    // The composer sizes the passes it owns, but the afterimage's two feedback
    // targets are sized in *device* pixels and it is constructed at
    // `window.innerWidth` — so on any page whose canvas is not the whole window,
    // or any display with a pixel ratio, they start at the wrong size and the
    // smear is resampled off a mismatched buffer. Told explicitly, in the same
    // units the drawing buffer is in.
    this.afterimage.setSize(
      Math.max(2, Math.floor(width * ratio)),
      Math.max(2, Math.floor(height * ratio)),
    );
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
    // 0 is off, and off has to mean it: `damp` is the weight on the *old*
    // frame, so a residual 0.01 would still leave a one-frame ghost forever.
    this.afterimage.enabled = p.afterimage > 0;
    this.afterimage.damp = p.afterimage;
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
    this.afterimage.dispose();
    this.bloom.dispose();
    this.grain.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}

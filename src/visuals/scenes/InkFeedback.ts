/**
 * The ink: a two-target feedback loop that behaves like paint under glass.
 *
 * The state of this scene is two half-resolution RGBA16F targets holding three
 * ink densities in R, G and B. A frame is three draws:
 *
 *   1. advect and fade — read `prev`, write `next` (`ink_feedback.frag`);
 *   2. inject — add this frame's beat lobes, downbeat ring and impact splash
 *      on top of `next`, additively (`ink_inject.frag`);
 *   3. color — sample the densities through the mood's palette into a separate
 *      color target, which is what the Composer mixes (`ink_color.frag`).
 *
 * Then the two density targets swap. Nothing is ever cleared: the picture at
 * any instant is every injection of the last few seconds, folded into itself
 * by the flow. That is why it never reads as shapes — a lobe is recognisable
 * for about a frame, and marbling for a minute. A resize is not a clear
 * either: the field is resampled into the new buffers, because a loop with no
 * source but itself comes back from black over seconds — and over tens of
 * seconds on a page the browser has throttled.
 *
 * Half-float matters here more than anywhere else in the app. The densities
 * are multiplied by ~0.96 sixty times a second; in 8 bits the tail of every
 * stroke would quantise into visible steps within half a second.
 */

import * as THREE from 'three';
import { FULLSCREEN_VERT, withCommon } from '../shaders/glsl';
import inkCarryFrag from '../shaders/ink_carry.frag.glsl?raw';
import inkColorFrag from '../shaders/ink_color.frag.glsl?raw';
import inkFeedbackFrag from '../shaders/ink_feedback.frag.glsl?raw';
import inkInjectFrag from '../shaders/ink_inject.frag.glsl?raw';
import { AMBIENT_LEVEL, DRIFT_DECAY, ambientInjectPerFrame } from '../inkMath';
import { MOTIONS } from '../../shared/types';
import type { Scene } from './Scene';
import type { FastFrame, RenderParams } from '../director';

/** `uFlowStyle` is the index of the motion label in `MOTIONS`. */
export const FLOW_STYLE: Record<string, number> = Object.fromEntries(MOTIONS.map((m, i) => [m, i]));

function densityTarget(w: number, h: number, type: THREE.TextureDataType): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // Clamp, so ink pushed off the edge smears along it rather than wrapping
    // around and reappearing on the other side.
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export class InkFeedback implements Scene {
  readonly name = 'ink' as const;

  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad = new THREE.PlaneGeometry(2, 2);

  private readonly feedbackScene = new THREE.Scene();
  private readonly injectScene = new THREE.Scene();
  private readonly colorScene = new THREE.Scene();
  private readonly carryScene = new THREE.Scene();

  private readonly feedbackMat: THREE.ShaderMaterial;
  private readonly injectMat: THREE.ShaderMaterial;
  private readonly colorMat: THREE.ShaderMaterial;
  private readonly carryMat: THREE.ShaderMaterial;

  /**
   * The renderer, kept from `init`, because a resize has to *draw*: the field
   * is carried into the new buffers rather than thrown away, and only the
   * renderer can move it.
   */
  private renderer: THREE.WebGLRenderer | null = null;

  private ping: THREE.WebGLRenderTarget | null = null;
  private pong: THREE.WebGLRenderTarget | null = null;
  private color: THREE.WebGLRenderTarget | null = null;

  private width = 1;
  private height = 1;
  private type: THREE.TextureDataType = THREE.HalfFloatType;
  /** Set from the beat grid: 3 for a triple meter, 4 for a duple one. */
  private lobes = 3;

  constructor() {
    this.feedbackMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(inkFeedbackFrag),
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrev: { value: null },
        uFlowAmt: { value: 0.35 },
        uDecay: { value: 0.955 },
        uTurbulence: { value: 0.4 },
        uPushKick: { value: 0 },
        uTime: { value: 0 },
        uDt: { value: 1 / 60 },
        uBeatPhase: { value: 0 },
        uFlowStyle: { value: 0 },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
    });

    this.injectMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(inkInjectFrag),
      depthTest: false,
      depthWrite: false,
      // The one place new ink enters: added on top of what the feedback pass
      // just wrote, never replacing it.
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uBeatPhase: { value: 0 },
        uSub: { value: 0 },
        uBands: { value: new Float32Array(8) },
        uInjectGain: { value: 1 },
        uDownbeatPulse: { value: 0 },
        uImpact: { value: 0 },
        uLobes: { value: 3 },
        uAspect: { value: 1 },
        uDt: { value: 1 / 60 },
        uAmbientAdd: { value: 0 },
      },
    });

    this.colorMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(inkColorFrag),
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uInk: { value: null },
        uStops: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()) },
        uBg: { value: new THREE.Vector3() },
        uAccent: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
      },
    });

    this.carryMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: inkCarryFrag,
      depthTest: false,
      depthWrite: false,
      uniforms: { uPrev: { value: null } },
    });

    this.feedbackScene.add(new THREE.Mesh(this.quad, this.feedbackMat));
    this.injectScene.add(new THREE.Mesh(this.quad, this.injectMat));
    this.colorScene.add(new THREE.Mesh(this.quad, this.colorMat));
    this.carryScene.add(new THREE.Mesh(this.quad, this.carryMat));
  }

  init(r: THREE.WebGLRenderer, w: number, h: number): void {
    this.renderer = r;
    // Rendering *to* a half-float target is an extension even on WebGL2; on a
    // machine without it the ink still runs, it just bands in the tails.
    const halfFloat =
      r.extensions.has('EXT_color_buffer_half_float') || r.extensions.has('EXT_color_buffer_float');
    this.type = halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.allocate(w, h);
  }

  resize(w: number, h: number): void {
    this.allocate(w, h);
  }

  /**
   * The texture holding the live density field.
   *
   * Nothing in the app reads it — the Composer is handed the *coloured* texture
   * `render` returns. It is here because the field is the entire state of this
   * scene and the only thing a resize can destroy, so a test has to be able to
   * watch it across one.
   */
  densityTexture(): THREE.Texture | null {
    return this.ping?.texture ?? null;
  }

  /** Lobe count from the meter: 3 beats to the bar gives 3, anything else 4. */
  setMeter(beatsPerBar: number): void {
    this.lobes = beatsPerBar === 3 ? 3 : 4;
  }

  update(dt: number, p: RenderParams, fast: FastFrame, time: number): void {
    const f = this.feedbackMat.uniforms;
    f['uFlowAmt']!.value = p.flowAmt;
    f['uDecay']!.value = p.decay;
    f['uTurbulence']!.value = p.turbulence;
    f['uPushKick']!.value = p.pushKick;
    f['uTime']!.value = time;
    f['uDt']!.value = dt;
    f['uBeatPhase']!.value = fast.beatPhase;
    f['uFlowStyle']!.value = FLOW_STYLE[p.flowStyle] ?? 0;

    const i = this.injectMat.uniforms;
    i['uTime']!.value = time;
    i['uBeatPhase']!.value = fast.beatPhase;
    i['uSub']!.value = fast.sub;
    (i['uBands']!.value as Float32Array).set(fast.bands);
    i['uInjectGain']!.value = p.injectGain;
    i['uDownbeatPulse']!.value = fast.downbeatPulse;
    i['uImpact']!.value = fast.impact;
    i['uLobes']!.value = this.lobes;
    i['uDt']!.value = dt;
    // The ambient wash is a standing level, not a rate: hand the shader exactly
    // what this frame lost, so the field settles in the same place whatever the
    // decay and however long the frame took. `drift` is the one motion whose
    // flow style overrides the decay inside the shader, so the compensation has
    // to be worked out against the decay the loop will actually run at.
    const decay = p.flowStyle === 'drift' ? DRIFT_DECAY : p.decay;
    i['uAmbientAdd']!.value = ambientInjectPerFrame(AMBIENT_LEVEL, decay, dt);

    const c = this.colorMat.uniforms;
    const stops = c['uStops']!.value as THREE.Vector3[];
    for (let s = 0; s < stops.length; s++) {
      const rgb = p.palette.stops[s] ?? p.palette.stops[p.palette.stops.length - 1]!;
      stops[s]!.set(rgb[0], rgb[1], rgb[2]);
    }
    (c['uBg']!.value as THREE.Vector3).set(p.palette.bg[0], p.palette.bg[1], p.palette.bg[2]);
    (c['uAccent']!.value as THREE.Vector3).set(
      p.palette.accent[0],
      p.palette.accent[1],
      p.palette.accent[2],
    );
    c['uExposure']!.value = p.exposure;
  }

  render(r: THREE.WebGLRenderer): THREE.Texture {
    const prev = this.ping;
    const next = this.pong;
    const color = this.color;
    if (!prev || !next || !color) throw new Error('InkFeedback: render before init');

    const autoClear = r.autoClear;

    // 1. advect and fade: prev → next.
    this.feedbackMat.uniforms['uPrev']!.value = prev.texture;
    r.setRenderTarget(next);
    r.autoClear = true;
    r.render(this.feedbackScene, this.camera);

    // 2. inject: additive, on top of what was just written.
    r.autoClear = false;
    r.render(this.injectScene, this.camera);
    r.autoClear = autoClear;

    // 3. color: densities → palette, into the texture the Composer mixes.
    this.colorMat.uniforms['uInk']!.value = next.texture;
    r.setRenderTarget(color);
    r.render(this.colorScene, this.camera);
    r.setRenderTarget(null);

    this.ping = next;
    this.pong = prev;
    return color.texture;
  }

  dispose(): void {
    this.ping?.dispose();
    this.pong?.dispose();
    this.color?.dispose();
    this.ping = this.pong = this.color = null;
    this.feedbackMat.dispose();
    this.injectMat.dispose();
    this.colorMat.dispose();
    this.carryMat.dispose();
    this.quad.dispose();
  }

  private allocate(w: number, h: number): void {
    const width = Math.max(2, Math.floor(w));
    const height = Math.max(2, Math.floor(h));
    if (this.ping && width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;

    const previous = this.ping;
    const ping = densityTarget(width, height, this.type);
    const pong = densityTarget(width, height, this.type);
    const color = densityTarget(width, height, this.type);

    // The field is carried across rather than thrown away. It used to be
    // thrown away on the grounds that the densities are in uv space and nothing
    // sensible survives a change of aspect — but the commonest resize by far is
    // not a change of aspect at all, it is the pixel-ratio governor stepping
    // down mid-track, and a feedback loop with no source but itself comes back
    // from black over seconds. On a page the browser has throttled to a frame
    // or two a second that is tens of seconds of an almost-black picture. A
    // resample is exact for a pixel-ratio step and merely stretched for a
    // genuine reshape, which is in every case better than nothing.
    if (previous !== null && this.renderer !== null) {
      const r = this.renderer;
      this.carryMat.uniforms['uPrev']!.value = previous.texture;
      const autoClear = r.autoClear;
      r.autoClear = true;
      r.setRenderTarget(ping);
      r.render(this.carryScene, this.camera);
      r.setRenderTarget(null);
      r.autoClear = autoClear;
    }

    // Only once the old field has been read out of them.
    previous?.dispose();
    this.pong?.dispose();
    this.color?.dispose();
    this.ping = ping;
    this.pong = pong;
    this.color = color;

    (this.feedbackMat.uniforms['uTexel']!.value as THREE.Vector2).set(1 / width, 1 / height);
    this.injectMat.uniforms['uAspect']!.value = width / height;
  }
}

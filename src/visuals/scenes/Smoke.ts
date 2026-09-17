/**
 * The smoke: a two-target feedback loop that behaves like long-exposure vapour.
 *
 * The state of this scene is two half-resolution RGBA16F targets holding three
 * smoke densities in R, G and B — and, since v2, the local flow angle in A. A
 * frame is three draws:
 *
 *   1. advect, fade and smear — read `prev`, write `next`
 *      (`smoke_feedback.frag`);
 *   2. inject — add this frame's lobes, filaments, downbeat ring and impact
 *      shell on top of `next`, additively (`smoke_inject.frag`);
 *   3. color — sample the densities through the mood's palette into a separate
 *      color target, which is what the Composer mixes (`smoke_color.frag`).
 *
 * Then the two density targets swap. Nothing is ever cleared: the picture at
 * any instant is every injection of the last few seconds, folded into itself
 * by the flow. That is why it never reads as shapes — a lobe is recognisable
 * for about a frame, and marbling for a minute. A resize is not a clear
 * either: the field is resampled into the new buffers, because a loop with no
 * source but itself comes back from black over seconds — and over tens of
 * seconds on a page the browser has throttled.
 *
 * **What v2 changed.** The slot name is still `ink` and the ping-pong, the
 * DPR-step resample and the ambient target-density mechanism are untouched.
 * What moved is the *geometry*: smoke is born on an annulus around the card
 * rather than at the middle of the frame, the whole field rotates, it is
 * carried outward, and the blur that softens it is anisotropic — along the
 * flow, so a sheet is combed into parallel striations instead of being washed
 * flat. Onsets seed filaments: two or three thin bright Bézier curves on the
 * annulus, tangent to the rotation, which the anisotropic blur smears into
 * sheets over the following second.
 *
 * Half-float matters here more than anywhere else in the app. The densities
 * are multiplied by ~0.96 sixty times a second; in 8 bits the tail of every
 * stroke would quantise into visible steps within half a second.
 */

import * as THREE from 'three';
import { FULLSCREEN_VERT, withCommon } from '../shaders/glsl';
import smokeCarryFrag from '../shaders/smoke_carry.frag.glsl?raw';
import smokeColorFrag from '../shaders/smoke_color.frag.glsl?raw';
import smokeFeedbackFrag from '../shaders/smoke_feedback.frag.glsl?raw';
import smokeInjectFrag from '../shaders/smoke_inject.frag.glsl?raw';
import { AMBIENT_LEVEL, DRIFT_DECAY, ambientInjectPerFrame } from '../inkMath';
import { MOTIONS } from '../../shared/types';
import type { Annulus } from '../smokeMath';
import type { Scene } from './Scene';
import type { FastFrame, RenderParams } from '../director';

/** `uFlowStyle` is the index of the motion label in `MOTIONS`. */
export const FLOW_STYLE: Record<string, number> = Object.fromEntries(MOTIONS.map((m, i) => [m, i]));

/** How many filaments can be alight at once, and how many an onset seeds. */
export const FILAMENT_SLOTS = 3;
const FILAMENT_MIN = 2;
/** How fast a filament fades out of the injection, in seconds. */
const FILAMENT_TAU = 0.35;
/** Below this a filament is retired: see `stepFilaments`. */
const FILAMENT_OFF = 1e-3;
/** A filament's length in uv, and its width. */
const FILAMENT_LEN_MIN = 0.25;
const FILAMENT_LEN_MAX = 0.5;
const FILAMENT_WIDTH = 0.004;
/** How far a filament bows away from its own tangent, as a fraction of its length. */
const FILAMENT_BOW = 0.35;
/** The onset that seeds filaments, and the shortest gap between two seedings. */
const ONSET_GATE = 0.35;
const FILAMENT_GAP_SEC = 0.12;
/** What the annulus is before anything has measured a card: a centred frame. */
const DEFAULT_ANNULUS: Annulus = { cx: 0.5, cy: 0.5, inner: 0.24, outer: 0.42 };

function densityTarget(w: number, h: number, type: THREE.TextureDataType): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // Clamp, so smoke pushed off the edge smears along it rather than wrapping
    // around and reappearing on the other side.
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

/** One live filament, kept in a fixed-size ring so a frame allocates nothing. */
interface Filament {
  /** Control points of the quadratic Bézier, in the aspect-corrected space. */
  p0: THREE.Vector2;
  p1: THREE.Vector2;
  p2: THREE.Vector2;
  /** Seconds since it was seeded; `Infinity` for an empty slot. */
  age: number;
  peak: number;
}

export class Smoke implements Scene {
  /**
   * Still `ink`. The slot name is the contract with the Composer and the
   * director's weight map, and renaming a mix channel is a rename of every
   * measurement taken through it.
   */
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
  private annulus: Annulus = DEFAULT_ANNULUS;

  private readonly filaments: Filament[] = [];
  /** Whether the onset was already over the gate last frame, so one hit seeds once. */
  private onsetHeld = false;
  private sinceFilament = Number.POSITIVE_INFINITY;
  /** Where the next filament is written; the ring is three deep. */
  private nextSlot = 0;
  /** A counter, not a random: the look has to be the same every run. */
  private seed = 0;

  constructor() {
    for (let i = 0; i < FILAMENT_SLOTS; i++) {
      this.filaments.push({
        p0: new THREE.Vector2(),
        p1: new THREE.Vector2(),
        p2: new THREE.Vector2(),
        age: Number.POSITIVE_INFINITY,
        peak: 0,
      });
    }

    this.feedbackMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(smokeFeedbackFrag),
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrev: { value: null },
        uFlowAmt: { value: 0.35 },
        uDecay: { value: 0.955 },
        uTurbulence: { value: 0.4 },
        uPushKick: { value: 0 },
        uPushOut: { value: 0.012 },
        uSpin: { value: 0 },
        uSpinRate: { value: 0 },
        uTime: { value: 0 },
        uDt: { value: 1 / 60 },
        uBeatPhase: { value: 0 },
        uFlowStyle: { value: 0 },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uCardCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uCardInner: { value: DEFAULT_ANNULUS.inner },
        uCardOuter: { value: DEFAULT_ANNULUS.outer },
        // The annulus radii are in the aspect-corrected space; this pass has
        // to measure its distances in the same one. See the shader.
        uAspect: { value: 1 },
      },
    });

    this.injectMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(smokeInjectFrag),
      depthTest: false,
      depthWrite: false,
      // The one place new smoke enters: added on top of what the feedback pass
      // just wrote, never replacing it.
      //
      // Custom rather than `AdditiveBlending`, for one reason: additive uses
      // SRC_ALPHA as the colour's source factor and writes the source alpha
      // into the target, and the alpha of this target is not padding any more —
      // it is the flow angle the feedback pass wrote for the *inject* pass to
      // comb across. So colour is a plain one-to-one add and alpha is left
      // exactly as the feedback pass left it.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
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
        uStriate: { value: 380 },
        uSpin: { value: 0 },
        uCardCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uCardInner: { value: DEFAULT_ANNULUS.inner },
        uCardOuter: { value: DEFAULT_ANNULUS.outer },
        uPrev: { value: null },
        uFilA: { value: [0, 1, 2].map(() => new THREE.Vector4()) },
        uFilB: { value: [0, 1, 2].map(() => new THREE.Vector4()) },
      },
    });

    this.colorMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(smokeColorFrag),
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSmoke: { value: null },
        uStops: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()) },
        uBg: { value: new THREE.Vector3() },
        uAccent: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
        uSpin: { value: 0 },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
    });

    this.carryMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: smokeCarryFrag,
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
    // machine without it the smoke still runs, it just bands in the tails.
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

  /**
   * Where the card is, as the ring smoke is born on.
   *
   * Handed in rather than measured here: this file has no business reading the
   * DOM, and the annulus has to be the same number the director's own
   * measurements are taken against. See `annulusFor`.
   */
  setAnnulus(a: Annulus): void {
    this.annulus = a;
    const f = this.feedbackMat.uniforms;
    (f['uCardCenter']!.value as THREE.Vector2).set(a.cx, a.cy);
    f['uCardInner']!.value = a.inner;
    f['uCardOuter']!.value = a.outer;
    const i = this.injectMat.uniforms;
    (i['uCardCenter']!.value as THREE.Vector2).set(a.cx, a.cy);
    i['uCardInner']!.value = a.inner;
    i['uCardOuter']!.value = a.outer;
  }

  update(dt: number, p: RenderParams, fast: FastFrame, time: number): void {
    const f = this.feedbackMat.uniforms;
    f['uFlowAmt']!.value = p.flowAmt;
    f['uDecay']!.value = p.decay;
    f['uTurbulence']!.value = p.turbulence;
    f['uPushKick']!.value = p.pushKick;
    f['uPushOut']!.value = p.pushOut;
    f['uSpin']!.value = p.spin;
    f['uSpinRate']!.value = p.spinRate;
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
    i['uStriate']!.value = p.striate;
    i['uSpin']!.value = p.spin;
    // The ambient wash is a standing level, not a rate: hand the shader exactly
    // what this frame lost, so the field settles in the same place whatever the
    // decay and however long the frame took. `drift` is the one motion whose
    // flow style overrides the decay inside the shader, so the compensation has
    // to be worked out against the decay the loop will actually run at.
    const decay = p.flowStyle === 'drift' ? DRIFT_DECAY : p.decay;
    i['uAmbientAdd']!.value = ambientInjectPerFrame(AMBIENT_LEVEL, decay, dt);

    this.stepFilaments(dt, fast, p);

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
    c['uSpin']!.value = p.spin;
  }

  render(r: THREE.WebGLRenderer): THREE.Texture {
    const prev = this.ping;
    const next = this.pong;
    const color = this.color;
    if (!prev || !next || !color) throw new Error('Smoke: render before init');

    const autoClear = r.autoClear;

    // 1. advect, fade and smear: prev → next.
    this.feedbackMat.uniforms['uPrev']!.value = prev.texture;
    r.setRenderTarget(next);
    r.autoClear = true;
    r.render(this.feedbackScene, this.camera);

    // 2. inject: additive, on top of what was just written. It reads `prev`
    // for the flow angle — the target it is drawing into cannot also be a
    // source, and the direction the flow points moves by a fraction of a
    // degree in a frame.
    this.injectMat.uniforms['uPrev']!.value = prev.texture;
    r.autoClear = false;
    r.render(this.injectScene, this.camera);
    r.autoClear = autoClear;

    // 3. color: densities → palette, into the texture the Composer mixes.
    this.colorMat.uniforms['uSmoke']!.value = next.texture;
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

  /**
   * Age the filaments, seed new ones on an onset, and write the three slots
   * into the uniforms.
   *
   * The ring is three deep and the slots are reused in order, so a dense
   * passage overwrites its own oldest filament rather than growing an array —
   * this runs every frame and must not allocate.
   */
  private stepFilaments(dt: number, fast: FastFrame, p: RenderParams): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.sinceFilament += step;
    for (const f of this.filaments) f.age += step;

    const onset = Number.isFinite(fast.onset) ? fast.onset : 0;
    const hot = onset >= ONSET_GATE;
    if (hot && !this.onsetHeld && this.sinceFilament >= FILAMENT_GAP_SEC) {
      this.sinceFilament = 0;
      // Two or three, decided by the hit's own strength: a hard onset throws
      // more of them.
      const count = FILAMENT_MIN + (onset > 0.7 ? 1 : 0);
      for (let n = 0; n < count; n++) this.seedFilament(onset, p);
    }
    this.onsetHeld = hot;

    const a = this.injectMat.uniforms['uFilA']!.value as THREE.Vector4[];
    const b = this.injectMat.uniforms['uFilB']!.value as THREE.Vector4[];
    for (let s = 0; s < FILAMENT_SLOTS; s++) {
      const f = this.filaments[s]!;
      const alive = Number.isFinite(f.age);
      let intensity = alive ? f.peak * Math.exp(-f.age / FILAMENT_TAU) : 0;
      // A faded filament is retired rather than left to decay forever. The
      // shader skips a slot only on `intensity <= 0`, and an exponential never
      // reaches zero: a slot seeded once went on costing thirteen Bézier
      // samples a pixel for the life of the page, for a curve nobody can see.
      if (alive && intensity < FILAMENT_OFF) {
        f.age = Number.POSITIVE_INFINITY;
        intensity = 0;
      }
      a[s]!.set(f.p0.x, f.p0.y, f.p1.x, f.p1.y);
      b[s]!.set(f.p2.x, f.p2.y, intensity, FILAMENT_WIDTH);
    }
  }

  /**
   * One filament: a curve starting on the annulus and running along the flow.
   *
   * "Along the flow" is the *rotation*, not the curl: at the annulus the spin
   * dominates everything else the field is doing, and it is the one component
   * the CPU knows without evaluating eight octaves of noise per filament. The
   * curve bows away from that tangent, which is what makes it read as the
   * leading edge of a curl rather than as a drawn arc.
   */
  private seedFilament(onset: number, p: RenderParams): void {
    const slot = this.filaments[this.nextSlot]!;
    this.nextSlot = (this.nextSlot + 1) % FILAMENT_SLOTS;

    // Three irrational steps on one counter: deterministic, decorrelated, and
    // no allocation. A filament that landed in the same place every beat would
    // read as a logo.
    const s = ++this.seed;
    const r1 = fract(s * 0.7548776662 + 0.31);
    const r2 = fract(s * 0.5698402909 + 0.77);
    const r3 = fract(s * 0.3819660113 + 0.19);

    const a = this.annulus;
    const angle = r1 * Math.PI * 2;
    const radius = a.inner + (a.outer - a.inner) * (0.15 + 0.7 * r2);
    const cx = (a.cx - 0.5) * this.aspect();
    const cy = a.cy - 0.5;
    const ox = Math.cos(angle);
    const oy = Math.sin(angle);
    slot.p0.set(cx + ox * radius, cy + oy * radius);

    // The rotation's own direction at this point, signed by which way the
    // field is turning, and the outward normal it bows into.
    const sign = p.spinRate >= 0 ? 1 : -1;
    const tx = -oy * sign;
    const ty = ox * sign;
    const len = FILAMENT_LEN_MIN + (FILAMENT_LEN_MAX - FILAMENT_LEN_MIN) * r3;
    const bow = len * FILAMENT_BOW * (r3 < 0.5 ? 1 : -1);

    slot.p1.set(
      slot.p0.x + tx * len * 0.5 + ox * bow,
      slot.p0.y + ty * len * 0.5 + oy * bow,
    );
    slot.p2.set(slot.p0.x + tx * len, slot.p0.y + ty * len);
    slot.age = 0;
    slot.peak = Math.min(1, onset) * 1.6;
  }

  private aspect(): number {
    return this.injectMat.uniforms['uAspect']!.value as number;
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
    (this.colorMat.uniforms['uTexel']!.value as THREE.Vector2).set(1 / width, 1 / height);
    this.injectMat.uniforms['uAspect']!.value = width / height;
    // Both passes work in the aspect-corrected space the annulus radii are in.
    this.feedbackMat.uniforms['uAspect']!.value = width / height;
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}

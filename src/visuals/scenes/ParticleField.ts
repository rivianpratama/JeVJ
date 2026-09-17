/**
 * The dust: a quarter of a million points, simulated on the GPU.
 *
 * Two RGBA float textures hold the cloud — position (and a per-particle seed in
 * w) in one, velocity in the other — and a `GPUComputationRenderer` steps them
 * with a pair of fragment shaders. Nothing about the cloud is ever read back:
 * the vertex shader samples the position texture directly, so the CPU's whole
 * job each frame is to set a dozen uniforms and move the camera.
 *
 * The motion is a curl-noise field the dust drifts in, plus one attractor that
 * gathers it — a shell, a plane, a vortex, an explosion, or three moving
 * targets — plus the music hitting it. That combination is the reference look:
 * glowing dust that gathers into shells and scatters on hits. It is *not* a
 * particle system with emitters and lifetimes; nothing is born and nothing
 * dies, and what changes is only where the same dust is being pulled.
 *
 * The camera orbits slowly and dollies in on a build, so a passage that never
 * changes attractor still moves. On an impact it snaps out — reduced motion
 * turns that off, and halves the speed and the impulse besides.
 */

import * as THREE from 'three';
import { GPUComputationRenderer, type Variable } from 'three/addons/misc/GPUComputationRenderer.js';
import { withNoise3 } from '../shaders/glsl';
import {
  TIER_SMALL,
  createTierState,
  stepTier,
  tierLabel,
  type TierState,
} from '../particleTier';
import particlePosFrag from '../shaders/particle_pos.frag.glsl?raw';
import particleVelFrag from '../shaders/particle_vel.frag.glsl?raw';
import particleRenderFrag from '../shaders/particle_render.frag.glsl?raw';
import particleRenderVert from '../shaders/particle_render.vert.glsl?raw';
import type { Scene } from './Scene';
import type { FastFrame, RenderParams } from '../director';

/** `uAttractor` is the index of the attractor name in the shader's branch. */
export const ATTRACTOR_INDEX: Record<RenderParams['attractor'], number> = {
  sphere: 0,
  plane: 1,
  vortex: 2,
  explode: 3,
  swarm: 4,
};

/** The tier the gain is normalised against; see `particleTier.ts` for the rest. */
const SIZE_BASE = TIER_SMALL;

/**
 * How hard the curl field pushes the dust around, against how hard the
 * attractor pulls. The ratio is the whole character of the cloud: all
 * attractor and it collapses onto a mathematically thin shell, all curl and it
 * is fog. Roughly even gives a shell with *thickness* — dust visibly arriving
 * and leaving — which is the reference look.
 */
const CURL = 0.7;
const ATTRACT = 1.6;
/** How fast the dust sheds speed; what stops it ringing around the attractor. */
const DRAG = 1.2;
/** The speed that maps to the top of the palette. */
const SPEED_REF = 1.5;
/** Seconds for an explosion to relax back onto the shell. */
const EXPLODE_DECAY = 2;
/** Seconds for the camera's snap-out to come back in. */
const SNAP_DECAY = 0.5;
/** Where the dust starts: a soft ball, not a shell. */
const START_RADIUS = 1.6;
/** Where a rebuilt cloud starts: on the shell the director mostly asks for. */
const SHELL_RADIUS = 1.2;
/** One grain's share of the light, at the base tier. See `uGain`. */
const GRAIN_GAIN = 0.11;
/** The camera's resting distance, and how far a build pulls it in. */
const CAMERA_Z = 4.2;
const BUILD_DOLLY = 0.6;

export class ParticleField implements Scene {
  readonly name = 'particles' as const;

  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private readonly scene = new THREE.Scene();
  private readonly material: THREE.ShaderMaterial;

  private renderer: THREE.WebGLRenderer | null = null;
  private gpu: GPUComputationRenderer | null = null;
  private posVar: Variable | null = null;
  private velVar: Variable | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private points: THREE.Points | null = null;
  private target: THREE.WebGLRenderTarget | null = null;

  private size = SIZE_BASE;
  private width = 1;
  private height = 1;
  private maxTextureSize = 0;
  private readonly tier: TierState = createTierState();
  /** The last value `tune` was handed; the camera reads it. */
  private reducedMotion = false;
  /** Set when the compute renderer could not start; the scene then draws black. */
  private disabled = false;

  /** 1 the instant the cloud bursts, 0 once it has gathered again. */
  private explode = 0;
  private wasExploding = false;
  /** The camera's outward lurch, decaying. */
  private snap = 0;
  /** The orbit angle, integrated rather than evaluated. See `update`. */
  private theta = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      // No noise header: the render pass only reads the simulation back.
      vertexShader: particleRenderVert,
      fragmentShader: particleRenderFrag,
      // Additive, depth off: the dust is light, and light does not occlude.
      // It is also why the cloud needs no depth sort.
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      uniforms: {
        uPos: { value: null },
        uVel: { value: null },
        uPointSize: { value: 2 },
        uSpeedRef: { value: SPEED_REF },
        uStops: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()) },
        uAccent: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
        uGain: { value: GRAIN_GAIN },
      },
    });
  }

  init(r: THREE.WebGLRenderer, w: number, h: number): void {
    this.renderer = r;
    this.maxTextureSize = r.capabilities.maxTextureSize;
    // Always the small cloud to begin with. Nothing has been measured yet, and
    // the old guard — pixel ratio ≤ 1.5 — could never fail, because the
    // renderer caps the ratio at 1.5 before this ever reads it.
    this.build(TIER_SMALL, false);
    this.allocate(w, h);
  }

  /**
   * Hand the scene what the last frame cost. It decides the tier from that and
   * rebuilds when the answer changes; see `particleTier.ts` for the rules.
   *
   * `drawn` is whether the cloud was actually in that frame — the renderer
   * skips a layer that is out of the mix, and a frame that did not pay for the
   * particles is not evidence about them. Returns whether the tier changed, so
   * the caller can ask for the frame cost to be measured again.
   */
  tune(
    frameMs: number,
    dt: number,
    playing: boolean,
    drawn: boolean,
    reducedMotion: boolean,
  ): boolean {
    this.reducedMotion = reducedMotion;
    if (this.disabled || this.renderer === null) return false;
    const want = stepTier(this.tier, {
      dt,
      frameMs,
      maxTextureSize: this.maxTextureSize,
      playing,
      drawn,
      reducedMotion,
    });
    if (want === this.size) return false;
    this.build(want, true);
    return true;
  }

  /** What the HUD prints: how many points are in the cloud right now. */
  tierName(): string {
    return tierLabel(this.size);
  }

  /** The smoothed frame time the tier decision is being taken on, in ms. */
  smoothedFrameMs(): number {
    return this.tier.frameMs;
  }

  /**
   * Build (or rebuild) the simulation at `size`.
   *
   * A rebuild throws the cloud away — there is no sensible way to resample a
   * quarter of a million particles onto half a million texels — so the dust is
   * reseeded onto the shell rather than into a ball, which is where most of the
   * attractors want it anyway. One frame of discontinuity, seconds apart at
   * worst, against a cloud sized to the machine.
   */
  private build(size: number, rebuild: boolean): void {
    const r = this.renderer;
    if (r === null) return;

    if (rebuild) {
      if (this.points !== null) this.scene.remove(this.points);
      this.points = null;
      this.gpu?.dispose();
      this.gpu = null;
      this.posVar = null;
      this.velVar = null;
      this.geometry?.dispose();
      this.geometry = null;
    }

    this.size = size;
    // Twice the grains must not mean twice the light.
    this.material.uniforms['uGain']!.value =
      (GRAIN_GAIN * SIZE_BASE * SIZE_BASE) / (this.size * this.size);

    const gpu = new GPUComputationRenderer(this.size, this.size, r);
    // Full float where the driver will render to it. Half-float positions are
    // accurate to about 2 mm at the wrap radius, which is under one frame's
    // movement — visible as a stutter in the slowest dust, so it is the
    // fallback and not the default.
    if (!r.extensions.has('EXT_color_buffer_float')) gpu.setDataType(THREE.HalfFloatType);

    const pos0 = gpu.createTexture();
    const vel0 = gpu.createTexture();
    seed(pos0.image.data as Float32Array, vel0.image.data as Float32Array, rebuild);

    // Only the velocity shader needs the noise header; the position shader is
    // an integration and a wrap.
    const posVar = gpu.addVariable('texturePosition', particlePosFrag, pos0);
    const velVar = gpu.addVariable('textureVelocity', withNoise3(particleVelFrag), vel0);
    gpu.setVariableDependencies(posVar, [posVar, velVar]);
    gpu.setVariableDependencies(velVar, [posVar, velVar]);

    Object.assign(posVar.material.uniforms, {
      uDt: { value: 1 / 60 },
      uSpeed: { value: 1 },
    });
    Object.assign(velVar.material.uniforms, {
      uTime: { value: 0 },
      uDt: { value: 1 / 60 },
      uCurl: { value: CURL },
      uAttract: { value: ATTRACT },
      uDrag: { value: DRAG },
      uAttractor: { value: ATTRACTOR_INDEX.sphere },
      uRadius: { value: 1.2 },
      uForce: { value: 1 },
      uExplode: { value: 0 },
      uImpact: { value: 0 },
      uOnset: { value: 0 },
      uImpulse: { value: 1 },
    });

    const error = gpu.init();
    if (error !== null) {
      // A machine without vertex texture fetch cannot run this scene at all.
      // The rest of the app is unaffected: the layer just stays black — and
      // there is no point allocating a quarter of a million points to draw it.
      console.warn(`ParticleField: ${error}`);
      gpu.dispose();
      this.disabled = true;
      return;
    }

    this.gpu = gpu;
    this.posVar = posVar;
    this.velVar = velVar;

    this.geometry = pointGeometry(this.size);
    const points = new THREE.Points(this.geometry, this.material);
    // The positions live in a texture, so the bounding sphere three computes
    // from the (zeroed) position attribute would cull the whole cloud.
    points.frustumCulled = false;
    this.points = points;
    this.scene.add(points);
  }

  resize(w: number, h: number): void {
    this.allocate(w, h);
  }

  update(dt: number, p: RenderParams, fast: FastFrame, time: number): void {
    // The burst envelope. It restarts when the attractor becomes `explode` and
    // on every hit while it is, and relaxes to the shell over two seconds.
    const exploding = p.attractor === 'explode';
    if (exploding) {
      if (!this.wasExploding || fast.impact > 0.5) this.explode = 1;
      else this.explode = Math.max(0, this.explode - dt / EXPLODE_DECAY);
    } else {
      this.explode = 0;
    }
    this.wasExploding = exploding;

    if (this.posVar !== null && this.velVar !== null) {
      const pu = this.posVar.material.uniforms;
      pu['uDt']!.value = dt;
      pu['uSpeed']!.value = p.particleSpeed;

      const vu = this.velVar.material.uniforms;
      vu['uTime']!.value = time;
      vu['uDt']!.value = dt;
      vu['uAttractor']!.value = ATTRACTOR_INDEX[p.attractor];
      vu['uRadius']!.value = p.attractorRadius;
      vu['uForce']!.value = p.attractorForce;
      vu['uExplode']!.value = this.explode;
      vu['uImpact']!.value = fast.impact;
      vu['uOnset']!.value = fast.onset;
      vu['uImpulse']!.value = p.particleImpulse;
    }

    const u = this.material.uniforms;
    u['uPointSize']!.value = p.pointSize * (this.renderer?.getPixelRatio() ?? 1);
    const stops = u['uStops']!.value as THREE.Vector3[];
    for (let s = 0; s < stops.length; s++) {
      const rgb = p.palette.stops[s] ?? p.palette.stops[p.palette.stops.length - 1]!;
      stops[s]!.set(rgb[0], rgb[1], rgb[2]);
    }
    (u['uAccent']!.value as THREE.Vector3).set(
      p.palette.accent[0],
      p.palette.accent[1],
      p.palette.accent[2],
    );
    u['uExposure']!.value = p.exposure;

    // The camera: a slow orbit that never repeats on a round number, pulled in
    // by a build and knocked out by a hit.
    // The orbit is integrated from its own rate rather than evaluated from the
    // clock. They describe the same path — 0.05 + 0.3·0.02·cos(t·0.02) is the
    // derivative of the brief's θ = t·0.05 + 0.3·sin(t·0.02) — but a rate can
    // be halved for reduced motion without the camera jumping to wherever the
    // halved *angle* happens to point the moment the setting is toggled.
    //
    // Reduced motion also stills the vertical bob. The dolly is already
    // switched off by the director, through `dollySnap`.
    const orbitRate = (0.05 + 0.006 * Math.cos(time * 0.02)) * (this.reducedMotion ? 0.5 : 1);
    this.theta += orbitRate * dt;
    this.snap = Math.max(this.snap - dt / SNAP_DECAY, p.dollySnap * fast.impact);
    const theta = this.theta;
    const radius = CAMERA_Z - BUILD_DOLLY * fast.build + this.snap;
    this.camera.position.set(
      Math.sin(theta) * radius,
      this.reducedMotion ? 0 : 0.35 * Math.sin(time * 0.03),
      Math.cos(theta) * radius,
    );
    this.camera.lookAt(0, 0, 0);

    // The simulation steps here rather than in `render`, because the renderer
    // skips `render` for a layer that is out of the mix. A cloud that stopped
    // moving while the music was quiet would fade back in holding whatever it
    // was doing when it left.
    if (this.gpu !== null && this.posVar !== null && this.velVar !== null) {
      this.gpu.compute();
      this.material.uniforms['uPos']!.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
      this.material.uniforms['uVel']!.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    }
  }

  render(r: THREE.WebGLRenderer): THREE.Texture {
    const target = this.target;
    if (!target) throw new Error('ParticleField: render before init');

    const autoClear = r.autoClear;
    r.setRenderTarget(target);
    r.autoClear = true;
    // Disabled means no simulation textures are bound; the clear is the frame.
    if (!this.disabled) r.render(this.scene, this.camera);
    else r.clear();
    r.autoClear = autoClear;
    r.setRenderTarget(null);
    return target.texture;
  }

  dispose(): void {
    if (this.points !== null) this.scene.remove(this.points);
    this.points = null;
    this.gpu?.dispose();
    this.gpu = null;
    this.posVar = null;
    this.velVar = null;
    this.geometry?.dispose();
    this.geometry = null;
    this.material.dispose();
    this.target?.dispose();
    this.target = null;
    this.renderer = null;
  }

  private allocate(w: number, h: number): void {
    const width = Math.max(2, Math.floor(w));
    const height = Math.max(2, Math.floor(h));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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

/**
 * The cloud's opening state: a soft ball of dust, barely moving.
 *
 * The radius is cubed-rooted so the ball is of even density rather than packed
 * toward the middle, and `w` is a uniform random per particle — the seed the
 * accent tint and nothing else is chosen by.
 *
 * `onShell` is for a rebuild rather than a first start: the cloud that is being
 * replaced has long since gathered, and dropping a fresh ball into the middle
 * of a track is a visible collapse where landing on the shell is barely a
 * flicker.
 */
function seed(pos: Float32Array, vel: Float32Array, onShell: boolean): void {
  for (let i = 0; i < pos.length; i += 4) {
    // A direction picked off a uniform sphere, not off a cube.
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = onShell
      ? SHELL_RADIUS + (Math.random() - 0.5) * 0.2
      : START_RADIUS * Math.cbrt(Math.random());
    pos[i] = s * Math.cos(phi) * r;
    pos[i + 1] = u * r;
    pos[i + 2] = s * Math.sin(phi) * r;
    pos[i + 3] = Math.random();

    vel[i] = (Math.random() - 0.5) * 0.1;
    vel[i + 1] = (Math.random() - 0.5) * 0.1;
    vel[i + 2] = (Math.random() - 0.5) * 0.1;
    vel[i + 3] = 1;
  }
}

/** One point per texel, carrying only where in the simulation it lives. */
function pointGeometry(size: number): THREE.BufferGeometry {
  const count = size * size;
  const refs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    // Sampled at texel centres: at the edges a half-texel error would read the
    // wrong particle entirely.
    refs[i * 2] = ((i % size) + 0.5) / size;
    refs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aRef', new THREE.BufferAttribute(refs, 2));
  return geometry;
}

/**
 * The silk: four hundred vertical ribbons in a slow current.
 *
 * One instanced strip, drawn four hundred times. The whole shape of a strand —
 * where it hangs, how far the current bends it, how it sways — is computed in
 * the vertex shader from the instance's own seed, so the CPU never touches a
 * vertex and the geometry is built once at startup and never rebuilt.
 *
 * How many of the four hundred are actually drawn follows the layer's own
 * weight: each strand holds a hash, and only those under the weight survive the
 * fragment shader. A quiet mix is a scattering of ribbons over a dark field and
 * the full curtain assembles only when the director hands this layer the frame.
 * Drawing all four hundred at a low weight instead — which is what scaling the
 * finished texture alone does — gives a uniform pale rain with no dark in it.
 *
 * This is the layer the director reaches for when the music is *quiet* and
 * tense: where the dust needs energy to look like anything, silk reads best
 * when almost nothing is happening to it. Bend comes from tension and
 * thickness from the bass, so a still, tense passage is a curtain of thin
 * ribbons leaning hard in one direction, and a low, calm one is a slack heavy
 * fall.
 */

import * as THREE from 'three';
import { withNoise3 } from '../shaders/glsl';
import strandsFrag from '../shaders/strands.frag.glsl?raw';
import strandsVert from '../shaders/strands.vert.glsl?raw';
import type { Scene } from './Scene';
import type { FastFrame, RenderParams } from '../director';

/** How many ribbons, and how finely each one is cut. */
const STRANDS = 400;
const SEGMENTS = 64;
/** Where the ribbons hang, before the current moves them. */
const SPREAD_X = 2.2;
const SPREAD_Z = 1.4;
/** The camera sits still: the strands move, the view does not. */
const CAMERA_Z = 3;
/** How much wider the halo pass is than the ribbon, and how much dimmer. */
const HALO_WIDTH = 3;
const HALO_ALPHA = 0.15;

export class Strands implements Scene {
  readonly name = 'strands' as const;

  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private readonly scene = new THREE.Scene();
  private readonly geometry: THREE.InstancedBufferGeometry;
  /** The ribbon itself, and the wide soft pass around it. */
  private readonly material: THREE.ShaderMaterial;
  private readonly halo: THREE.ShaderMaterial;
  private readonly materials: THREE.ShaderMaterial[];
  private readonly mesh: THREE.Mesh;
  private readonly haloMesh: THREE.Mesh;

  private target: THREE.WebGLRenderTarget | null = null;
  private width = 1;
  private height = 1;

  constructor() {
    this.geometry = ribbonGeometry(STRANDS, SEGMENTS);
    this.material = ribbonMaterial(1, 1);
    // Three times the width at a seventh of the alpha: bright cores sitting in
    // a halo, which is what silk over black looks like and what a single flat
    // ribbon never does. Additive, so the two passes need no ordering.
    this.halo = ribbonMaterial(HALO_WIDTH, HALO_ALPHA);
    this.materials = [this.material, this.halo];

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.haloMesh = new THREE.Mesh(this.geometry, this.halo);
    // The strands are displaced entirely in the vertex shader, so the bounds
    // three computes from the undisplaced strip would cull them once they lean.
    this.mesh.frustumCulled = false;
    this.haloMesh.frustumCulled = false;
    this.scene.add(this.haloMesh);
    this.scene.add(this.mesh);
    this.camera.position.set(0, 0, CAMERA_Z);
  }

  init(_r: THREE.WebGLRenderer, w: number, h: number): void {
    this.allocate(w, h);
  }

  resize(w: number, h: number): void {
    this.allocate(w, h);
  }

  update(_dt: number, p: RenderParams, fast: FastFrame, time: number): void {
    // Both passes see the same strand — same shape, same colour, same
    // visibility — and differ only in the two constants set at construction.
    for (const m of this.materials) {
      const u = m.uniforms;
      u['uTime']!.value = time;
      u['uBend']!.value = p.strandBend;
      u['uThickness']!.value = p.strandThickness;
      u['uDownbeat']!.value = fast.downbeatPulse;
      u['uExposure']!.value = p.exposure;
      // The layer's own weight, which is how many ribbons it draws. The
      // Composer scales the finished texture by the same number; this is the
      // *other* half of the fade, and it is what keeps a quiet mix from being a
      // full curtain rendered dim.
      u['uWeight']!.value = p.weights.strands;

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
    }
  }

  render(r: THREE.WebGLRenderer): THREE.Texture {
    const target = this.target;
    if (!target) throw new Error('Strands: render before init');

    const autoClear = r.autoClear;
    r.setRenderTarget(target);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.autoClear = autoClear;
    r.setRenderTarget(null);
    return target.texture;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.scene.remove(this.haloMesh);
    this.geometry.dispose();
    this.material.dispose();
    this.halo.dispose();
    this.target?.dispose();
    this.target = null;
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
 * One ribbon pass: the core at width 1 and alpha 1, or the halo at 3 and 0.15.
 *
 * Two materials rather than two draws of one, because a uniform belongs to a
 * material: setting it between draws would mean two `setValue` calls and a
 * program re-upload per frame for numbers that never change.
 */
function ribbonMaterial(widthScale: number, alphaScale: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: withNoise3(strandsVert),
    fragmentShader: strandsFrag,
    // Additive and depth-free, like the dust: ribbons that cross brighten
    // rather than hide each other, which is what makes a curtain of them read
    // as translucent silk instead of as painted strips.
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uBend: { value: 0.6 },
      uThickness: { value: 0.01 },
      uStops: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()) },
      uAccent: { value: new THREE.Vector3(1, 1, 1) },
      uDownbeat: { value: 0 },
      uExposure: { value: 1 },
      uWeight: { value: 0 },
      uWidthScale: { value: widthScale },
      uAlphaScale: { value: alphaScale },
    },
  });
}

/**
 * One strip of `segments` quads, instanced `count` times.
 *
 * The per-vertex attributes carry only "how far down" and "which edge"; the
 * per-instance ones carry where the strand hangs, the phase of its sway and its
 * index (which is what picks its colour). The `position` attribute is the
 * undisplaced centreline — unused by the shader, but three.js expects one and
 * it keeps the geometry's bounds meaningful.
 */
function ribbonGeometry(count: number, segments: number): THREE.InstancedBufferGeometry {
  const rows = segments + 1;
  const verts = rows * 2;
  const position = new Float32Array(verts * 3);
  const side = new Float32Array(verts);
  const along = new Float32Array(verts);
  const index = new Uint16Array(segments * 6);

  for (let row = 0; row < rows; row++) {
    const t = row / segments;
    for (let s = 0; s < 2; s++) {
      const v = row * 2 + s;
      position[v * 3 + 1] = -2 + 4 * t;
      side[v] = s === 0 ? -1 : 1;
      along[v] = t;
    }
  }
  for (let q = 0; q < segments; q++) {
    const a = q * 2;
    const i = q * 6;
    index[i] = a;
    index[i + 1] = a + 1;
    index[i + 2] = a + 2;
    index[i + 3] = a + 1;
    index[i + 4] = a + 3;
    index[i + 5] = a + 2;
  }

  // Where each ribbon hangs. Spread by a cheap hash rather than a grid: a grid
  // of 400 strands reads as a grid the moment two of them line up.
  const base = new Float32Array(count * 3);
  const ids = new Float32Array(count);
  // The visibility hash. It has its own irrational step, independent of the
  // sway phase: sharing one would mean every *visible* strand also shared a
  // narrow band of phase, and they would all lean together.
  const hashes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    base[i * 3] = (fract(i * 0.7548776662) * 2 - 1) * SPREAD_X;
    base[i * 3 + 1] = (fract(i * 0.5698402909) * 2 - 1) * SPREAD_Z;
    base[i * 3 + 2] = fract(i * 0.3819660113) * 6.2831853;
    ids[i] = i;
    hashes[i] = fract(i * 0.6180339887 + 0.137);
  }

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.instanceCount = count;
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geometry.setAttribute('aT', new THREE.BufferAttribute(along, 1));
  geometry.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 3));
  geometry.setAttribute('aId', new THREE.InstancedBufferAttribute(ids, 1));
  geometry.setAttribute('aHash', new THREE.InstancedBufferAttribute(hashes, 1));
  return geometry;
}

function fract(x: number): number {
  return x - Math.floor(x);
}

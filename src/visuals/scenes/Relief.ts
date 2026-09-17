/**
 * The terrain: a quarter of a million vertices of displaced plane, lit by one
 * raking lamp.
 *
 * This is the layer for grief and for anger — the two moods that want mass
 * rather than motion. Everything else in the app is made of light with nothing
 * behind it; this is the one thing on screen with a *surface*, and that is why
 * it is composited alpha-over rather than added: a ridge is opaque, and a ridge
 * you can see the ink through is a fog bank.
 *
 * The plane is built once, in XZ, 512 × 512 vertices, and never touched again.
 * The height field lives entirely in `relief_height.glsl` — prepended to both
 * shaders, so the vertex displacement and the fragment shader's finite-
 * difference normal are provably the same function — and the only per-frame
 * work on the CPU is a dozen uniforms and the camera.
 *
 * The camera looks down at 55° and drifts on a slow bounded Lissajous. It is
 * bounded on purpose: a camera that travels in a straight line runs off a
 * finite plane, and the alternative — an infinite plane — costs a fade at both
 * ends instead of one.
 */

import * as THREE from 'three';
import { withCommon } from '../shaders/glsl';
import reliefHeightGlsl from '../shaders/relief_height.glsl?raw';
import reliefFrag from '../shaders/relief.frag.glsl?raw';
import reliefVert from '../shaders/relief.vert.glsl?raw';
import type { Scene } from './Scene';
import type { FastFrame, RenderParams } from '../director';

/** The plane: how wide, and how finely it is cut. */
const PLANE_SIZE = 24;
const SEGMENTS = 511;
/**
 * How many noise cells the plane is across.
 *
 * At idle the director asks for a height of 0.39, which over a coarse field is
 * a nearly flat plane — and a flat plane under a raking light is a uniform grey
 * wash whatever the light does. At 0.9 the same height gives real slope: ridges
 * that catch the lamp and faces that do not, which is what the contrast between
 * the mean and the floor of the frame actually comes from.
 */
const FREQ = 0.9;
/** How far the camera sits from the point it looks at, and how far down. */
const CAMERA_DISTANCE = 5;
const CAMERA_PITCH_DEG = 55;
/** How far the slow pan wanders, and how fast, on each axis. */
const PAN_X = 1.6;
const PAN_X_RATE = 0.021;
const PAN_Z = 1.2;
const PAN_Z_RATE = 0.013;
/** Where the terrain starts and finishes dissolving, in view distance. */
const FADE_NEAR = 6;
const FADE_FAR = 13;

export class Relief implements Scene {
  readonly name = 'relief' as const;

  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  private readonly scene = new THREE.Scene();
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  private target: THREE.WebGLRenderTarget | null = null;
  private width = 1;
  private height = 1;

  constructor() {
    this.geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, SEGMENTS, SEGMENTS);
    // Once, at build time: the plane lies in XZ from here on, so the shader's
    // displacement is `position.y += h` and nothing has to be rotated per frame.
    this.geometry.rotateX(-Math.PI / 2);

    const height = `${reliefHeightGlsl}\n`;
    this.material = new THREE.ShaderMaterial({
      vertexShader: withCommon(height + reliefVert),
      fragmentShader: withCommon(height + reliefFrag),
      // A surface, not light: it occludes, and the Composer alpha-blends it
      // over what is behind by this layer's weight. Blending is *off* here —
      // there is exactly one mesh drawing into a cleared target, and letting
      // three's normal blend run would leave premultiplied colour and a
      // squared alpha in the texture, which the Composer would then multiply by
      // the alpha a second time. Straight through, and the Composer does the
      // one composite there is.
      blending: THREE.NoBlending,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide,
      uniforms: {
        uTime: { value: 0 },
        uFreq: { value: FREQ },
        uHeight: { value: 0.3 },
        uBands: { value: new Float32Array(8) },
        uContrast: { value: 1 },
        uBg: { value: new THREE.Vector3() },
        uStop4: { value: new THREE.Vector3(1, 1, 1) },
        uEmber: { value: new THREE.Vector3(1, 1, 1) },
        uAggression: { value: 0 },
        uSub: { value: 0 },
        uExposure: { value: 1 },
        uStep: { value: PLANE_SIZE / SEGMENTS },
        uFade: { value: new THREE.Vector2(FADE_NEAR, FADE_FAR) },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The displacement happens in the vertex shader, so the bounds three
    // computed from the flat plane would cull the ridges at a grazing view.
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  init(_r: THREE.WebGLRenderer, w: number, h: number): void {
    this.allocate(w, h);
  }

  resize(w: number, h: number): void {
    this.allocate(w, h);
  }

  update(_dt: number, p: RenderParams, fast: FastFrame, time: number): void {
    const u = this.material.uniforms;
    u['uTime']!.value = time;
    u['uHeight']!.value = p.reliefHeight;
    u['uContrast']!.value = p.reliefContrast;
    u['uExposure']!.value = p.exposure;
    u['uSub']!.value = fast.sub;
    (u['uBands']!.value as Float32Array).set(fast.bands);

    // The embers are gated on aggression alone, which `reliefHeight` cannot be
    // read back for — it is the *average* of aggression and melancholy, and a
    // desolate landscape is as tall as a furious one but must not glow. So the
    // director hands the number over directly rather than the scene reaching
    // for the mood vector, which no scene in this app is allowed to see.
    u['uAggression']!.value = p.reliefAggression;

    const stop4 = p.palette.stops[4] ?? p.palette.stops[p.palette.stops.length - 1]!;
    (u['uStop4']!.value as THREE.Vector3).set(stop4[0], stop4[1], stop4[2]);
    (u['uBg']!.value as THREE.Vector3).set(p.palette.bg[0], p.palette.bg[1], p.palette.bg[2]);
    (u['uEmber']!.value as THREE.Vector3).set(
      p.palette.ember[0],
      p.palette.ember[1],
      p.palette.ember[2],
    );

    // The pan. Bounded, slow, and on two incommensurate rates so the camera
    // never retraces the same path.
    const px = PAN_X * Math.sin(time * PAN_X_RATE);
    const pz = PAN_Z * Math.sin(time * PAN_Z_RATE);
    const pitch = (CAMERA_PITCH_DEG * Math.PI) / 180;
    this.camera.position.set(
      px,
      CAMERA_DISTANCE * Math.sin(pitch),
      pz + CAMERA_DISTANCE * Math.cos(pitch),
    );
    this.camera.lookAt(px, 0, pz);
  }

  render(r: THREE.WebGLRenderer): THREE.Texture {
    const target = this.target;
    if (!target) throw new Error('Relief: render before init');

    // The clear has to be *transparent* black, explicitly. Everything the
    // terrain does not cover leaves this target at the clear value, and the
    // Composer composites this layer alpha-over: at clear alpha 1 every
    // uncovered pixel would lay opaque black over the ink and the relief would
    // darken the composite exactly where there is no relief. three's default
    // clear alpha is 0, but it is a renderer-wide setting any other pass could
    // have moved, so this scene sets it for its own draw and puts it back.
    const autoClear = r.autoClear;
    const clearAlpha = r.getClearAlpha();
    r.setClearAlpha(0);
    r.setRenderTarget(target);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.setClearAlpha(clearAlpha);
    r.autoClear = autoClear;
    r.setRenderTarget(null);
    return target.texture;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
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
      // The one scene in the app that needs a depth buffer: a terrain occludes
      // itself, and without one the far ridges draw over the near ones.
      depthBuffer: true,
      stencilBuffer: false,
    });
  }
}

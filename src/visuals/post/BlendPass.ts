/**
 * The first pass: the scene textures, weighted into one image.
 *
 * It ignores `tDiffuse` — there is nothing before it — and generates the
 * composite the rest of the chain filters. Scenes that do not exist yet are
 * bound to a 1×1 black texture at weight 0, so the shader never has to branch
 * and the chain never has to be rebuilt when a layer is added.
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import blendFrag from '../shaders/blend.frag.glsl?raw';
import { FULLSCREEN_VERT, withCommon } from '../shaders/glsl';

const SLOTS = 5;

function blackTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

export class BlendPass extends ShaderPass {
  private readonly black = blackTexture();

  constructor() {
    super({
      name: 'BlendPass',
      uniforms: {
        tDiffuse: { value: null },
        uTex0: { value: null },
        uTex1: { value: null },
        uTex2: { value: null },
        uTex3: { value: null },
        uTex4: { value: null },
        uW: { value: new Float32Array(SLOTS) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(blendFrag),
    });
    for (let i = 0; i < SLOTS; i++) this.uniforms[`uTex${i}`]!.value = this.black;
  }

  /** Bind up to five scene textures and their weights, in slot order. */
  setLayers(textures: readonly (THREE.Texture | null)[], weights: readonly number[]): void {
    const w = this.uniforms['uW']!.value as Float32Array;
    for (let i = 0; i < SLOTS; i++) {
      const tex = textures[i] ?? null;
      this.uniforms[`uTex${i}`]!.value = tex ?? this.black;
      w[i] = tex === null ? 0 : (weights[i] ?? 0);
    }
  }

  override dispose(): void {
    this.black.dispose();
    super.dispose();
  }
}

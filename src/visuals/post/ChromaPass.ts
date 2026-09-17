/**
 * Radial RGB split, plus the beat-locked posterize the director reserves for
 * hard electronic peaks.
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import chromaFrag from '../shaders/chroma.frag.glsl?raw';
import { FULLSCREEN_VERT, withCommon } from '../shaders/glsl';

export class ChromaPass extends ShaderPass {
  constructor() {
    super({
      name: 'ChromaPass',
      uniforms: {
        tDiffuse: { value: null },
        uChroma: { value: 0 },
        uPosterize: { value: 0 },
        uBeatPhase: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(chromaFrag),
    });
  }

  set(chroma: number, posterize: number, beatPhase: number): void {
    this.uniforms['uChroma']!.value = chroma;
    this.uniforms['uPosterize']!.value = posterize;
    this.uniforms['uBeatPhase']!.value = beatPhase;
  }
}

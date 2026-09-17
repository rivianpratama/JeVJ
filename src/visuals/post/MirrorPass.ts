/**
 * Kaleidoscope. Folds of 0 is a pass-through, which is the usual case — the
 * director only turns it on for hypnotic music.
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import mirrorFrag from '../shaders/mirror.frag.glsl?raw';
import { FULLSCREEN_VERT, withCommon } from '../shaders/glsl';

export class MirrorPass extends ShaderPass {
  constructor() {
    super({
      name: 'MirrorPass',
      uniforms: {
        tDiffuse: { value: null },
        uFolds: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(mirrorFrag),
    });
  }

  set(folds: number, aspect: number): void {
    this.uniforms['uFolds']!.value = folds;
    this.uniforms['uAspect']!.value = aspect;
  }
}

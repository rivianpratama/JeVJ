/**
 * Kaleidoscope. Folds of 0 — or a mix of 0 — is a pass-through, which is the
 * usual case: the director only turns it on for hypnotic music and for terrain
 * that has taken the frame.
 *
 * `mix` is how much of the figure is on screen. It exists because `folds` is an
 * integer: the count can only change while the mix is near zero, so the figure
 * dissolves, re-folds unseen, and comes back.
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
        uMix: { value: 0 },
        uAspect: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(mirrorFrag),
    });
  }

  set(folds: number, mix: number, aspect: number, time: number): void {
    this.uniforms['uFolds']!.value = folds;
    this.uniforms['uMix']!.value = mix;
    this.uniforms['uAspect']!.value = aspect;
    this.uniforms['uTime']!.value = time;
  }
}

/**
 * Film grain and a feathered vignette — the last thing before the OutputPass
 * tone-maps and encodes.
 *
 * Note what is *not* here: exposure. The director's `exposure` is applied in
 * the ink's color stage instead, so that a splash lifts the image through the
 * bloom threshold rather than brightening an image that has already bloomed.
 * It is still a multiply before tone mapping, which is all the chain requires.
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import grainFrag from '../shaders/grain.frag.glsl?raw';
import { FULLSCREEN_VERT, withCommon } from '../shaders/glsl';

export class GrainVignettePass extends ShaderPass {
  constructor() {
    super({
      name: 'GrainVignettePass',
      uniforms: {
        tDiffuse: { value: null },
        uGrain: { value: 0.04 },
        uVignette: { value: 0.4 },
        uTime: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: withCommon(grainFrag),
    });
  }

  set(grain: number, vignette: number, time: number, aspect: number): void {
    this.uniforms['uGrain']!.value = grain;
    this.uniforms['uVignette']!.value = vignette;
    this.uniforms['uTime']!.value = time;
    this.uniforms['uAspect']!.value = aspect;
  }
}

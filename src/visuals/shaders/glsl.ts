/**
 * Shader sources, assembled.
 *
 * Every fragment shader in the app is `common.glsl` plus itself, concatenated
 * here at load time — there is no #include in GLSL ES, and a preprocessor
 * plugin would be a build dependency for three lines of string work. The
 * vertex shader is the same screen-filling quad everywhere, so it is exported
 * as it is.
 */

import common from './common.glsl?raw';
import fullscreenVert from './fullscreen.vert.glsl?raw';
import noise3 from './noise3.glsl?raw';

export const FULLSCREEN_VERT = fullscreenVert;

/** `src` with the shared helpers in front of it. */
export function withCommon(src: string): string {
  return `${common}\n${src}`;
}

/**
 * `src` with the 3D noise in front of it. Used by the volumetric scenes, and
 * by their *vertex* shaders too — which is why it is a separate header from
 * `common.glsl` rather than part of it.
 */
export function withNoise3(src: string): string {
  return `${noise3}\n${src}`;
}

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

export const FULLSCREEN_VERT = fullscreenVert;

/** `src` with the shared helpers in front of it. */
export function withCommon(src: string): string {
  return `${common}\n${src}`;
}

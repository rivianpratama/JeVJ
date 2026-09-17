/**
 * What a visual layer has to be able to do.
 *
 * A scene draws into its own half-resolution target and hands back the texture;
 * it never draws to the screen and never knows what else is on it. The mix,
 * the post chain and the output are the Composer's business. That split is what
 * lets Tasks 10 and 11 add layers without touching a line of this one, and what
 * lets the director cross-fade between them by weight alone.
 */

import type * as THREE from 'three';
import type { FastFrame, RenderParams } from '../director';

export interface Scene {
  /** Which weight in `RenderParams.weights` this scene is mixed by. */
  readonly name: keyof RenderParams['weights'];
  init(r: THREE.WebGLRenderer, w: number, h: number): void;
  resize(w: number, h: number): void;
  update(dt: number, p: RenderParams, fast: FastFrame, time: number): void;
  /** Draw one frame and return the texture the Composer should mix. */
  render(r: THREE.WebGLRenderer): THREE.Texture;
  dispose(): void;
}

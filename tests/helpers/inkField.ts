/**
 * `common.glsl`'s noise, in TypeScript, and the idle ink field it produces.
 *
 * The ambient wash is a *spatial* pattern — ink pools in veins with dark
 * channels between them — so "how bright is the field" is a question about a
 * distribution, not about a number, and it cannot be answered without the
 * noise that shapes it. This is a faithful port of `hash12`, `vnoise`, `rot2`
 * and `fbm`.
 *
 * Faithful, not bit-identical: GLSL evaluates these in 32-bit float and the
 * hash deliberately works in the low bits of numbers around 10⁴, so individual
 * samples differ from the GPU's in the last places. The *statistics* — which
 * is all any of this is used for — do not.
 *
 * The constants are read out of the shipped shaders rather than repeated here,
 * so a tuning pass that moves one cannot leave the test asserting the old
 * value. See `shaderConst`.
 */

import inkColorFrag from '../../src/visuals/shaders/ink_color.frag.glsl?raw';
import inkInjectFrag from '../../src/visuals/shaders/ink_inject.frag.glsl?raw';
import {
  AMBIENT_LEVEL,
  ambientInjectPerFrame,
  inkEquilibriumDensity,
  inkLevel,
} from '../../src/visuals/inkMath';

/** A `const float NAME = value;` out of a shader source. */
export function shaderConst(source: string, name: string): number {
  const m = new RegExp(`const\\s+float\\s+${name}\\s*=\\s*(-?[0-9.]+)\\s*;`).exec(source);
  if (!m) throw new Error(`inkField: no const float ${name} in the shader`);
  return Number(m[1]);
}

export const INJECT_RATE = shaderConst(inkInjectFrag, 'INJECT_RATE');
export const VEIN_LO = shaderConst(inkInjectFrag, 'VEIN_LO');
export const VEIN_HI = shaderConst(inkInjectFrag, 'VEIN_HI');
export const KNEE = shaderConst(inkColorFrag, 'KNEE');

function fract(x: number): number {
  return x - Math.floor(x);
}

export function hash12(x: number, y: number): number {
  let p0 = fract(x * 0.1031);
  let p1 = fract(y * 0.1031);
  let p2 = fract(x * 0.1031);
  const dot = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
  p0 += dot;
  p1 += dot;
  p2 += dot;
  return fract((p0 + p1) * p2);
}

/** Value noise with a smoothstep interpolant. */
export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy);
  const b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1);
  const d = hash12(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

/** Four octaves, each rotated by 0.5 rad and scaled by 2.02. */
export function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  for (let i = 0; i < 4; i++) {
    sum += amp * vnoise(px, py);
    // mat2(c, -s, s, c) is column-major: rows are (c, s) and (-s, c).
    const rx = (c * px + s * py) * 2.02;
    const ry = (-s * px + c * py) * 2.02;
    px = rx;
    py = ry;
    amp *= 0.5;
  }
  return sum;
}

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Where the wash is sampled from.
 *
 * The frame is three units of noise across, which is only a handful of lattice
 * cells: the statistics of any single patch are an accident of which hash
 * values happen to land in it, and the port's hashes are not the GPU's. The
 * pattern drifts by more than a cell a minute, so pooling over eight positions
 * is both the port-independent answer and the one a viewer actually sees.
 */
const DRIFT: readonly (readonly [number, number])[] = [
  [0, 0],
  [7.3, 2.1],
  [13.9, 31.7],
  [41.2, 5.5],
  [2.7, 19.4],
  [23.1, 44.8],
  [37.6, 11.2],
  [9.8, 27.3],
];

export interface IdleField {
  /** Injection rate is scaled by this; `injectGain` at idle. */
  gain: number;
  /** The band energies the ambient split reads: bands 2, 4 and 6. */
  bands: [number, number, number];
  /** The per-frame decay the flow style is using. */
  decay: number;
  /** How long a frame took, in seconds. Defaults to a 60 Hz one. */
  dt?: number;
}

/**
 * The soft-knee level the ambient wash settles at, sampled over an `n × n`
 * grid of the frame, pooled over the drift. This is the *injection* equilibrium at a fixed pixel: it
 * ignores advection and the 4-tap blur, which can only pull the distribution
 * toward its own mean, and it ignores the beat lobes, which are what supply
 * the highlights.
 */
export function idleAmbientLevels(
  f: IdleField,
  n = 96,
  o: { vein?: boolean } = {},
): number[] {
  const vein = o.vein !== false;
  const out: number[] = [];
  for (const [ox, oy] of DRIFT) for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      // vUv * 3.0, at eight positions of the drifting pattern.
      const u = ox + ((ix + 0.5) / n) * 3;
      const v = oy + ((iy + 0.5) / n) * 3;
      const q = fbm(u, v);
      const gate = vein ? smoothstep(VEIN_LO, VEIN_HI, q) : 1;
      const amb = (0.5 + 0.5 * q) * gate * f.gain;

      // Exactly what the pair does on a frame: the CPU works out how much a
      // frame loses at this decay and this dt, the shader adds that much, and
      // the loop settles wherever those two agree.
      const dt = f.dt ?? 1 / 60;
      const add = ambientInjectPerFrame(AMBIENT_LEVEL, f.decay, dt);
      const rate = (share: number): number => (amb * share * add) / dt;
      const r = inkEquilibriumDensity(rate(0.6 + 0.4 * f.bands[0]), f.decay, dt);
      const g = inkEquilibriumDensity(rate(0.5 * (0.3 + f.bands[1])), f.decay, dt);
      const b = inkEquilibriumDensity(rate(0.3 * (0.3 + f.bands[2])), f.decay, dt);

      out.push(inkLevel(0.6 * r + 0.3 * g + 0.1 * b, KNEE));
    }
  }
  return out;
}

export function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** The `p`-quantile, nearest rank. */
export function quantile(xs: readonly number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[at]!;
}

/**
 * `common.glsl`'s noise, in TypeScript, and the idle smoke field it produces.
 *
 * The ambient wash is a *spatial* pattern — smoke pools in veins with dark
 * channels between them, and since v2 it is gated down inside the card's own
 * square — so "how bright is the field" is a question about a distribution,
 * not about a number, and it cannot be answered without the noise that shapes
 * it. This is a faithful port of `hash12`, `vnoise`, `rot2` and `fbm`.
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

import smokeColorFrag from '../../src/visuals/shaders/smoke_color.frag.glsl?raw';
import smokeInjectFrag from '../../src/visuals/shaders/smoke_inject.frag.glsl?raw';
import {
  AMBIENT_LEVEL,
  ambientInjectPerFrame,
  inkEquilibriumDensity,
  smokeLevel,
} from '../../src/visuals/inkMath';
import { annulusFor, type Annulus } from '../../src/visuals/smokeMath';

/** A `const float NAME = value;` out of a shader source. */
export function shaderConst(source: string, name: string): number {
  const m = new RegExp(`const\\s+float\\s+${name}\\s*=\\s*(-?[0-9.]+)\\s*;`).exec(source);
  if (!m) throw new Error(`smokeField: no const float ${name} in the shader`);
  return Number(m[1]);
}

export const INJECT_RATE = shaderConst(smokeInjectFrag, 'INJECT_RATE');
export const VEIN_LO = shaderConst(smokeInjectFrag, 'VEIN_LO');
export const VEIN_FLOOR = shaderConst(smokeInjectFrag, 'VEIN_FLOOR');
export const VEIN_HI = shaderConst(smokeInjectFrag, 'VEIN_HI');
export const CARD_FLOOR = shaderConst(smokeInjectFrag, 'CARD_FLOOR');
export const CARD_FADE_IN = shaderConst(smokeInjectFrag, 'CARD_FADE_IN');
export const AMBIENT_GAIN = shaderConst(smokeInjectFrag, 'AMBIENT_GAIN');
export const STRIATE_MEAN = shaderConst(smokeInjectFrag, 'STRIATE_MEAN');
export const STRIATE_AMP = shaderConst(smokeInjectFrag, 'STRIATE_AMP');
export const KNEE = shaderConst(smokeColorFrag, 'KNEE');
export const FALLOFF = shaderConst(smokeColorFrag, 'FALLOFF');

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

/** A 1440×900 window, which is what every measurement in this repo is taken at. */
export const REFERENCE_VW = 1440;
export const REFERENCE_VH = 900;
/** The annulus a page with no card draws around: `min(30vw, 440px)`, centred. */
export const REFERENCE_ANNULUS: Annulus = annulusFor(null, REFERENCE_VW, REFERENCE_VH);

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

export interface FieldOptions {
  /** Drop the vein gate, to show what a flat wash would look like. */
  vein?: boolean;
  /** Drop the card's shadow, to show what the annulus gate is worth. */
  card?: boolean;
  /** Where the card is. Defaults to the virtual square of a 1440×900 page. */
  annulus?: Annulus;
  aspect?: number;
  /** Only sample inside the card's own square, or only outside the annulus. */
  region?: 'all' | 'inside' | 'outside';
  /** Stand in for `ambientInjectPerFrame`, so a tuning sweep can move the level. */
  ambient?: (level: number, decay: number, dt: number) => number;
}

/**
 * How much of the ambient wash survives at `dist` from the card centre.
 *
 * The gate `smoke_inject.frag` applies: nothing like a hole — a hard edge is
 * exactly what the card is designed not to have — but a pool of darkness under
 * the picture that the smoke rolls out of. Distances are in the shader's
 * aspect-corrected space.
 */
export function cardGate(dist: number, a: Annulus): number {
  return CARD_FLOOR + (1 - CARD_FLOOR) * smoothstep(a.inner * CARD_FADE_IN, a.outer, dist);
}

/**
 * The soft-knee level the ambient wash settles at, sampled over an `n × n`
 * grid of the frame, pooled over the drift.
 *
 * This is the *injection* equilibrium at a fixed pixel: it ignores advection
 * and the anisotropic blur, which can only pull the distribution toward its
 * own mean, and it ignores the lobes and filaments, which are what supply the
 * highlights.
 *
 * Three factors that were not here in v1, each of them a line of the v2
 * direction: the wash runs at half the level it did (`AMBIENT_LEVEL`), it is
 * gated down inside the card (`cardGate`), and everything injected is combed
 * by the striation sinusoid, whose phase across a frame is effectively
 * uniform — so it is modelled with a hashed phase per sample rather than by
 * evaluating a 380-radian sinusoid on a 64-point grid, which would alias into
 * a moiré of its own.
 */
export function idleAmbientLevels(f: IdleField, n = 96, o: FieldOptions = {}): number[] {
  const vein = o.vein !== false;
  const carded = o.card !== false;
  const annulus = o.annulus ?? REFERENCE_ANNULUS;
  const aspect = o.aspect ?? REFERENCE_VW / REFERENCE_VH;
  const region = o.region ?? 'all';
  const out: number[] = [];
  for (const [ox, oy] of DRIFT) {
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const ux = (ix + 0.5) / n;
        const uy = (iy + 0.5) / n;
        // The shader's aspect-corrected space, and where the card is in it.
        const px = (ux - 0.5) * aspect - (annulus.cx - 0.5) * aspect;
        const py = uy - 0.5 - (annulus.cy - 0.5);
        const dist = Math.hypot(px, py);
        // "Inside" is the card's own square, "outside" is past the annulus.
        const half = annulus.inner / Math.SQRT2;
        if (region === 'inside' && (Math.abs(px) > half || Math.abs(py) > half)) continue;
        if (region === 'outside' && dist < annulus.outer) continue;

        // vUv * 3.0, at eight positions of the drifting pattern.
        const u = ox + ux * 3;
        const v = oy + uy * 3;
        const q = fbm(u, v);
        // The gate never quite closes: the gaps keep `VEIN_FLOOR` of the wash,
        // which is what stops the field converging onto the veins alone.
        const gate = vein ? Math.max(smoothstep(VEIN_LO, VEIN_HI, q), VEIN_FLOOR) : 1;
        const shadow = carded ? cardGate(dist, annulus) : 1;
        const comb = STRIATE_MEAN + STRIATE_AMP * Math.sin(hash12(ix * 7 + 1, iy * 13 + 1) * 6.2832);
        const ambGain = 1 + (f.gain - 1) * AMBIENT_GAIN;
        const amb = (0.5 + 0.5 * q) * gate * ambGain * shadow * comb;

        // Exactly what the pair does on a frame: the CPU works out how much a
        // frame loses at this decay and this dt, the shader adds that much, and
        // the loop settles wherever those two agree.
        const dt = f.dt ?? 1 / 60;
        const add = (o.ambient ?? ambientInjectPerFrame)(AMBIENT_LEVEL, f.decay, dt);
        const rate = (share: number): number => (amb * share * add) / dt;
        const r = inkEquilibriumDensity(rate(0.6 + 0.4 * f.bands[0]), f.decay, dt);
        const g = inkEquilibriumDensity(rate(0.5 * (0.3 + f.bands[1])), f.decay, dt);
        const b = inkEquilibriumDensity(rate(0.3 * (0.3 + f.bands[2])), f.decay, dt);

        out.push(smokeLevel(0.6 * r + 0.3 * g + 0.1 * b, KNEE, FALLOFF));
      }
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

/**
 * Oklch → sRGB, the one color conversion the visuals need.
 *
 * The palette is written in Oklch because that is the only way the brief's
 * rules mean anything: "five stops at L = 0.08 … 0.9" is a promise about
 * *perceived* lightness, and "rotate the hue across the stops by ±40°" is a
 * promise that only the hue moves. In sRGB neither is true — the same nominal
 * lightness reads very differently at blue and at yellow, and rotating a hue
 * drags the brightness with it, which would show up on screen as the stops
 * bunching up and the gradient banding.
 *
 * Out-of-gamut requests are resolved by *reducing chroma* rather than clamping
 * channels. Clamping a channel changes the hue — an over-saturated blue clamps
 * into a washed-out magenta — whereas pulling chroma in keeps the hue and the
 * lightness and only gives up the saturation sRGB cannot show. That matters
 * most exactly where the director pushes hardest (high valence, neon genres).
 *
 * Pure: no three.js, no DOM. Vitest runs it in Node.
 */

/** How far outside 0..1 a linear channel may sit and still count as inside. */
const GAMUT_EPS = 1e-4;
/** Bisection steps when pulling chroma back into gamut; 2^-16 is plenty. */
const CLIP_STEPS = 16;

/** Oklab → linear sRGB, as a triple of linear-light channels (may be < 0 or > 1). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  return (
    r >= -GAMUT_EPS && r <= 1 + GAMUT_EPS && g >= -GAMUT_EPS && g <= 1 + GAMUT_EPS && b >= -GAMUT_EPS && b <= 1 + GAMUT_EPS
  );
}

/** The sRGB transfer function, linear-light → encoded 0..1. */
function encode(x: number): number {
  const v = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * `L` 0..1 perceived lightness, `C` chroma (0 is gray, ~0.37 is the most sRGB
 * can ever show), `hDeg` hue in degrees. Returns encoded sRGB, every channel
 * inside 0..1.
 */
export function oklchToRgb(L: number, C: number, hDeg: number): [number, number, number] {
  const lightness = Math.max(0, Math.min(1, L));
  const h = (hDeg * Math.PI) / 180;
  const ca = Math.cos(h);
  const sa = Math.sin(h);

  let lo = 0;
  let hi = Math.max(0, C);
  // Gray is always in gamut, so the answer is somewhere in [0, C]: bisect for
  // the largest chroma that still fits, then encode that.
  if (!inGamut(oklabToLinear(lightness, hi * ca, hi * sa))) {
    for (let i = 0; i < CLIP_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(lightness, mid * ca, mid * sa))) lo = mid;
      else hi = mid;
    }
  } else {
    lo = hi;
  }

  const linear = oklabToLinear(lightness, lo * ca, lo * sa);
  return [encode(linear[0]), encode(linear[1]), encode(linear[2])];
}

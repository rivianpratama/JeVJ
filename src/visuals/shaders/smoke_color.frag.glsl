// Stage 3 of the smoke: densities → color.
//
// The simulation is colorless — three scalar fields. All the color in the
// frame comes from here, and it can only come from the five-stop palette the
// director built, sampled piecewise-linearly. That is the guarantee against
// ever looking flat or primary: no color exists in the frame that is not
// somewhere on the mood's own ramp.
//
// The v2 falloff is the reference image's, and it is three things:
//
//  - a **softer knee**, `1 − e^(−2·d)` rather than 2.4, so the ramp is spent
//    further up the density range and the tails of a sheet stay translucent
//    instead of reaching the light stops a third of the way out;
//  - a **gamma of 1.35** on top of it, which is what actually produces "bright
//    soft cores fading long into black". A linear ramp puts most of a sheet in
//    the mid greys; the power pushes the mids down and leaves the cores where
//    they were, so the falloff is long and the highlights are local;
//  - **volumetric shading.** The density field has a gradient, and a fold is
//    where that gradient turns. Lighting it — `0.85 + 0.3·dot(n̂, lightDir)`
//    with the light rotating with `uSpin` — is what makes an overlapping sheet
//    read as one sheet in front of another rather than as a brighter patch.
//
// `exposure` is applied here rather than at the end of the chain, so that a
// splash lifts the smoke *through* the bloom threshold instead of brightening
// an already-bloomed image. It is still a multiply before tone mapping, which
// happens in the OutputPass at the very end.

varying vec2 vUv;

uniform sampler2D uSmoke;
uniform vec3 uStops[5];
uniform vec3 uBg;
uniform vec3 uAccent;
uniform float uExposure;
uniform float uSpin;
uniform vec2 uTexel;

/** How hard the soft knee bends. Higher reaches the light stops sooner. */
const float KNEE = 2.0;
/** The gamma on the level: deeper mids, longer falloff, local highlights. */
const float FALLOFF = 1.35;
/** Where the highlight blend starts, and how far past stop 4 it reaches. */
const float HIGHLIGHT = 0.85;
const float HIGHLIGHT_GAIN = 1.25;
/** How much brushed detail is modulated onto the level. */
const float TEXTURE_AMT = 0.18;
const float TEXTURE_SCALE = 14.0;
/**
 * The standing exposure, before the director's.
 *
 * v2 raised it from 1.25, and it is the *print* rather than the picture: the
 * soft-knee level above is what the idle measurements in
 * tests/visuals/inkMath.test.ts are taken on, and this is what that level is
 * printed at. It went up because the level went down — the 1.35 falloff, the
 * card's shadow and the striation comb between them take about half the light
 * out of the wash — and because the smoke is only about two fifths of the
 * finished mix at idle, the rest being silk and dust. Solved against the
 * finished canvas at 1440×900, DPR 1.5, after 20 s of the idle loop.
 */
const float BASE_EXPOSURE = 2.05;
/** The volumetric term: how dark a face turned away goes, and how far a lit one lifts. */
const float SHADE_BASE = 0.85;
const float SHADE_GAIN = 0.3;
/**
 * How steep a density gradient counts as a fully-formed surface.
 *
 * The direction has the shading term read `dot(gradient(d), lightDir)`, and a
 * raw gradient in texel units is unbounded — at the edge of a filament it is
 * hundreds, and the term would swing the level through zero and out the other
 * side. So the gradient is normalised and the *strength* of the shading is
 * ramped in by the gradient's own magnitude: flat smoke is unshaded, a fold is
 * fully lit, and nothing anywhere can multiply the level by a negative number.
 */
const float SHADE_EDGE = 0.6;

/** The 5-stop ramp, piecewise linear in t ∈ 0..1. */
vec3 rampAt(float t) {
  float x = clamp(t, 0.0, 1.0) * 4.0;
  vec3 c = uStops[0];
  c = mix(c, uStops[1], clamp(x, 0.0, 1.0));
  c = mix(c, uStops[2], clamp(x - 1.0, 0.0, 1.0));
  c = mix(c, uStops[3], clamp(x - 2.0, 0.0, 1.0));
  c = mix(c, uStops[4], clamp(x - 3.0, 0.0, 1.0));
  return c;
}

/** The weighted density this pixel reads as. */
float densityAt(vec2 uv) {
  vec3 d = texture2D(uSmoke, uv).rgb;
  return d.r * 0.6 + d.g * 0.3 + d.b * 0.1;
}

void main() {
  vec3 density = texture2D(uSmoke, vUv).rgb;

  // Smoke A carries the picture, B the mid tones, C the highlights.
  float d = density.r * 0.6 + density.g * 0.3 + density.b * 0.1;
  float level = 1.0 - exp(-KNEE * max(d, 0.0));
  level = pow(max(level, 0.0), FALLOFF);

  // Volumetric shading. The gradient by central differences over a two-texel
  // span — one texel is inside the anisotropic blur's own reach and reads as
  // noise rather than as a surface — lit by a direction that turns with the
  // field, so a fold catches the light as it comes round.
  vec2 g = vec2(
    densityAt(vUv + vec2(uTexel.x, 0.0)) - densityAt(vUv - vec2(uTexel.x, 0.0)),
    densityAt(vUv + vec2(0.0, uTexel.y)) - densityAt(vUv - vec2(0.0, uTexel.y)));
  float slope = length(g);
  vec2 n = slope > 1.0e-6 ? g / slope : vec2(0.0);
  vec2 lightDir = vec2(cos(uSpin), sin(uSpin));
  level *= SHADE_BASE + SHADE_GAIN * dot(n, lightDir) * smoothstep(0.0, SHADE_EDGE, slope);

  // Brushed detail: a fine fbm on the *level*, warped by the densities
  // themselves, so the texture follows the smoke instead of sitting over it as
  // a fixed screen-space pattern.
  level *= 1.0 + TEXTURE_AMT * (fbm(vUv * TEXTURE_SCALE + density.rg * 1.5) - 0.5);
  level = clamp(level, 0.0, 1.0);

  vec3 col = rampAt(level);
  // Past the top of the ramp, push beyond stop 4 so the highlights have
  // somewhere to go and the bloom has something to catch.
  col = mix(col, uStops[4] * HIGHLIGHT_GAIN, smoothstep(HIGHLIGHT, 1.0, level));

  // Where the third smoke dominates, pull the color toward the accent — the
  // complementary streaks that keep a one-hue ramp from reading as monochrome.
  float thirdInk = clamp(density.b - max(density.r, density.g), 0.0, 1.0);
  col *= mix(vec3(1.0), mix(uAccent, vec3(1.0), 0.7), thirdInk);

  // Below 0.02 there is no smoke: that is background. Faded in over a small
  // range rather than cut, so the empty field has no visible edge.
  float presence = max(density.r, max(density.g, density.b));
  col = mix(uBg, col, smoothstep(0.0, 0.02, presence));

  gl_FragColor = vec4(col * uExposure * BASE_EXPOSURE, 1.0);
}

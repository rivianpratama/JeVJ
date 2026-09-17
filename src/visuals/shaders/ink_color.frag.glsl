// Stage 3 of the ink: densities → color.
//
// The ink simulation is colorless — three scalar fields. All the color in the
// frame comes from here, and it can only come from the five-stop palette the
// director built, sampled piecewise-linearly. That is the guarantee against
// ever looking flat or primary: no color exists in the frame that is not
// somewhere on the mood's own ramp.
//
// The densities are mapped onto the ramp through a soft knee — `1 − e^−kd`
// rather than a clamp — because a clamp makes every choice at once: it wastes
// the whole top of the ramp on densities that never occur, and then clips the
// ones that do. The knee spends the ramp where the ink actually is, which is
// what makes the light stops appear at all.
//
// `exposure` is applied here rather than at the end of the chain, so that a
// splash lifts the ink *through* the bloom threshold instead of brightening an
// already-bloomed image. It is still a multiply before tone mapping, which
// happens in the OutputPass at the very end. A baseline sits under it: the
// picture is meant to be *exposed*, and a chain tuned so that only a splash
// reaches the mid stops is a chain that shows the background all night.

varying vec2 vUv;

uniform sampler2D uInk;
uniform vec3 uStops[5];
uniform vec3 uBg;
uniform vec3 uAccent;
uniform float uExposure;

/** How hard the soft knee bends. Higher reaches the light stops sooner. */
const float KNEE = 2.4;
/** Where the highlight blend starts, and how far past stop 4 it reaches. */
const float HIGHLIGHT = 0.85;
const float HIGHLIGHT_GAIN = 1.2;
/** How much brushed-paint detail is modulated onto the level. */
const float TEXTURE_AMT = 0.18;
const float TEXTURE_SCALE = 14.0;
/** The standing exposure, before the director's. */
const float BASE_EXPOSURE = 1.25;

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

void main() {
  vec3 density = texture2D(uInk, vUv).rgb;

  // Ink A carries the picture, B the mid tones, C the highlights.
  float d = density.r * 0.6 + density.g * 0.3 + density.b * 0.1;
  float level = 1.0 - exp(-KNEE * max(d, 0.0));

  // Brushed paint: a fine fbm on the *level*, warped by the densities
  // themselves, so the texture follows the ink instead of sitting over it as
  // a fixed screen-space pattern.
  level *= 1.0 + TEXTURE_AMT * (fbm(vUv * TEXTURE_SCALE + density.rg * 1.5) - 0.5);
  level = clamp(level, 0.0, 1.0);

  vec3 col = rampAt(level);
  // Past the top of the ramp, push beyond stop 4 so the highlights have
  // somewhere to go and the bloom has something to catch.
  col = mix(col, uStops[4] * HIGHLIGHT_GAIN, smoothstep(HIGHLIGHT, 1.0, level));

  // Where the third ink dominates, pull the color toward the accent — the
  // complementary streaks that keep a one-hue ramp from reading as monochrome.
  float thirdInk = clamp(density.b - max(density.r, density.g), 0.0, 1.0);
  col *= mix(vec3(1.0), mix(uAccent, vec3(1.0), 0.7), thirdInk);

  // Below 0.02 there is no ink: that is background. Faded in over a small
  // range rather than cut, so the empty field has no visible edge.
  float presence = max(density.r, max(density.g, density.b));
  col = mix(uBg, col, smoothstep(0.0, 0.02, presence));

  gl_FragColor = vec4(col * uExposure * BASE_EXPOSURE, 1.0);
}

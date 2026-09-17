// Stage 3 of the ink: densities → color.
//
// The ink simulation is colorless — three scalar fields. All the color in the
// frame comes from here, and it can only come from the five-stop palette the
// director built, sampled piecewise-linearly. That is the guarantee against
// ever looking flat or primary: no color exists in the frame that is not
// somewhere on the mood's own ramp.
//
// `exposure` is applied here rather than at the end of the chain, so that a
// splash lifts the ink *through* the bloom threshold instead of brightening an
// already-bloomed image. It is still a multiply before tone mapping, which
// happens in the OutputPass at the very end.

varying vec2 vUv;

uniform sampler2D uInk;
uniform vec3 uStops[5];
uniform vec3 uBg;
uniform vec3 uAccent;
uniform float uExposure;

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
  float level = clamp(density.r * 0.6 + density.g * 0.3 + density.b * 0.1, 0.0, 1.0);
  vec3 col = rampAt(level);

  // Where the third ink dominates, pull the color toward the accent — the
  // complementary streaks that keep a one-hue ramp from reading as monochrome.
  float thirdInk = clamp(density.b - max(density.r, density.g), 0.0, 1.0);
  col *= mix(vec3(1.0), mix(uAccent, vec3(1.0), 0.7), thirdInk);

  // Below 0.02 there is no ink: that is background. Faded in over a small
  // range rather than cut, so the empty field has no visible edge.
  float presence = max(density.r, max(density.g, density.b));
  col = mix(uBg, col, smoothstep(0.0, 0.02, presence));

  gl_FragColor = vec4(col * uExposure, 1.0);
}

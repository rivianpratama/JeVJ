// A grain of dust: a soft round sprite, coloured off the mood's own ramp.
//
// There is no texture and no sprite sheet — a point sprite with a smoothstep
// falloff is rounder than any 8×8 texture would be at this size, and it costs
// one length() instead of a fetch. Additive blending does the rest: where the
// dust is dense it goes white-hot and the bloom catches it, which is what makes
// a gathering shell read as light rather than as a lot of dots.

varying float vSpeed;
varying float vSeed;

uniform vec3 uStops[5];
uniform vec3 uAccent;
uniform float uExposure;
uniform float uGain;

/** Above this fraction of the seed space a grain takes the accent: 12%. */
const float ACCENT_CUT = 0.88;
/** How far an accented grain goes toward the complementary colour. */
const float ACCENT_MIX = 0.85;
/** How far up the palette the slowest grain sits. */
const float RAMP_FLOOR = 0.3;
/** The dust's standing exposure, matching the ink's. */
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
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.0, d);
  if (a <= 0.0) discard;

  // The ramp is sampled from a third of the way up: the two darkest stops are
  // the *background's* colours, and dust painted in them is dust nobody sees —
  // it only drags the cloud's average toward black and lets the 12% accent
  // grains dominate the hue. Fast is still light, which is the point.
  vec3 col = rampAt(RAMP_FLOOR + (1.0 - RAMP_FLOOR) * vSpeed);
  col = mix(col, uAccent, step(ACCENT_CUT, vSeed) * ACCENT_MIX);

  // `uGain` is what makes a grain a *grain*: a quarter of a million sprites
  // added together blow out to white at any sane per-sprite brightness, so each
  // one contributes a few percent and the picture is made of where they pile
  // up. It also carries the point-count normalisation, so the two simulation
  // tiers put out the same amount of light.
  gl_FragColor = vec4(col * uExposure * BASE_EXPOSURE, a * uGain);
}

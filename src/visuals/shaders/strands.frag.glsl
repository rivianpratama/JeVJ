// The silk's colour: three stops, an accent every ninth strand, a hot core and
// ends that fade out.
//
// Two things keep four hundred additive ribbons from becoming a pale rain.
//
// **Sparsity follows the mix.** Every strand holds a hash; only the strands
// whose hash falls under the layer's own weight are drawn at all. At the idle
// weight that is a scattering of ribbons over a dark field, and the full
// curtain only assembles when the director actually hands the frame to this
// layer. Fading them in over a window rather than cutting means a strand
// arrives and leaves instead of popping.
//
// **A ribbon is a core, not a band.** `(1 − |u|)^2.2` across the width puts
// almost all of a strand's light down its centreline and lets its edges vanish,
// so crossing ribbons read as threads over black rather than as a wash. A flat
// profile at the same total emission is the "uniform pale rain" this replaced.

varying float vT;
varying float vId;
varying float vHash;
varying float vU;

uniform vec3 uStops[5];
uniform vec3 uAccent;
uniform float uDownbeat;
uniform float uExposure;
uniform float uWeight;

/** How much of each end is fade. */
const float FADE = 0.14;
/** How far a downbeat lifts the whole curtain. */
const float DOWNBEAT_LIFT = 0.3;
/** The silk's standing exposure, matching the ink's. */
const float BASE_EXPOSURE = 1.25;
/** How wide the visibility window is around the layer's weight. */
const float VIS_SOFT = 0.15;
/** How hard the light is pulled into the ribbon's centreline. */
const float CORE_POWER = 2.2;
/**
 * One ribbon's emission at full core.
 *
 * It is in the *colour* rather than in the alpha so it can exceed one without
 * depending on whether the driver clamps a blend factor on a float target, and
 * it is set by measurement rather than by eye: the strands layer alone, at
 * weight 0.25, must come in under a mean luminance of 0.03 with its brightest
 * 5% under 0.6, *and* the finished idle composite must keep its darkest fifth
 * under 0.08. The first two are met with a wide margin at any sane value; the
 * third is what actually sets this number, because the bloom spreads a
 * strand's light well past the ribbon and lifts the floor faster than it
 * lifts the mean. Measured at 0.55: layer mean 0.005, p95 0.033, cores to
 * 0.16, 21% of the frame lit; idle composite mean 0.252, p20 0.076.
 */
const float EMISSION = 0.55;

void main() {
  // Visible when the strand's hash falls under the layer's weight, so the
  // number of ribbons on screen is the weight times four hundred.
  // Written as 1 − smoothstep rather than with the edges swapped: GLSL leaves
  // smoothstep undefined when edge0 ≥ edge1, and drivers differ.
  float vis = 1.0 - smoothstep(uWeight - VIS_SOFT, uWeight + VIS_SOFT, vHash);
  if (vis <= 0.0) discard;

  float fade = smoothstep(0.0, FADE, vT) * smoothstep(1.0, 1.0 - FADE, vT);
  float core = pow(max(1.0 - abs(vU), 0.0), CORE_POWER);

  // Stops 2..4 in rotation — the mid and light end of the ramp, never the two
  // darkest, because a dark ribbon on a dark field is a hole.
  float pick = mod(vId, 3.0);
  vec3 col = pick < 0.5 ? uStops[2] : (pick < 1.5 ? uStops[3] : uStops[4]);
  if (mod(vId, 9.0) < 0.5) col = uAccent;

  col *= 1.0 + DOWNBEAT_LIFT * uDownbeat;

  gl_FragColor = vec4(col * uExposure * BASE_EXPOSURE * EMISSION, fade * vis * core);
}

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
/** 1 for the ribbon itself, 0.15 for the wide halo drawn around it. */
uniform float uAlphaScale;

/** How much of each end is fade. */
const float FADE = 0.14;
/** How far a downbeat lifts the whole curtain. */
const float DOWNBEAT_LIFT = 0.3;
/** The silk's standing exposure, matching the ink's. */
const float BASE_EXPOSURE = 1.25;
/**
 * How wide the visibility ramp is *below* the layer's weight.
 *
 * A strand is visible when its hash is under the weight, so the count on screen
 * is the weight times four hundred — and it arrives gradually over the last
 * 0.3 of the ramp rather than popping. At the idle weight of about 0.32 that is
 * roughly forty ribbons at full strength with a soft tail behind them, where the
 * previous window — centred *on* the weight rather than ending at it — lit half
 * as many again at half brightness and read as rain.
 */
const float VIS_RAMP = 0.3;
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
 * lifts the mean.
 *
 * Task 11 halved it again, and it was forced: a ribbon is now three times
 * thicker (`lerp(0.012, 0.035, sub)` rather than `lerp(0.004, 0.02, sub)`) and
 * carries a three-times-wider halo pass at 0.15 alpha on top, so the same
 * number gave each visible strand about four times the light it had before.
 * It is set to the largest value the idle floor will carry, and the floor is
 * quantised to 1/255 on the measured scale, so the search ends at a single
 * step: 0.30 reads mean 0.212 with its darkest fifth at 0.0588, and 0.32 tips
 * the floor to 0.0627 against a target of 0.06. Further up the curve, for the
 * record: 0.34 → 0.2175/0.0627, 0.42 → 0.2277/0.0706, 0.55 → 0.24/0.078.
 */
const float EMISSION = 0.30;

void main() {
  // Visible when the strand's hash falls under the layer's weight, so the
  // number of ribbons on screen is the weight times four hundred, and fully lit
  // only once the weight has risen a further 0.3 past it.
  float vis = smoothstep(0.0, VIS_RAMP, uWeight - vHash);
  if (vis <= 0.0) discard;

  float fade = smoothstep(0.0, FADE, vT) * smoothstep(1.0, 1.0 - FADE, vT);
  float core = pow(max(1.0 - abs(vU), 0.0), CORE_POWER);

  // Stops 2..4 in rotation — the mid and light end of the ramp, never the two
  // darkest, because a dark ribbon on a dark field is a hole.
  float pick = mod(vId, 3.0);
  vec3 col = pick < 0.5 ? uStops[2] : (pick < 1.5 ? uStops[3] : uStops[4]);
  if (mod(vId, 9.0) < 0.5) col = uAccent;

  col *= 1.0 + DOWNBEAT_LIFT * uDownbeat;

  gl_FragColor = vec4(col * uExposure * BASE_EXPOSURE * EMISSION, fade * vis * core * uAlphaScale);
}

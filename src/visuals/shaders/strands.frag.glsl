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
/** Where in the beat we are: what drives the pulse down the ribbon. */
uniform float uBeatPhase;
/** How hard a `vocal_entry` flourish is burning the silk, 0..1. */
uniform float uGlow;

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
 * stretch of the ramp rather than popping. At the idle weight of about 0.32
 * that is a few dozen ribbons at full strength with a soft tail behind them,
 * where a window centred *on* the weight rather than ending at it lit half as
 * many again at half brightness and read as rain.
 *
 * Widened from 0.3 to 0.45 in the real-music pass, alongside the 1.8× thicker
 * ribbons: a thicker strand carries more light, so more of them have to be
 * arriving rather than arrived for the curtain to keep its depth.
 */
const float VIS_RAMP = 0.45;
/** How hard the light is pulled into the ribbon's centreline. */
const float CORE_POWER = 2.2;
/**
 * The beat pulse: a bright band that sweeps the length of every ribbon once a
 * beat, from the top to the bottom.
 *
 * It is the one thing in this layer that is *locked* to the music rather than
 * merely lit by it, and it is what turns a curtain into an instrument: the
 * strands hang still and a wave of light runs down them on the beat. The width
 * is narrow on purpose — `exp(−d²/0.02)` is about a fifth of a ribbon — because
 * a wide pulse is just the whole curtain flashing, which the downbeat lift
 * already does.
 */
const float PULSE_GAIN = 1.5;
const float PULSE_WIDTH = 0.02;
/** How much brighter a vocal-entry flourish burns the silk. */
const float GLOW_LIFT = 0.8;
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
 * Task 11 halved it, and it was forced: a ribbon is thicker and carries a
 * three-times-wider halo pass at 0.15 alpha on top, so the same number gave
 * each visible strand about four times the light it had before. Task 12's
 * real-music pass thickened it again (×1.8) and widened the visibility window
 * to 0.45, and both put light back into the *gaps* — which is where the budget
 * is spent. Measured at 1440×900, DPR 1.5, on the settled idle composite:
 *
 *   emission   mean    darkest fifth
 *   0.05      0.1828   0.0424   (the ink bed alone: the floor without silk)
 *   0.16      0.1965   0.0586
 *   0.23      0.2062   0.0681
 *   0.30      0.2141   0.0746
 *   0.45      0.2436   0.1105
 *
 * The floor is the binding constraint at 0.06, so 0.16 is where the search
 * ends. The mean lands at 0.197 against a 0.22 target it cannot reach with a
 * visible curtain: at the emission that would buy it, a fifth of the frame is
 * a pale wash, which is the failure this whole number exists to prevent.
 */
const float EMISSION = 0.16;

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
  col *= 1.0 + GLOW_LIFT * uGlow;

  // The pulse. `vT` runs 0..1 down the ribbon and the strand spans y ∈ [−2, 2],
  // so the sweep is written in the same units the vertex shader displaces in.
  float y = mix(-2.0, 2.0, vT);
  float yPulse = mix(-2.0, 2.0, uBeatPhase);
  float d = y - yPulse;
  col *= 1.0 + PULSE_GAIN * exp(-(d * d) / PULSE_WIDTH);

  gl_FragColor = vec4(col * uExposure * BASE_EXPOSURE * EMISSION, fade * vis * core * uAlphaScale);
}

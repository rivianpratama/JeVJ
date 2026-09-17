// The silk's colour: three stops, an accent every ninth strand, and ends that
// fade out.
//
// The fade is what keeps 400 ribbons from reading as a curtain with a top and
// a bottom edge. Nothing here is lit — the strands are emissive, like
// everything else in this app, and the additive blend is what makes crossing
// ribbons brighten where they overlap.

varying float vT;
varying float vId;

uniform vec3 uStops[5];
uniform vec3 uAccent;
uniform float uDownbeat;
uniform float uExposure;

/** How much of each end is fade. */
const float FADE = 0.14;
/** How far a downbeat lifts the whole curtain. */
const float DOWNBEAT_LIFT = 0.3;
/** The silk's standing exposure, matching the ink's. */
const float BASE_EXPOSURE = 1.25;
/**
 * Each ribbon is a veil, not a solid. Four hundred of them added together at
 * any honest opacity is a white screen; at a tenth, a single ribbon is a faint
 * thread and a dozen crossing ones are a bright fold — which is what silk
 * lit from behind actually does.
 */
const float STRAND_ALPHA = 0.11;

void main() {
  float fade = smoothstep(0.0, FADE, vT) * smoothstep(1.0, 1.0 - FADE, vT);

  // Stops 2..4 in rotation — the mid and light end of the ramp, never the two
  // darkest, because a dark ribbon on a dark field is a hole.
  float pick = mod(vId, 3.0);
  vec3 col = pick < 0.5 ? uStops[2] : (pick < 1.5 ? uStops[3] : uStops[4]);
  if (mod(vId, 9.0) < 0.5) col = uAccent;

  col *= 1.0 + DOWNBEAT_LIFT * uDownbeat;

  gl_FragColor = vec4(col * uExposure * BASE_EXPOSURE, fade * STRAND_ALPHA);
}

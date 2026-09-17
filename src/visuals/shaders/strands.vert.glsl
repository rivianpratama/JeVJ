// A ribbon of silk, hanging in a current.
//
// Each instance is one strand; the base geometry is a 64-segment strip whose
// vertices carry only "how far along" (`aT`) and "which edge" (`aSide`). The
// strand's actual path is evaluated here, twice — once at this vertex and once
// a short step further along — because a ribbon needs a tangent to know which
// way is sideways, and the tangent of a curl-displaced curve cannot be
// precomputed on the CPU.
//
// The `+0.02` step is deliberately large relative to a segment: differencing
// adjacent segments would amplify the noise's own lattice into a twist that
// flickers as the field moves.
//
// Four displacements, at different scales, and all four matter:
//
//  - the curl field is sampled at 0.35 — low frequency, so one ribbon spans
//    well under a cell of it and bends as a whole instead of wobbling. Each
//    strand offsets the domain by its own phase, so neighbours lean different
//    ways and cross rather than sweeping as one sheet;
//  - a slow sine through the length puts an S in the ribbon that the curl,
//    being noise, will not reliably produce. Without it a "bend" is a lean;
//  - **a traveling wave**, `A·sin(y·kf + t·ws + phase)`, which is what makes
//    the silk *wavy* rather than merely bent. Amplitude off the low-mid band,
//    so it billows on a bassline; wavelength off tension; speed off arousal.
//    This is the one displacement with no noise in it, and that is the point:
//    a sine travels, and a curl field only drifts;
//  - **a slow horizontal drift**, wrapped into [−3, 3], signed by the strand's
//    own hash so half of them go each way. Four hundred ribbons that share one
//    current read as a flag; the drift is what shears them apart over a track.
//
// Between them there is no setting of the mood, and no strand, at which the
// displacement's time derivative is zero — see `strandOffsetX` in
// ../smokeMath.ts, which is this arithmetic in TypeScript, and the test that
// samples it.

attribute float aSide;
attribute float aT;
attribute vec3 aBase;
attribute float aId;
attribute float aHash;

uniform float uTime;
uniform float uBend;
uniform float uThickness;
/**
 * 1 for the ribbon itself, 3 for the halo pass drawn around it.
 *
 * The halo is what a bright thread over black actually looks like — the core
 * is not the whole of it, there is a soft bloom of light around every strand —
 * and it is drawn as a second, three-times-wider pass at a seventh of the alpha
 * rather than by widening the core profile, which would only make the ribbons
 * fatter.
 */
uniform float uWidthScale;
/** The traveling wave: how far, how tight, how fast. See `strandWaveFor`. */
uniform float uWaveAmp;
uniform float uWaveFreq;
uniform float uWaveSpeed;

varying float vT;
varying float vId;
varying float vHash;
varying float vU;

/** How much of the bend the curl carries, against the S-bend's 0.25. */
const float FLOW_GAIN = 1.6;
const float FLOW_SCALE = 0.35;
const float S_BEND = 0.25;
const float TWO_PI = 6.28318530718;
/** How fast the far end of the hash drifts, and how far before it wraps. */
const float DRIFT_RATE = 0.05;
const float DRIFT_WRAP = 3.0;

/** Where the ribbon's centreline is at `t ∈ 0..1`, top to bottom. */
vec3 strandAt(float t) {
  float y = mix(-2.0, 2.0, t);
  vec3 p = vec3(aBase.x, y, aBase.y);
  p += curlNoise3(p * FLOW_SCALE + uTime * 0.06 + aBase.z) * uBend * FLOW_GAIN;
  p.x += sin(y * 1.3 + aHash * TWO_PI + uTime * 0.15) * S_BEND * uBend;
  // A slow lateral sway on top of the current, out of phase per strand: the
  // curl alone moves every strand in a region together, and silk that moves
  // as one sheet reads as a flag rather than as separate threads.
  p.x += sin(uTime * 0.7 + aId + aBase.z) * 0.1;
  // The traveling wave, and the drift. `mod` in GLSL is floored, so the wrap
  // is correct for a negative drift without a branch.
  p.x += uWaveAmp * sin(y * uWaveFreq + uTime * uWaveSpeed + aBase.z);
  p.x += mod(DRIFT_RATE * uTime * (aHash - 0.5) + DRIFT_WRAP, 2.0 * DRIFT_WRAP) - DRIFT_WRAP;
  return p;
}

void main() {
  vT = aT;
  vId = aId;
  vHash = aHash;
  // ±1 at the edges, 0 down the middle once interpolated: the ribbon's own
  // across-width coordinate, which is what gives it a hot core.
  vU = aSide;

  vec3 p = strandAt(aT);
  vec3 ahead = strandAt(aT + 0.02);

  vec3 tangent = ahead - p;
  tangent = length(tangent) > 1.0e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
  // The camera does not orbit this scene, so "sideways" is the tangent crossed
  // with the view axis: the ribbon keeps its width whatever way it bends.
  vec3 right = cross(tangent, vec3(0.0, 0.0, 1.0));
  right = length(right) > 1.0e-5 ? normalize(right) : vec3(1.0, 0.0, 0.0);

  p += right * aSide * uThickness * uWidthScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}

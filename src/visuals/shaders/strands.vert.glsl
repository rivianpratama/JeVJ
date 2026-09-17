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

attribute float aSide;
attribute float aT;
attribute vec3 aBase;
attribute float aId;

uniform float uTime;
uniform float uBend;
uniform float uThickness;

varying float vT;
varying float vId;

/** Where the ribbon's centreline is at `t ∈ 0..1`, top to bottom. */
vec3 strandAt(float t) {
  vec3 p = vec3(aBase.x, mix(-2.0, 2.0, t), aBase.y);
  p += curlNoise3(p * 0.6 + uTime * 0.1) * uBend;
  // A slow lateral sway on top of the current, out of phase per strand: the
  // curl alone moves every strand in a region together, and silk that moves
  // as one sheet reads as a flag rather than as separate threads.
  p.x += sin(uTime * 0.7 + aId + aBase.z) * 0.1;
  return p;
}

void main() {
  vT = aT;
  vId = aId;

  vec3 p = strandAt(aT);
  vec3 ahead = strandAt(aT + 0.02);

  vec3 tangent = ahead - p;
  tangent = length(tangent) > 1.0e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
  // The camera does not orbit this scene, so "sideways" is the tangent crossed
  // with the view axis: the ribbon keeps its width whatever way it bends.
  vec3 right = cross(tangent, vec3(0.0, 0.0, 1.0));
  right = length(right) > 1.0e-5 ? normalize(right) : vec3(1.0, 0.0, 0.0);

  p += right * aSide * uThickness;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}

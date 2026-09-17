// The terrain's height field, and the uniforms that shape it.
//
// It is prepended to *both* of the relief shaders, which is the whole point:
// the vertex shader displaces the plane by this function and the fragment
// shader differences the same function to get a normal. Two copies that drift
// apart by a constant would light a surface that is not the one on screen —
// the classic "shading slides off the geometry" bug — so there is one copy.
//
// Two terms, and they do different jobs:
//
//  - **fbm** is the landscape. It scrolls with time rather than being
//    regenerated, so the ridges travel through the frame instead of boiling in
//    place, which is what makes it read as terrain under a moving camera
//    rather than as animated noise.
//  - **the band ridges** are the music. Bands 2–4 are the low mids through the
//    mids — where a riff lives — and each drives a sine along x at its own
//    spatial frequency, so a loud mid band puts a standing corrugation across
//    the terrain that a quiet one does not. The 0.2 drift keeps them from
//    being a fixed grating.
//
// `fbm` comes from `common.glsl`, which is prepended in front of this.

uniform float uTime;
/** How many noise cells the plane is wide; the terrain's coarseness. */
uniform float uFreq;
/** How far the fbm displaces, in world units. The director's `reliefHeight`. */
uniform float uHeight;
uniform float uBands[8];

/** How far one band's ridge displaces, at full band energy. */
const float RIDGE_GAIN = 0.15;
/** How fast the landscape travels, and how fast the ridges drift. */
const float FIELD_DRIFT = 0.03;
const float RIDGE_DRIFT = 0.2;

float reliefHeightAt(vec2 q) {
  float h = fbm(q * uFreq + uTime * FIELD_DRIFT) * uHeight;
  // Bands 2, 3 and 4 at spatial frequencies 5, 6 and 7 across the plane.
  for (int k = 2; k <= 4; k++) {
    h += uBands[k] * sin(q.x * (3.0 + float(k)) + uTime * RIDGE_DRIFT) * RIDGE_GAIN;
  }
  return h;
}

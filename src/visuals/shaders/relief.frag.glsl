// The terrain's light: one lamp, upper left, and embers in the high ground.
//
// The normal is taken here rather than passed down, by differencing the same
// height function the vertex shader displaced by, at ±one cell of the plane.
// Two reasons it is not a vertex attribute: a 512² normal buffer would have to
// be recomputed on the CPU every frame (the field scrolls), and per-vertex
// normals interpolated across a cell soften exactly the ridge lines that are
// the point of the picture. Per-pixel differencing keeps the ridges crisp at
// any distance and costs the same eight fbm evaluations the vertex shader
// already pays.
//
// `pow(NdotL, uContrast)` is what makes it charcoal rather than clay. At
// contrast 1 it is an ordinary lambert surface, mid-grey over most of its area;
// at 3 everything but the lit faces falls into the background and what is left
// is a drawing in chalk on black. Tension is what raises it, so a tense passage
// is high-contrast and a slack one is a soft grey landscape.
//
// The far fade is in the *alpha*, not in the colour. The plane is finite and a
// terrain that simply stops has a hard line across the frame; fading the colour
// to the background instead would still lay an opaque rectangle of background
// over whatever the other layers are doing back there, because this layer is
// composited alpha-over.

varying vec2 vXZ;
varying float vH;
varying float vViewDist;

uniform float uContrast;
uniform vec3 uBg;
/** The lightest stop: what a fully lit face is painted with. */
uniform vec3 uStop4;
uniform vec3 uEmber;
uniform float uAggression;
uniform float uSub;
uniform float uExposure;
/** One cell of the plane, in plane units: the finite-difference step. */
uniform float uStep;
/** Where the far fade starts and ends, in view distance. */
uniform vec2 uFade;

/** Above this height, an aggressive track glows. */
const float EMBER_FLOOR = 0.6;
const float EMBER_GAIN = 2.0;
const float EMBER_AGGRESSION = 0.5;

void main() {
  // Up and to the left, and toward the camera: a *raking* light, nine degrees
  // above the ground, which is the only kind that shows a relief at all.
  //
  // The elevation is not a free choice; it was set by measurement, and it is
  // low because this layer composites alpha-over. A lamp at 30° lights nearly
  // every up-facing part of the terrain, and a fifth of every idle frame is
  // then a pale film laid over the ink — measured, the composite's darkest
  // fifth went from 0.055 at 9° to 0.102 at 28° and 0.122 at 45°, against a
  // target of 0.06. At 9° the flats sit at the background and only the faces
  // turned toward the lamp come up, which is charcoal with a drawing in it
  // rather than a grey slab.
  vec3 light = normalize(vec3(-0.9, 0.15, 0.3));

  float e = uStep;
  float hx = reliefHeightAt(vXZ + vec2(e, 0.0)) - reliefHeightAt(vXZ - vec2(e, 0.0));
  float hz = reliefHeightAt(vXZ + vec2(0.0, e)) - reliefHeightAt(vXZ - vec2(0.0, e));
  // The surface is y = h(x, z), so its normal is (−∂h/∂x, 1, −∂h/∂z); the
  // central differences are over 2e, which is folded into the y term rather
  // than divided out of the other two.
  vec3 n = normalize(vec3(-hx, 2.0 * e, -hz));
  float ndl = max(dot(n, light), 0.0);

  vec3 col = mix(uBg, uStop4, pow(ndl, uContrast));

  // Embers: the high ground of an angry landscape is lit from inside, and the
  // sub-bass is what makes it pulse. `uEmber` and not the palette's accent —
  // the accent is the complement, so a metal palette pulled toward red has an
  // accent in the greens, and jade coals on a rust landscape read as alien
  // rather than as heat. See `Palette.ember`.
  if (vH > EMBER_FLOOR && uAggression > EMBER_AGGRESSION) {
    col += uEmber * (vH - EMBER_FLOOR) * EMBER_GAIN * (0.5 + 0.5 * uSub);
  }

  float fade = 1.0 - smoothstep(uFade.x, uFade.y, vViewDist);
  gl_FragColor = vec4(col * uExposure, fade);
}

// Kaleidoscope, in polar coordinates around the middle.
//
// Reserved for hypnotic music, where a repeating figure is the point. Folds of
// 0, or a mix of 0, is a straight pass-through — the early return matters,
// because the whole chain runs this pass on every frame whether or not it is
// wanted, and a mix of exactly zero has to be bit-identical to no pass at all.
//
// A wedge has two seams, not one: the mirror line the fold reflects about, and
// the line where one wedge meets the next. Both are creases in the gradient
// and both are the giveaway in a naive kaleidoscope. Within SEAM radians of
// either, the two reflections are averaged, which dissolves the line.
//
// And the whole fold rotates, slowly. Spokes that sit still read as static
// geometry laid over the picture; spokes that drift read as a figure the ink
// is turning inside.

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform float uFolds;
/**
 * How much of the figure is on screen, 0..1.
 *
 * A fold count is an integer and cannot be crossfaded, so this is what the
 * director moves: the kaleidoscope dissolves into the straight image rather
 * than being switched off, and the count only ever changes while this is
 * near zero. It is also the lever reduced motion and the speech clamp pull,
 * for the same reason — a figure that vanishes between two frames is a cut.
 */
uniform float uMix;
uniform float uAspect;
uniform float uTime;

const float SEAM = 0.06;
/** Radians a second the fold axis turns. */
const float SPIN = 0.02;

vec3 sampleAt(float angle, float radius) {
  vec2 p = vec2(cos(angle), sin(angle)) * radius;
  return texture2D(tDiffuse, clamp(p / vec2(uAspect, 1.0) + 0.5, 0.0, 1.0)).rgb;
}

void main() {
  vec3 src = texture2D(tDiffuse, vUv).rgb;
  if (uFolds < 0.5 || uMix <= 0.0) {
    gl_FragColor = vec4(src, 1.0);
    return;
  }

  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float radius = length(p);
  float angle = atan(p.y, p.x) + uTime * SPIN;

  float seg = TAU / uFolds;
  float within = mod(angle, seg);
  float folded = min(within, seg - within); // reflect into the first half-wedge

  vec3 near = sampleAt(folded, radius);
  vec3 far = sampleAt(-folded, radius);
  // Distance to the nearer of the wedge's two seams: 0 at the mirror line,
  // 0 again where this wedge meets the next.
  float toSeam = min(folded, 0.5 * seg - folded);
  float blend = smoothstep(0.0, SEAM, toSeam);

  vec3 figure = mix(mix(near, far, 0.5), near, blend);
  gl_FragColor = vec4(mix(src, figure, uMix), 1.0);
}

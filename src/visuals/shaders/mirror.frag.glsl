// Kaleidoscope, in polar coordinates around the middle.
//
// Reserved for hypnotic music, where a repeating figure is the point. Folds of
// 0 is a straight pass-through — the early return matters, because the whole
// chain runs this pass on every frame whether or not it is wanted.
//
// The seam is the giveaway in a naive kaleidoscope: a hard mirror line where
// the two halves of a wedge meet. Within 0.02 rad of it the two reflections
// are averaged, which dissolves the line into a soft crease.

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform float uFolds;
uniform float uAspect;

const float SEAM = 0.02;

vec3 sampleAt(float angle, float radius) {
  vec2 p = vec2(cos(angle), sin(angle)) * radius;
  return texture2D(tDiffuse, clamp(p / vec2(uAspect, 1.0) + 0.5, 0.0, 1.0)).rgb;
}

void main() {
  if (uFolds < 0.5) {
    gl_FragColor = texture2D(tDiffuse, vUv);
    return;
  }

  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float radius = length(p);
  float angle = atan(p.y, p.x);

  float seg = TAU / uFolds;
  float within = mod(angle, seg);
  float folded = min(within, seg - within); // reflect into the first half-wedge

  vec3 near = sampleAt(folded, radius);
  vec3 far = sampleAt(-folded, radius);
  float blend = smoothstep(0.0, SEAM, folded);

  gl_FragColor = vec4(mix(mix(near, far, 0.5), near, blend), 1.0);
}

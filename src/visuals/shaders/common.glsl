// Shared GLSL, concatenated in front of every fragment shader in the app.
//
// Everything here is cheap and deterministic: a hash, value noise built on it,
// a four-octave fbm, the curl of that fbm by central differences, and the two
// rotations (2D, and hue) the passes need. The ink is *made* of these — there
// is no texture and no geometry anywhere in the visuals, so the character of
// the picture is entirely the character of this noise.

#define TAU 6.28318530718

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** Value noise with a smoothstep interpolant: soft, cheap, no lattice sparkle. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Four octaves, each rotated so the lattices never line up into a grid. */
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise(p);
    p = rot2(0.5) * p * 2.02;
    amp *= 0.5;
  }
  return sum;
}

/** One domain warp of the fbm: this is what turns bands into marbling. */
float warpedFbm(vec2 p) {
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
  return fbm(p + 0.6 * q);
}

/**
 * Curl of a scalar field, by central differences: the gradient turned 90°.
 * Divergence-free by construction, which is why the ink swirls and folds
 * instead of piling up or draining away.
 */
vec2 curlWarped(vec2 p) {
  const float e = 0.002;
  float dx = warpedFbm(p + vec2(e, 0.0)) - warpedFbm(p - vec2(e, 0.0));
  float dy = warpedFbm(p + vec2(0.0, e)) - warpedFbm(p - vec2(0.0, e));
  vec2 g = vec2(dx, dy) / (2.0 * e);
  return vec2(g.y, -g.x);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

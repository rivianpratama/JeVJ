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
 * The two-level domain warp (iq's), and its curl.
 *
 * One warp folds bands into marbling; two folds the marbling into itself, and
 * that is the difference between a field with structure at one scale and one
 * with structure at every scale — sheets inside sheets, which is what paint
 * under glass actually looks like. The second level also carries its own slow
 * time offsets, so the *shape* of the flow drifts rather than the picture
 * merely sliding along a fixed field.
 *
 * `curlWarp2` differences only the outer fbm, holding the warp vector `r`
 * fixed at `p`. Differencing the whole construction would cost twenty fbm
 * evaluations per pixel instead of eight; `r` varies over a scale thousands of
 * times larger than the 0.002 offset, so the two agree to well under the
 * noise's own precision and the field stays divergence-free where it matters.
 */
vec2 warp2Vector(vec2 p, float time) {
  vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
  return vec2(
    fbm(p + 4.0 * q + vec2(1.7, 9.2) + 0.15 * time),
    fbm(p + 4.0 * q + vec2(8.3, 2.8) + 0.126 * time));
}

vec2 curlWarp2(vec2 p, float warp, float time) {
  const float e = 0.002;
  vec2 r = warp2Vector(p, time);
  vec2 o = warp * r;
  float dx = fbm(p + vec2(e, 0.0) + o) - fbm(p - vec2(e, 0.0) + o);
  float dy = fbm(p + vec2(0.0, e) + o) - fbm(p - vec2(0.0, e) + o);
  vec2 g = vec2(dx, dy) / (2.0 * e);
  return vec2(g.y, -g.x);
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

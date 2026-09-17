// Three-dimensional noise, for the two scenes that live in a volume.
//
// `common.glsl` is flat: the ink is a 2D field and everything in it is 2D
// value noise. The particles and the strands are not — the dust has to swirl
// *around* a shell and the silk has to bend *through* a current, and a 2D curl
// applied to a 3D position produces sheets that all lie in the same plane,
// which reads immediately as a flat pattern pretending to have depth.
//
// This file is deliberately independent of `common.glsl` (no shared
// identifiers) because it is also prepended to *vertex* shaders, which never
// get the common header. Prepending both would redefine nothing today but
// would be a collision waiting to happen.

/** One float of hash from three. Cheap, and stable across drivers. */
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

/** Three floats of hash from three: a random direction, before normalising. */
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

/** Trilinear value noise in 0..1, smoothstep-interpolated. */
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/**
 * A vector potential: three independent noise fields, offset far enough apart
 * that their lattices share no corners.
 */
vec3 potential3(vec3 p) {
  return vec3(
    vnoise3(p),
    vnoise3(p + vec3(19.1, 33.4, 47.2)),
    vnoise3(p + vec3(74.2, 124.6, 99.4)));
}

/**
 * The curl of that potential, by central differences.
 *
 * Divergence-free by construction, which is the whole point: a plain noise
 * field used as a velocity has sources and sinks, so dust in it piles up into
 * clumps and drains out of holes within a couple of seconds. Curl noise has
 * neither, so the dust keeps moving and the density stays even.
 *
 * `e` is large (0.12) on purpose. A small epsilon differences the *lattice*
 * rather than the field and the result sparkles per-particle; at this scale the
 * gradient is read over an appreciable fraction of a noise cell and comes back
 * smooth.
 *
 * The 0.5 at the end is a normalisation, not a taste: the raw central
 * difference of a 0..1 potential over 2e comes out around magnitude 2, and
 * halving it puts the field near unit length so that `uCurl` and `uBend` are
 * strengths in world units — a bend of 0.4 displaces a strand by about 0.4.
 */
vec3 curlNoise3(vec3 p) {
  const float e = 0.12;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);

  vec3 px1 = potential3(p + dx);
  vec3 px0 = potential3(p - dx);
  vec3 py1 = potential3(p + dy);
  vec3 py0 = potential3(p - dy);
  vec3 pz1 = potential3(p + dz);
  vec3 pz0 = potential3(p - dz);

  float x = (py1.z - py0.z) - (pz1.y - pz0.y);
  float y = (pz1.x - pz0.x) - (px1.z - px0.z);
  float z = (px1.y - px0.y) - (py1.x - py0.x);
  return vec3(x, y, z) * (0.5 / (2.0 * e));
}

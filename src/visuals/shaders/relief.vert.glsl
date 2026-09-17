// The terrain, displaced.
//
// The plane is 512 × 512 vertices lying in XZ (the geometry is rotated once at
// build time, so "up" is +Y in object space and the displacement is a single
// add). Everything about the surface's *shape* happens here; everything about
// its light happens in the fragment shader, which re-evaluates the same height
// function to get a normal rather than being handed one — a 512² normal
// attribute recomputed on the CPU every frame is exactly the per-frame work
// this app does not do.
//
// `vXZ` is the *undisplaced* plane coordinate, which is what the height
// function takes, so the fragment shader can difference it without having to
// undo the displacement.

varying vec2 vXZ;
varying float vH;
/** Distance from the camera, for the far fade. */
varying float vViewDist;

void main() {
  vec3 p = position;
  vXZ = p.xz;
  vH = reliefHeightAt(vXZ);
  p.y += vH;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}

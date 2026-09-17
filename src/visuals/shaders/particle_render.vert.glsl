// One point per texel of the simulation.
//
// The geometry carries no real positions — `aRef` is where in the simulation
// textures this point lives, and everything else is read from there. The
// `position` attribute exists only because three.js needs one; it is zero.

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uPointSize;
uniform float uSpeedRef;

attribute vec2 aRef;

varying float vSpeed;
varying float vSeed;

void main() {
  vec4 p = texture2D(uPos, aRef);
  vec3 vel = texture2D(uVel, aRef).xyz;

  // Normalised speed is the only thing the colour is chosen by: fast dust is
  // light, slow dust is dark, so the picture reads as motion rather than as
  // position.
  vSpeed = clamp(length(vel) / uSpeedRef, 0.0, 1.0);
  vSeed = p.w;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p.xyz, 1.0);
  gl_PointSize = uPointSize;
}

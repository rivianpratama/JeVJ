// The dust's position: one Euler step, and a wrap.
//
// `texturePosition` and `textureVelocity` are declared by the
// GPUComputationRenderer; `resolution` is its #define.
//
// `uSpeed` multiplies *here* rather than in the velocity shader on purpose:
// scaling the acceleration would change how fast the cloud settles onto its
// attractor as well as how fast it moves, so a loud passage would gather
// differently rather than simply faster. Scaling the integration is a clean
// change of tempo.
//
// The w channel is the particle's seed and is carried through untouched: it is
// what picks the 12% of the dust that carries the accent.

uniform float uDt;
uniform float uSpeed;

/** Past this the cloud is off camera; it comes back through the middle. */
const float WRAP_RADIUS = 3.0;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posT = texture2D(texturePosition, uv);
  vec3 vel = texture2D(textureVelocity, uv).xyz;

  vec3 pos = posT.xyz + vel * uDt * uSpeed;

  // Wrap to the antipode rather than clamping: a clamp builds a visible crust
  // on the sphere of no return, and a reflection makes the escapees bounce in
  // step. Re-entering on the far side just looks like more dust arriving.
  float r = length(pos);
  if (r > WRAP_RADIUS) pos *= -(WRAP_RADIUS - 0.02) / r;

  gl_FragColor = vec4(pos, posT.w);
}

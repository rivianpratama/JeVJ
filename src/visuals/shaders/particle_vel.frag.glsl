// The dust's velocity, one texel per particle.
//
// `texturePosition` and `textureVelocity` are declared by the
// GPUComputationRenderer, which prepends their sampler uniforms — they must
// not be declared here. `resolution` is a #define it adds as well.
//
// The whole motion is one line:
//
//   a = curl(pos·0.35 + t·0.08)·uCurl + attractor(pos)·uAttract − vel·uDrag + impulse
//
// Curl noise is what makes it *dust* rather than a simulation: it is the only
// term that is not aimed at anything. The attractor is what makes it gather;
// the drag is what stops it ringing around the attractor forever; the impulse
// is the music hitting it.

uniform float uTime;
uniform float uDt;
uniform float uCurl;
uniform float uAttract;
uniform float uDrag;
uniform int uAttractor;
uniform float uRadius;
uniform float uForce;
uniform float uExplode;
uniform float uImpact;
uniform float uOnset;
uniform float uImpulse;

/** Fast enough that a runaway particle cannot outrun the wrap radius. */
const float MAX_SPEED = 6.0;

/** One of the three swarm targets, on its own lissajous path. */
vec3 swarmTarget(float k) {
  float t = uTime * 0.25 + k * 2.09;
  return vec3(
    1.3 * sin(t + k),
    0.9 * sin(t * 1.3 + k * 2.0),
    1.3 * cos(t * 0.7 + k * 3.0));
}

vec3 attractorForce(vec3 p) {
  float r = length(p);
  vec3 dir = r > 1.0e-4 ? p / r : vec3(0.0, 1.0, 0.0);

  if (uAttractor == 0) {
    // Sphere: a spring onto a shell. Signed, so dust inside is pushed out and
    // dust outside is pulled in — which is what makes the shell an edge rather
    // than a heap at the centre.
    return dir * (uRadius - r);
  }

  if (uAttractor == 1) {
    // Plane: toward y = 0, with a slow standing wave so the sheet is not flat.
    float wave = 0.12 * sin(p.x * 1.7 + uTime * 0.4) * cos(p.z * 1.3 - uTime * 0.3);
    return vec3(0.0, wave - p.y, 0.0);
  }

  if (uAttractor == 2) {
    // Vortex: tangential around the y axis, plus a gentle inward pull so the
    // rotation has something to hold it together.
    vec3 tang = vec3(-p.z, 0.0, p.x);
    float rxz = max(length(tang), 1.0e-4);
    return tang / rxz * 1.2 + dir * (uRadius - r) * 0.5;
  }

  if (uAttractor == 3) {
    // Explode: outward from the origin, relaxing back onto the shell as the
    // envelope decays — so a hit scatters the dust and the dust re-gathers.
    return mix(dir * (uRadius - r), dir * 2.0 * uForce, uExplode);
  }

  // Swarm: each particle chases whichever of the three targets is nearest, so
  // the cloud splits into three flocks that trade members as the paths cross.
  vec3 best = swarmTarget(0.0);
  float bestD = distance(p, best);
  for (int i = 1; i < 3; i++) {
    vec3 c = swarmTarget(float(i));
    float d = distance(p, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best - p;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posT = texture2D(texturePosition, uv);
  vec4 velT = texture2D(textureVelocity, uv);
  vec3 pos = posT.xyz;
  vec3 vel = velT.xyz;

  vec3 dir = length(pos) > 1.0e-4 ? normalize(pos) : vec3(0.0, 1.0, 0.0);
  // A direction that is random per particle and per frame: an onset should
  // scatter the cloud, not push all of it the same way.
  vec3 rnd = hash33(vec3(uv * 37.0, fract(uTime * 0.37))) * 2.0 - 1.0;
  rnd = length(rnd) > 1.0e-4 ? normalize(rnd) : dir;
  vec3 impulse = (uImpact * dir * 3.0 + uOnset * rnd * 0.4) * uImpulse;

  vec3 a = curlNoise3(pos * 0.35 + uTime * 0.08) * uCurl
         + attractorForce(pos) * uAttract
         - vel * uDrag
         + impulse;

  vel += a * uDt;

  float speed = length(vel);
  if (speed > MAX_SPEED) vel *= MAX_SPEED / speed;

  gl_FragColor = vec4(vel, velT.w);
}

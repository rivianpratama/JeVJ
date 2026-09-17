// The scene mix: up to five scene textures, weighted by the director.
//
// The scenes are all *light* — ink, particles, strands, relief and breath are
// things that emit — so the mix is addition, not alpha compositing. That is
// what lets a crossfade between two layers pass through a moment where both are
// half-lit instead of one occluding the other.
//
// One exception: the dust over the ink is a screen blend, `1 − (1 − a)(1 − b)`.
// Straight addition lets a dense shell sitting over an already-bright fold of
// ink run away to white, and the shape of the shell — the thing the dust is
// for — disappears into the blowout. Screen compresses as it approaches one,
// so the shell stays legible over any ink. The strands add normally: they are
// thin, they are meant to sum where they cross, and screening them would flatten
// a curtain of four hundred veils into one.
//
// Screen is only defined on 0..1, and these buffers are HDR — the ink pushes
// its highlights past one so the bloom has something to catch. So the screen is
// taken on the clamped parts and whatever was above one is added back on top,
// which agrees with the plain formula everywhere inside the unit range and
// keeps the headroom outside it.

varying vec2 vUv;

uniform sampler2D tDiffuse; // unused: this pass generates rather than filters
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform sampler2D uTex4;
uniform float uW[5];

vec3 screen(vec3 a, vec3 b) {
  vec3 lo = 1.0 - (1.0 - min(a, 1.0)) * (1.0 - min(b, 1.0));
  return lo + max(a - 1.0, 0.0) + max(b - 1.0, 0.0);
}

void main() {
  vec3 ink = texture2D(uTex0, vUv).rgb * uW[0];
  vec3 particles = texture2D(uTex1, vUv).rgb * uW[1];

  vec3 col = screen(ink, particles)
           + texture2D(uTex2, vUv).rgb * uW[2]
           + texture2D(uTex3, vUv).rgb * uW[3]
           + texture2D(uTex4, vUv).rgb * uW[4];
  gl_FragColor = vec4(col, 1.0);
}

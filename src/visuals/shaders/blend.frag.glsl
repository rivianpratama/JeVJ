// The scene mix: up to five scene textures, weighted by the director.
//
// Weighted addition rather than alpha compositing, because the scenes are all
// light: ink, particles, strands, relief and breath are things that *emit*,
// and adding them is what lets a crossfade between two of them pass through a
// moment where both are half-lit instead of one occluding the other.
//
// Only the ink exists today; the rest are bound to a 1×1 black texture at
// weight 0 and cost one tap each.

varying vec2 vUv;

uniform sampler2D tDiffuse; // unused: this pass generates rather than filters
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform sampler2D uTex4;
uniform float uW[5];

void main() {
  vec3 col = texture2D(uTex0, vUv).rgb * uW[0]
           + texture2D(uTex1, vUv).rgb * uW[1]
           + texture2D(uTex2, vUv).rgb * uW[2]
           + texture2D(uTex3, vUv).rgb * uW[3]
           + texture2D(uTex4, vUv).rgb * uW[4];
  gl_FragColor = vec4(col, 1.0);
}

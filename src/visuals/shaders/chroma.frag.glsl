// Radial RGB split, and the acid posterize.
//
// The split is scaled by distance from the middle, like a lens: nothing at the
// center, most at the corners. It is normally sub-pixel — `synthetic·arousal`
// tops out at 0.012 — and only becomes visible on an impact, which is the
// point: the screen momentarily fails to hold itself together.
//
// Posterize is the only non-continuous thing in the whole chain, so it is kept
// for hard electronic peaks and off everywhere else. With it comes a hue
// rotation on the beat phase, which is what makes it read as deliberate.

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform float uChroma;
uniform float uPosterize;
uniform float uBeatPhase;

void main() {
  vec2 offset = (vUv - 0.5) * uChroma;

  vec3 col = vec3(
    texture2D(tDiffuse, clamp(vUv + offset, 0.0, 1.0)).r,
    texture2D(tDiffuse, vUv).g,
    texture2D(tDiffuse, clamp(vUv - offset, 0.0, 1.0)).b);

  if (uPosterize >= 2.0) {
    vec3 hsv = rgb2hsv(col);
    hsv.x = fract(hsv.x + 0.15 * uBeatPhase);
    col = hsv2rgb(hsv);
    col = floor(col * uPosterize + 0.5) / uPosterize;
  }

  gl_FragColor = vec4(col, 1.0);
}

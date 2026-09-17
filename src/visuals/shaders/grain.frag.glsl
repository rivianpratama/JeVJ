// Film grain and a feathered vignette: the last thing before tone mapping.
//
// Both exist to stop the image reading as computer graphics. The vignette is
// feathered over a wide range rather than ramped from a hard radius, and the
// grain is stronger in the shadows than in the highlights, the way film is.
//
// The last line is a dither, not an effect: a sub-LSB noise that turns the
// banding a smooth gradient would otherwise show on an 8-bit display into a
// texture too fine to see. The whole chain is half-float precisely so that
// this is the only place quantisation happens.

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
uniform float uAspect;

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;

  float d = length((vUv - 0.5) * vec2(uAspect, 1.0));
  col *= 1.0 - uVignette * smoothstep(0.25, 0.95, d);

  // Grain: a fresh hash every frame, shaped onto the midtones. It has to fall
  // away in the deep background, because everything here happens before the
  // sRGB encode and a ±0.05 wobble around linear black becomes a ±0.2 storm of
  // static once encoded — which is exactly where most of a calm frame sits.
  float l = clamp(luma(col), 0.0, 1.0);
  float shape = smoothstep(0.0, 0.12, l) * (1.0 - 0.5 * smoothstep(0.5, 1.0, l));
  float n = hash12(gl_FragCoord.xy + fract(uTime * 7.3) * vec2(311.7, 197.3)) - 0.5;
  col += n * uGrain * shape;

  // Ordered-free dither, ±half an 8-bit step.
  col += (hash12(gl_FragCoord.xy * 1.7 + fract(uTime) * 53.0) - 0.5) / 255.0;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}

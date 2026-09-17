// Film grain and a feathered vignette: the last thing before tone mapping.
//
// Both exist to stop the image reading as computer graphics, and the grain
// only does that if it can be seen. It is added *before* the vignette and at
// full strength everywhere: an earlier version shaped it by luminance so it
// faded out of the shadows, which in a picture that is mostly shadow meant it
// faded out of the picture. The vignette then darkens grain and image
// together, which is what a lens does to film.
//
// The vignette is feathered over a wide range rather than ramped from a hard
// radius.
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

  // Grain: one fresh monochrome hash per pixel per frame. `gl_FragCoord.xy` is
  // uv × resolution, so the grain is one screen pixel across whatever the
  // scene resolution is — which is what makes it read as film rather than as
  // a texture that zooms with the image.
  float n = hash12(gl_FragCoord.xy + fract(uTime * 7.3) * vec2(311.7, 197.3)) - 0.5;
  col += n * uGrain;

  float d = length((vUv - 0.5) * vec2(uAspect, 1.0));
  col *= 1.0 - uVignette * smoothstep(0.25, 0.95, d);

  // Ordered-free dither, ±half an 8-bit step.
  col += (hash12(gl_FragCoord.xy * 1.7 + fract(uTime) * 53.0) - 0.5) / 255.0;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}

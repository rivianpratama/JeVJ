// The voice layer: a glow that breathes and a band of ridges that listens.
//
// This is the one scene in the app with a hard rule on its *output* rather than
// on its inputs: it must never flash. It runs under a talking voice, and speech
// is spiky — a plosive is a 10 ms spike in RMS that any honest envelope
// follower would turn into a frame of white. So nothing here is driven by the
// instantaneous loudness. `uRms` arrives already lagged by 0.15 s and `uLevel`
// is rate-limited on the TS side to 0.08 of full scale per *frame*, so the
// widest possible swing takes about thirteen frames. See `breathLevel.ts`.
//
// Three elements and nothing else:
//
//  - **the glow**: one wide gaussian in the middle of the frame, its width on a
//    six-second period — about the length of a breath — plus a little from the
//    voice. It is what gives a podcast a centre to sit in;
//  - **the ridges**: a soft horizontal band whose height follows the lagged
//    loudness and whose profile scrolls slowly sideways. Loud speech makes a
//    taller band, so the picture answers the voice without tracking a syllable;
//  - **the grain**, at 0.05, which is what keeps a field this smooth from
//    banding in the dark.
//
// The palette arrives desaturated (chroma × 0.2), so all of this is near
// monochrome by construction rather than by the shader avoiding colour.
//
// `fbm`, `hash12` and `TAU` come from `common.glsl`.

varying vec2 vUv;

uniform float uTime;
/** The rate-limited overall brightness. Nothing else scales the output. */
uniform float uLevel;
/** Loudness, lagged 0.15 s. Shapes, never scales. */
uniform float uRms;
uniform float uAspect;
uniform vec3 uBg;
uniform vec3 uStops[5];
uniform float uGrain;

/** The glow's resting width, how far it breathes, and over what period. */
const float GLOW_SIGMA = 0.36;
const float GLOW_BREATH = 0.07;
const float GLOW_PERIOD = 6.0;
const float GLOW_RMS = 0.06;
const float GLOW_GAIN = 1.1;

/** How many ridges across the frame, and how fast they scroll. */
const float RIDGE_FREQ = 4.5;
const float RIDGE_SCROLL = 0.035;
/** The band's half-height at silence, and how far the voice swells it. */
const float RIDGE_BASE = 0.02;
const float RIDGE_SWELL = 0.22;
const float RIDGE_GAIN = 0.9;

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);

  float sigma = GLOW_SIGMA + GLOW_BREATH * sin(TAU * uTime / GLOW_PERIOD) + GLOW_RMS * uRms;
  float glow = exp(-dot(p, p) / (2.0 * sigma * sigma));

  // The ridge profile is read along x alone — this is a band, not a field — and
  // the second coordinate is a fixed offset into the noise rather than y, so
  // the band has one silhouette rather than a cloud with a waist.
  float r = fbm(vec2(vUv.x * RIDGE_FREQ + uTime * RIDGE_SCROLL, 3.7));
  float amp = RIDGE_BASE + RIDGE_SWELL * uRms * (0.35 + 0.65 * r);
  float d = (vUv.y - 0.5) / amp;
  float ridge = exp(-d * d);

  vec3 col = uBg + uStops[2] * glow * GLOW_GAIN + uStops[3] * ridge * RIDGE_GAIN;
  col *= uLevel;

  // Grain last and unscaled: it is film, not light, and dimming it with the
  // picture would let the darkest passages band, which is where it is needed.
  col += (hash12(gl_FragCoord.xy + vec2(uTime * 61.0, 0.0)) - 0.5) * uGrain;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}

// Stage 2 of the ink: the light the music puts in, added on top of stage 1.
//
// Drawn with additive blending straight into the density target, so this is
// the only place new ink ever enters the system — everything else is decay and
// advection. Three things go in:
//
//  - orbiting lobes, one per ink, riding the beat phase around the middle and
//    lit by their own frequency band. This is the "on the beat" of the whole
//    look, and because the lobes are injected and then carried away by the
//    flow, a beat leaves a wake rather than a flash;
//  - a thin ring on the downbeat, which reads as a bar line;
//  - a full-screen splash on an impact, into all three inks at once.

varying vec2 vUv;

uniform float uTime;
uniform float uBeatPhase;
uniform float uSub;
uniform float uBands[8];
uniform float uInjectGain;
uniform float uDownbeatPulse;
uniform float uImpact;
uniform int uLobes;
uniform float uAspect;
uniform float uDt;

const float RING_RADIUS = 0.3;
const float RING_WIDTH = 0.01;
/**
 * Ink added per second, per unit of band energy.
 *
 * Injection is a *rate*, not an amount: a lobe that adds its intensity once a
 * frame would pile up to intensity/(1−decay) — twenty times full scale at the
 * idle decay — and the whole field would sit clipped at the top of the palette
 * as one flat white shape. Scaling by dt also makes the look the same on a
 * 120 Hz display as on a 60 Hz one. This constant is chosen so that a lobe
 * sitting still reaches roughly full scale and no further.
 */
const float INJECT_RATE = 2.4;

void main() {
  // Aspect-corrected so the orbit is a circle on a wide screen.
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float dist = length(p);

  vec3 ink = vec3(0.0);

  float lobes = float(uLobes);
  for (int k = 0; k < 4; k++) {
    if (k >= uLobes) break;
    float fk = float(k);
    float angle = TAU * (uBeatPhase + fk / lobes);
    float orbit = 0.18 + 0.1 * uSub;
    vec2 center = vec2(cos(angle), sin(angle)) * orbit;

    float intensity = uBands[1 + 2 * k] * uInjectGain;
    float radius = mix(0.06, 0.14, clamp(intensity, 0.0, 1.0));
    float d = length(p - center) / radius;
    float blob = exp(-d * d) * intensity;

    // Lobe k feeds ink k: with four lobes the fourth doubles up on ink A,
    // which is what gives a duple meter its heavier one-and-three.
    if (k == 0) ink.r += blob;
    else if (k == 1) ink.g += blob;
    else if (k == 2) ink.b += blob;
    else ink.r += blob;
  }

  // The downbeat ring.
  float ring = exp(-pow((dist - RING_RADIUS) / RING_WIDTH, 2.0));
  ink += vec3(ring * uDownbeatPulse);

  // The impact splash: everywhere at once, brightest in the middle.
  ink += vec3(uImpact * (1.0 - smoothstep(0.0, 0.6, dist)) * 1.5);

  gl_FragColor = vec4(max(ink, vec3(0.0)) * uDt * INJECT_RATE, 1.0);
}

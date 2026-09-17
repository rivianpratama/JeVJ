// Stage 2 of the ink: the light the music puts in, added on top of stage 1.
//
// Drawn with additive blending straight into the density target, so this is
// the only place new ink ever enters the system — everything else is decay and
// advection. Three things go in:
//
//  - an ambient wash over the whole frame, every frame, modulated by a slow
//    fbm. This is the floor the picture stands on: without it the ink only
//    exists where a lobe was injected, and the rest of the field decays to the
//    background inside a second — an annulus around the middle and empty
//    everywhere else, which is what the frame actually looked like;
//  - orbiting lobes, one per ink, riding the beat phase around the middle and
//    lit by their own frequency band. This is the "on the beat" of the whole
//    look, and because the lobes are injected and then carried away by the
//    flow, a beat leaves a wake rather than a flash. An inner ring of them,
//    and an outer ring at half speed the other way round, so the beat reaches
//    the corners instead of circling the card;
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
 * The ambient wash: how much ink a second, at the fbm's midpoint, before
 * `INJECT_RATE` and the gain.
 *
 * Calibrated against the decay and the grain rather than chosen. What reaches
 * the screen is not this number but its equilibrium, `rate / (1 - decay)`,
 * and the idle decay of 0.99 a frame makes that a hundred frames' worth. At
 * 0.012 — the figure the direction asked for, which did not account for
 * `INJECT_RATE` — the field settles at a density of 0.024, which the soft
 * knee maps to 4% of the ramp: a relative luminance of 0.003, which is the
 * background with extra steps.
 *
 * The grain sets the floor under that. It is a flat ±grain/2 in *linear*
 * light, so a field dimmer than the grain is amplitude is not a grained field,
 * it is noise with a tint: half its pixels clamp at black and the eye reads
 * static rather than texture. At this value the idle field settles around
 * stop 1-2, comfortably above the ±0.03 the grain swings, and the light stops
 * are left for the marbling to reach.
 */
const float AMBIENT_RATE = 0.3;
/** Where the inner lobes orbit, and how far the sub band pushes them out. */
const float INNER_ORBIT = 0.22;
const float INNER_ORBIT_SUB = 0.12;
/** The outer lobes: three of them, further out, slower, and the other way. */
const int OUTER_LOBES = 3;
const float OUTER_ORBIT = 0.42;
const float OUTER_RADIUS = 0.16;
const float OUTER_GAIN = 0.6;
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

  // The ambient wash. Split unevenly across the three inks so the field is
  // already marbled before a single beat lands: ink A carries it, B half as
  // much, C a third — which is the same weighting the color stage reads them
  // back with, so the wash sits low on the palette ramp rather than gray.
  float amb = AMBIENT_RATE
    * (0.5 + 0.5 * fbm(vUv * 3.0 + vec2(uTime * 0.02, -uTime * 0.013)))
    * uInjectGain;
  ink.r += amb * (0.6 + 0.4 * uBands[2]);
  ink.g += amb * 0.5 * (0.3 + uBands[4]);
  ink.b += amb * 0.3 * (0.3 + uBands[6]);

  float lobes = float(uLobes);
  for (int k = 0; k < 4; k++) {
    if (k >= uLobes) break;
    float fk = float(k);
    float angle = TAU * (uBeatPhase + fk / lobes);
    float orbit = INNER_ORBIT + INNER_ORBIT_SUB * uSub;
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

  // The outer ring of lobes: half the angular speed, the opposite direction
  // and wider, so the two rings counter-rotate and the field between them
  // shears instead of settling.
  for (int k = 0; k < OUTER_LOBES; k++) {
    float fk = float(k);
    float angle = -TAU * (0.5 * uBeatPhase + fk / float(OUTER_LOBES));
    vec2 center = vec2(cos(angle), sin(angle)) * OUTER_ORBIT;

    float intensity = uBands[5 + k] * OUTER_GAIN * uInjectGain;
    float d = length(p - center) / OUTER_RADIUS;
    float blob = exp(-d * d) * intensity;

    if (k == 0) ink.r += blob;
    else if (k == 1) ink.g += blob;
    else ink.b += blob;
  }

  // The downbeat ring. `e * e` rather than `pow(e, 2.0)`: pow with a negative
  // base is undefined in GLSL ES, `e` is negative inside the ring's radius,
  // and a NaN written here would be advected across a buffer that is never
  // cleared and never recovers.
  float e = (dist - RING_RADIUS) / RING_WIDTH;
  float ring = exp(-e * e);
  ink += vec3(ring * uDownbeatPulse);

  // The impact splash: everywhere at once, brightest in the middle.
  ink += vec3(uImpact * (1.0 - smoothstep(0.0, 0.6, dist)) * 1.5);

  gl_FragColor = vec4(max(ink, vec3(0.0)) * uDt * INJECT_RATE, 1.0);
}

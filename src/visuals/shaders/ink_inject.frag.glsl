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
/**
 * The ambient wash is a *level*, not a rate.
 *
 * What reaches the screen is never the injection but the equilibrium of the
 * feedback loop,
 *
 *     D = rate * dt / (1 - decay^(dt*60))
 *
 * — `inkEquilibriumDensity` in ../inkMath.ts — which the color stage then maps
 * through the soft knee `1 - e^(-KNEE*D)`. A fixed rate therefore does not
 * describe a picture: the same rate that settles at a dark field with luminous
 * marbling at the idle decay of 0.99 settles six times lower at the 0.94 a
 * loud section asks for, and lower again on a page whose frames have got long.
 * The shipped constant was solved at the idle decay, so the frame went dark
 * exactly when the music got big — measured at a mean relative luminance of
 * 0.05 through a climax against 0.18 on an idle page.
 *
 * So the amount added each frame is handed in as `uAmbientAdd`: the CPU works
 * out what a frame at this decay and this dt actually loses, and adds back
 * precisely that, which makes the target density the loop's fixed point at
 * every decay and every frame rate. See `ambientInjectPerFrame`.
 *
 * The level itself (`AMBIENT_LEVEL`, 2.0) is what the old constants produced at
 * idle, so the field that was right stays exactly where the tuning pass left
 * it: mean 0.27 over the frame, 20th percentile 0.00, 95th 0.81, with two
 * fifths of the frame at no ambient ink at all. tests/visuals/inkMath.test.ts
 * holds all of it.
 */
uniform float uAmbientAdd;

const float RING_RADIUS = 0.3;
const float RING_WIDTH = 0.01;

/**
 * The wash pools into veins rather than lying flat: the same fbm that
 * modulates it is also gated through a smoothstep, so below VEIN_LO no ambient
 * ink is laid down at all. A field of uniform ambient is a plane, and a plane
 * has no darks for the marbling to be luminous against — the picture is
 * supposed to be a dark field with light in it, not a lit field.
 */
const float VEIN_LO = 0.42;
const float VEIN_HI = 0.78;
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
  //
  // Kept apart from `ink` below because it is the only term that is a standing
  // level rather than an event: it is scaled by `uAmbientAdd` at the end, where
  // everything else is scaled by `uDt * INJECT_RATE`.
  float vein = fbm(vUv * 3.0 + vec2(uTime * 0.02, -uTime * 0.013));
  float amb = (0.5 + 0.5 * vein) * smoothstep(VEIN_LO, VEIN_HI, vein) * uInjectGain;
  vec3 ambient = vec3(
    amb * (0.6 + 0.4 * uBands[2]),
    amb * 0.5 * (0.3 + uBands[4]),
    amb * 0.3 * (0.3 + uBands[6]));

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

  gl_FragColor = vec4(
    max(ink, vec3(0.0)) * uDt * INJECT_RATE + max(ambient, vec3(0.0)) * uAmbientAdd,
    1.0);
}

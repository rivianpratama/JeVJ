// Stage 2 of the smoke: the light the music puts in, added on top of stage 1.
//
// Drawn with additive blending straight into the density target, so this is
// the only place new smoke ever enters the system — everything else is decay
// and advection.
//
// **Everything is born on the annulus.** v1 injected at the middle of the
// frame, which is exactly where the card sits: the smoke was brightest behind
// the picture and the rest of the screen got whatever the flow carried there.
// Now the ring of birth is the card's own feathered edge — inner radius the
// card's half-diagonal, outer 0.18 of the frame further out — so smoke appears
// *at* the edge of the picture and is carried outward by `uPushOut` and round
// by the spin. The card's own square stays the darkest part of the frame,
// which is what makes it read as an object in the smoke rather than a window
// cut in it.
//
// Five things go in:
//
//  - an ambient veined wash, at half the rate v1 used and gated down inside the
//    card. This is the floor the picture stands on: without it the smoke only
//    exists where something was injected, and the rest of the field decays to
//    black inside a second;
//  - orbiting lobes riding the beat phase around the annulus, lit by their own
//    frequency band — injected and then carried away, so a beat leaves a wake
//    rather than a flash. An inner ring and an outer ring at half speed the
//    other way round, so the field between them shears;
//  - **filaments**: two or three thin bright quadratic Béziers seeded on the
//    annulus on each onset, tangent to the flow. Under the feedback pass's
//    anisotropic blur a filament smears *along* itself into a sheet with fine
//    parallel striations in it, which is the whole look of the reference
//    images. They are the sharp bright curl edges;
//  - a thin ring on the downbeat, on the annulus, which reads as a bar line;
//  - an annular splash on an impact, into all three smokes at once.
//
// And everything injected is **combed**: multiplied by a fine sinusoid whose
// phase runs across the local flow direction, so a sheet carries parallel
// striations from the instant it is born rather than acquiring them from the
// blur alone. The flow direction is read out of the alpha channel, where the
// feedback pass left it — see `uPrev`.

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
uniform float uStriate;
/** The field's rotation, so the veined wash turns with the smoke it feeds. */
uniform float uSpin;
/** The annulus: centre in uv, radii in the aspect-corrected space below. */
uniform vec2 uCardCenter;
uniform float uCardInner;
uniform float uCardOuter;
/**
 * Last frame's density target, read for one thing only: the flow angle the
 * feedback pass packed into its alpha channel. Re-deriving the flow here would
 * be eight more fbm evaluations a pixel for a direction that moves by a
 * fraction of a degree in a frame.
 */
uniform sampler2D uPrev;
/**
 * The live filaments: `uFilA` is (p0.xy, p1.xy) and `uFilB` is
 * (p2.xy, intensity, width) for each of three slots, all in the
 * aspect-corrected space. An intensity of 0 is an empty slot.
 */
uniform vec4 uFilA[3];
uniform vec4 uFilB[3];
/**
 * The ambient wash is a *level*, not a rate.
 *
 * What reaches the screen is never the injection but the equilibrium of the
 * feedback loop,
 *
 *     D = rate * dt / (1 - decay^(dt*60))
 *
 * — `inkEquilibriumDensity` in ../inkMath.ts — which the color stage then maps
 * through the soft knee. A fixed rate therefore does not describe a picture:
 * the same rate that settles at a dark field with luminous marbling at the idle
 * decay of 0.99 settles six times lower at the 0.94 a loud section asks for.
 *
 * So the amount added each frame is handed in as `uAmbientAdd`: the CPU works
 * out what a frame at this decay and this dt actually loses, and adds back
 * precisely that, which makes the target density the loop's fixed point at
 * every decay and every frame rate. See `ambientInjectPerFrame`.
 */
uniform float uAmbientAdd;

/** How wide the downbeat's ring is, as a fraction of the annulus band. */
const float RING_WIDTH = 0.012;
/**
 * The wash pools into veins rather than lying flat: the same fbm that
 * modulates it is also gated through a smoothstep, so below VEIN_LO no ambient
 * smoke is laid down at all. A field of uniform ambient is a plane, and a plane
 * has no darks for the sheets to be luminous against — the picture is supposed
 * to be a dark field with light in it, not a lit field.
 *
 * v2 deepened the gate from 0.42/0.78, and the number it was tuned against is
 * the reference's own: with these two, 65% of the frame receives no ambient
 * smoke at all, against 45% before. "Roughly 60–70% of the frame is black, the
 * rest is gradient" is the sentence VEIN_LO implements.
 *
 * VEIN_HI came down with it, and it has to: the gate is a `smoothstep` over the
 * fbm, whose values almost never leave 0.3–0.8, so a high ceiling means the
 * gate never reaches anything like 1 and the level has to be scaled up by an
 * order of magnitude to compensate — which puts the brightest half of the frame
 * past the knee's saturation and turns a loud section into one flat white
 * sheet. Measured: at 0.9 the build frame came out at a mean of 0.51 with its
 * darkest fifth at 0.44, which is a white page.
 */
const float VEIN_LO = 0.52;
const float VEIN_HI = 0.74;
/**
 * What the card's own square keeps of the ambient wash.
 *
 * Not zero: a hard hole would give the card an edge, and the whole design of
 * the card is that it has none. At 0.06, and faded in from well inside the
 * card's half-diagonal out to the far side of the annulus, the picture sits in
 * a pool of darkness that the smoke rolls out of — which is the measured
 * requirement that the frame outside the card reads at least half again as
 * bright as the frame inside it.
 *
 * It has to be this deep because the smoke is not the only thing in the frame:
 * at idle the silk takes as much of the mix as the smoke does and it hangs
 * across the middle, so the composite's inside/outside ratio is always well
 * under the smoke layer's own. Measured, the smoke alone reads 2.2× and the
 * composite 1.6×.
 */
const float CARD_FLOOR = 0.06;
const float CARD_FADE_IN = 0.3;
/** Where the inner lobes orbit within the annulus, and how far the sub pushes them. */
const float INNER_ORBIT_MIX = 0.5;
const float INNER_ORBIT_SUB = 0.12;
/** The outer lobes: three of them, further out, slower, and the other way. */
const int OUTER_LOBES = 3;
const float OUTER_ORBIT_EXTRA = 0.2;
const float OUTER_RADIUS = 0.16;
const float OUTER_GAIN = 0.6;
/** How many points along a filament's Bézier the distance is taken over. */
const int FILAMENT_STEPS = 12;
/**
 * Smoke added per second, per unit of band energy.
 *
 * Injection is a *rate*, not an amount: a lobe that adds its intensity once a
 * frame would pile up to intensity/(1−decay) — twenty times full scale at the
 * idle decay — and the whole field would sit clipped at the top of the palette
 * as one flat white shape. Scaling by dt also makes the look the same on a
 * 120 Hz display as on a 60 Hz one.
 */
const float INJECT_RATE = 2.4;
/**
 * How deep the comb cuts: `0.75 + 0.25·sin(…)`, so the striations are a
 * quarter-amplitude modulation and never a set of gaps. Its mean is 0.75, and
 * the ambient target in ../inkMath.ts is solved with that factor in it.
 */
/** How much of the director's `injectGain` the standing wash takes. */
const float AMBIENT_GAIN = 0.0;
const float STRIATE_MEAN = 0.75;
const float STRIATE_AMP = 0.25;

/** Distance from `p` to the quadratic Bézier through a, b, c, sampled. */
float bezierDistance(vec2 p, vec2 a, vec2 b, vec2 c) {
  float best = 1.0e9;
  for (int i = 0; i <= FILAMENT_STEPS; i++) {
    float t = float(i) / float(FILAMENT_STEPS);
    float s = 1.0 - t;
    vec2 q = s * s * a + 2.0 * s * t * b + t * t * c;
    best = min(best, length(p - q));
  }
  return best;
}

void main() {
  // Aspect-corrected, so the annulus is a circle on a wide screen and a card
  // square is still a square.
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec2 center = (uCardCenter - 0.5) * vec2(uAspect, 1.0);
  vec2 q = p - center;
  float dist = length(q);
  float mid = mix(uCardInner, uCardOuter, INNER_ORBIT_MIX);
  float band = max(1.0e-4, uCardOuter - uCardInner);

  vec3 smoke = vec3(0.0);

  // The ambient wash. Split unevenly across the three smokes so the field is
  // already marbled before a single beat lands: smoke A carries it, B half as
  // much, C a third — which is the same weighting the color stage reads them
  // back with, so the wash sits low on the palette ramp rather than gray.
  //
  // Kept apart from `smoke` below because it is the only term that is a
  // standing level rather than an event: it is scaled by `uAmbientAdd` at the
  // end, where everything else is scaled by `uDt * INJECT_RATE`.
  // The veins turn with the field.
  //
  // This is not decoration, it is the difference between smoke and a wash. The
  // wash is injected into a *moving* medium: hold the vein pattern still while
  // the field rotates through it and every pixel is fed by every vein in turn,
  // so over half a minute the dark channels average away and the frame settles
  // into a uniform glow — measured, the smoke layer's darkest fifth came out at
  // 0.28 with two thirds of the *injection* at literally zero. Rotating the
  // pattern by the same angle the flow field is rotated by means a parcel of
  // smoke stays in its own vein, and the gaps between them stay empty.
  //
  // Half the speed v1 drifted at, on top of that: "slow majestic rolling" is
  // the reference's own phrase, and the wash is the slowest thing in the frame.
  vec2 veinUv = rot2(uSpin) * (vUv - uCardCenter) + 0.5;
  float vein = fbm(veinUv * 3.0 + vec2(uTime * 0.01, -uTime * 0.0065));
  float outside = mix(CARD_FLOOR, 1.0, smoothstep(uCardInner * CARD_FADE_IN, uCardOuter, dist));
  // The wash does not take the director's gain at all.
  //
  // It is a standing *level* — the whole point of `uAmbientAdd` is that the
  // loop is driven to a fixed density whatever the decay and whatever the frame
  // rate — and a level that doubles with the music is not a floor, it is
  // another event. Worse, the colour stage's knee saturates, so when it doubles
  // the top of the frame has nowhere to go: a build section measured a mean of
  // 0.51 with its darkest fifth at 0.44, which is a white page and not a
  // picture. The music's dynamics belong to the lobes, the filaments, the rings
  // and the impact below, which are rates and can grow without bound.
  //
  // `AMBIENT_GAIN` is kept as the knob rather than deleted because it is the
  // thing that was wrong and the thing a future pass would reach for first.
  float ambGain = mix(1.0, uInjectGain, AMBIENT_GAIN);
  float amb = (0.5 + 0.5 * vein) * smoothstep(VEIN_LO, VEIN_HI, vein) * ambGain * outside;
  vec3 ambient = vec3(
    amb * (0.6 + 0.4 * uBands[2]),
    amb * 0.5 * (0.3 + uBands[4]),
    amb * 0.3 * (0.3 + uBands[6]));

  float lobes = float(uLobes);
  for (int k = 0; k < 4; k++) {
    if (k >= uLobes) break;
    float fk = float(k);
    float angle = TAU * (uBeatPhase + fk / lobes);
    float orbit = mid + INNER_ORBIT_SUB * uSub * band;
    vec2 at = center + vec2(cos(angle), sin(angle)) * orbit;

    float intensity = uBands[1 + 2 * k] * uInjectGain;
    float radius = mix(0.06, 0.14, clamp(intensity, 0.0, 1.0));
    float d = length(p - at) / radius;
    float blob = exp(-d * d) * intensity;

    // Lobe k feeds smoke k: with four lobes the fourth doubles up on A, which
    // is what gives a duple meter its heavier one-and-three.
    if (k == 0) smoke.r += blob;
    else if (k == 1) smoke.g += blob;
    else if (k == 2) smoke.b += blob;
    else smoke.r += blob;
  }

  // The outer ring of lobes: half the angular speed, the opposite direction
  // and wider, so the two rings counter-rotate and the field between them
  // shears instead of settling.
  for (int k = 0; k < OUTER_LOBES; k++) {
    float fk = float(k);
    float angle = -TAU * (0.5 * uBeatPhase + fk / float(OUTER_LOBES));
    vec2 at = center + vec2(cos(angle), sin(angle)) * (uCardOuter + OUTER_ORBIT_EXTRA);

    float intensity = uBands[5 + k] * OUTER_GAIN * uInjectGain;
    float d = length(p - at) / OUTER_RADIUS;
    float blob = exp(-d * d) * intensity;

    if (k == 0) smoke.r += blob;
    else if (k == 1) smoke.g += blob;
    else smoke.b += blob;
  }

  // The filaments. Bright and thin and weighted toward smoke A, which is the
  // channel the colour stage reads hardest — a filament is meant to be the one
  // thing in the frame with a hot core.
  for (int i = 0; i < 3; i++) {
    float intensity = uFilB[i].z;
    if (intensity <= 0.0) continue;
    float width = max(1.0e-4, uFilB[i].w);
    float d = bezierDistance(p, uFilA[i].xy, uFilA[i].zw, uFilB[i].xy) / width;
    float line = exp(-d * d) * intensity;
    smoke += vec3(1.0, 0.6, 0.35) * line;
  }

  // The downbeat ring, on the annulus. `e * e` rather than `pow(e, 2.0)`: pow
  // with a negative base is undefined in GLSL ES, `e` is negative inside the
  // ring's radius, and a NaN written here would be advected across a buffer
  // that is never cleared and never recovers.
  float e = (dist - mid) / (RING_WIDTH + 0.1 * band);
  float ring = exp(-e * e);
  smoke += vec3(ring * uDownbeatPulse);

  // The impact splash: a thick shell on the annulus rather than a blob in the
  // middle, so a hit throws the picture outward from behind the card instead
  // of lighting the card up.
  float s = (dist - mid) / (0.45 + band);
  smoke += vec3(uImpact * exp(-s * s) * 1.5);

  // The comb. `perp(flow)` is the direction *across* the local motion, so the
  // phase advances fastest at right angles to the flow and the stripes lie
  // along it. The angle comes out of the alpha the feedback pass packed.
  float flowAngle = (texture2D(uPrev, vUv).a * 2.0 - 1.0) * 3.14159265;
  vec2 across = vec2(-sin(flowAngle), cos(flowAngle));
  float comb = STRIATE_MEAN + STRIATE_AMP * sin(dot(vUv, across) * uStriate);

  gl_FragColor = vec4(
    (max(smoke, vec3(0.0)) * uDt * INJECT_RATE + max(ambient, vec3(0.0)) * uAmbientAdd) * comb,
    // Zero, and the material is blended with a source alpha factor of one so
    // that this does not scale the colour: the feedback pass's flow angle has
    // to survive this draw, and an additive pass that wrote 1 here would
    // destroy it.
    0.0);
}

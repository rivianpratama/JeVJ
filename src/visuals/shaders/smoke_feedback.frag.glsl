// Stage 1 of the smoke: advect, fade, and comb.
//
// This is the whole reason the picture looks like long-exposure smoke rather
// than like a noise field. Nothing is ever drawn twice: last frame's densities
// are re-sampled a little way *up* the flow, dimmed, and softened, and the
// result becomes this frame. Sampling backward along a divergence-free curl
// field is what produces the folding, marbled sheets.
//
// v2 adds three things to that, and each of them is one line of the reference
// images:
//
//  - **the whole field turns.** `uSpin` is an angle advanced on the CPU, and it
//    is used twice: the noise domain is rotated by it, so the *shape* of the
//    flow turns with the smoke instead of the smoke sliding through a fixed
//    field, and `uSpinRate` adds a tangential velocity about the screen centre
//    so the sheets actually orbit. "The forms rotate and fold rather than
//    translate" is this pair;
//  - **it is carried outward.** `uPushOut` is a radial velocity away from the
//    card, so smoke born at the card's feathered edge keeps going and the
//    region outside the card fills while the card's own square stays dark;
//  - **the blur is anisotropic.** A 5-tap blur *along the flow direction*
//    rather than an isotropic 4-tap: smearing along the motion and not across
//    it is exactly what a long exposure does, and it is what turns an injected
//    filament into a sheet with fine parallel striations in it.
//
// The alpha channel is not padding. This pass writes the local flow angle into
// it, because the inject pass has to comb its striations *across* the same flow
// and re-deriving the field there would cost eight more fbm evaluations per
// pixel. smoke_inject.frag unpacks it out of the alpha of its own `uPrev`.
//
// The three colour channels are three independent smokes (A/B/C) sharing one
// flow, so they separate and re-marble against each other over tens of seconds.

varying vec2 vUv;

uniform sampler2D uPrev;
uniform float uFlowAmt;
uniform float uDecay;
uniform float uTurbulence;
uniform float uPushKick;
uniform float uPushOut;
uniform float uSpin;
uniform float uSpinRate;
uniform float uTime;
uniform float uDt;
uniform float uBeatPhase;
uniform int uFlowStyle;
uniform vec2 uTexel;
uniform vec2 uCardCenter;
uniform float uCardInner;
uniform float uCardOuter;
/**
 * The frame's aspect, and it is not decoration.
 *
 * `annulusFor` hands both shaders radii in the *aspect-corrected* space — a
 * card's half-diagonal is one number only there, since in raw uv a centred
 * square is an ellipse. The inject pass has always worked in that space. This
 * one did not: it built `dist` in raw uv, so every gate written in terms of
 * `uCardInner`/`uCardOuter` was an ellipse, and on a 1.6 frame the far taper at
 * `uCardOuter + SWEEP_FADE` was never reached horizontally at all. The outward
 * sweep then ran at full strength over the whole width, which is a drain:
 * measured, the idle field fell from a mean of 0.287 at thirty seconds to 0.199
 * at a hundred and fifty. Everything below is in the corrected space, and
 * `toUv` brings the resulting velocities back.
 */
uniform float uAspect;

// How far a unit of flow moves the smoke in a second, in uv. Tuned against the
// decay: smoke has to cross a good fraction of the frame before it fades, or
// the picture stays an annulus around wherever it was injected instead of
// marbling across the whole field.
const float FLOW_SCALE = 2.0;
// The turbulence displacement is a curl in units of 1/uv; this brings it into
// the same range as the flow term.
const float TURB_SCALE = 0.004;
// How hard the second warp level is applied, calm → turbulent. Below ~2 the
// two-level warp collapses back into a one-level one and the field reads as
// bands again; past ~4.5 the sheets tear instead of folding.
const float WARP_MIN = 2.0;
const float WARP_RANGE = 2.5;
/**
 * What `uPushOut` is worth, as uv per second per unit.
 *
 * `pushOutFor` in ../smokeMath.ts hands over 0.012 at idle, and the annulus is
 * 0.18 of uv wide: without a scale the smoke would take fifteen seconds to
 * cross its own birth ring, which on screen is a stationary halo. At 6 it
 * crosses in two and a half, which is the "slow majestic rolling" of the
 * reference, and a drop's ×6 burst reaches nearly five uv a second.
 */
const float PUSH_SCALE = 6.0;
/**
 * What is left of the outward sweep well outside the annulus, and over what
 * distance it gets there.
 *
 * Both came down hard in the v2.1 pass, and the reason is that an outward
 * velocity field has positive divergence: backward advection along it makes
 * every pixel take its smoke from nearer the centre than itself, so the field
 * loses density everywhere the sweep is running and the loss leaves the frame
 * at the edge. The ambient wash is compensated for the *decay* and not for
 * transport, so that loss has nothing balancing it — measured, the idle field
 * fell 30% between thirty seconds and two and a half minutes.
 *
 * The creep only has a job inside and just outside the annulus: clear the
 * card's own square, and carry what is born on the ring away from it. Past
 * that it is a drain with no purpose, so it is taken down to a twentieth over
 * a third of the frame rather than to a quarter over most of it.
 */
const float SWEEP_FAR = 0.05;
const float SWEEP_FADE = 0.3;
/**
 * How far the 5-tap blur reaches along the flow, in texels, and its weights.
 *
 * The taps are at k·texel·(1 + 2·turbulence) for k = 1, 2 along the *flow
 * direction*, which is what makes the smear a striation rather than a blur: a
 * point becomes a streak pointing where it is going. Across the flow nothing
 * is averaged at all, so the fine parallel structure the inject pass combs in
 * survives instead of being washed out.
 */
const float TAP_1 = 1.0;
const float TAP_2 = 2.0;
const float W_CENTER = 0.4;
const float W_NEAR = 0.2;
const float W_FAR = 0.1;
/**
 * How much of the blur is isotropic rather than along the flow.
 *
 * A strictly one-dimensional blur never averages anything *across* the flow, so
 * every across-flow discontinuity — including the comb's own, whose phase is
 * not a continuous function of position where the flow direction turns quickly
 * — survives for the life of the page and is stretched into a hard ridge. The
 * sheets came out with visible edges at their boundaries.
 *
 * A fifth of the blur is a 4-tap cross at one texel, mixed in on top. That is
 * enough to soften a boundary and nowhere near enough to wash out the
 * striations, which are a quarter-amplitude modulation at 380–600 cycles across
 * the frame and are re-injected every frame besides.
 */
const float ISOTROPIC = 0.3;
/**
 * Densities are clamped to this.
 *
 * Nothing in this loop ever clears the buffer: a single non-finite value
 * written into it is advected across the frame and stays there for the life of
 * the page. The clamp kills an infinity and the equality test above it kills a
 * NaN, which no clamp can (every comparison against a NaN is false, so it
 * would pass straight through `clamp`). Both are cheap insurance on a loop
 * that has no other way back.
 */
const float MAX_DENSITY = 8.0;
/**
 * What `drift` slows the decay to.
 *
 * Named rather than written inline because the ambient wash is compensated for
 * the decay on the CPU, and the CPU has to compensate for the decay the loop
 * will actually run at — see `DRIFT_DECAY` in ../inkMath.ts, which a test reads
 * out of this line.
 */
const float DRIFT_DECAY = 0.99;

void main() {
  vec2 uv = vUv;

  // radial(uv): outward from the *card*, fading in away from it so a kick
  // pushes the field apart rather than tearing a hole at the exact centre.
  //
  // In the aspect-corrected space, where the annulus radii live and where a
  // circle is a circle. `toUv` maps a displacement back into uv, so a velocity
  // that is isotropic on screen stays isotropic on screen.
  vec2 fromCenter = (uv - uCardCenter) * vec2(uAspect, 1.0);
  vec2 toUv = vec2(1.0 / max(uAspect, 1.0e-4), 1.0);
  float dist = length(fromCenter);
  vec2 outward = dist > 1e-5 ? fromCenter / dist : vec2(0.0);
  //
  // The profile starts at the annulus rather than at the exact centre. The hot
  // cores a hit throws are supposed to radiate from the ring the smoke is born
  // on — the glowing rim around the picture — and not from a point behind it:
  // with a ramp that began at zero, the brightest streaks converged on the
  // middle of the card, which is the one part of the frame that is meant to be
  // a pool of dark.
  vec2 radial = outward * smoothstep(uCardInner * 0.5, uCardOuter, dist) * toUv;
  /**
   * The push-out's own profile, and it is not `radial`.
   *
   * `radial` ramps in over most of the frame — it is the shape a *kick* wants,
   * so a hit spreads the field apart instead of tearing a hole at the exact
   * centre. The standing outward creep wants the opposite: it is there to keep
   * the card's own square clear, so it has to be at full strength *inside* the
   * card and merely continue outside it. With the kick's profile the creep was
   * weakest exactly where it was needed, and smoke the curl carried in behind
   * the picture stayed there — measured, the card read as bright as the frame
   * around it.
   *
   * And it has to *stop*. A constant outward velocity over the whole frame is a
   * drain: the ambient wash is compensated to stand at a level under decay, not
   * under transport, so smoke pushed off the edge every frame is smoke the loop
   * never gets back. Measured, the idle field kept darkening for minutes — mean
   * 0.24 at twenty-five seconds, 0.16 at two and a half minutes. Past the
   * annulus the sweep falls away to a quarter, so it clears the card and fills
   * the frame and then leaves the frame alone.
   */
  vec2 sweep = outward
    * smoothstep(0.0, uCardInner * 0.6, dist)
    * mix(1.0, SWEEP_FAR, smoothstep(uCardOuter, uCardOuter + SWEEP_FADE, dist))
    * toUv;
  // Perpendicular to it: the direction the global rotation carries a pixel.
  vec2 tangent = vec2(-fromCenter.y, fromCenter.x) * toUv;

  // The noise domain turns with the smoke. Sampling a fixed field while the
  // smoke rotates through it would give sheets that change shape as they go
  // round; rotating the domain by the same angle is what makes a fold a fold
  // that *travels*.
  vec2 p = rot2(uSpin) * (uv - 0.5) * 2.0 + uTime * 0.05;
  // Two-level domain warp: the flow field itself has structure at every scale,
  // which is what makes the smoke fold into sheets rather than slide along.
  vec2 flow = curlWarp2(p, WARP_MIN + WARP_RANGE * clamp(uTurbulence, 0.0, 1.0), uTime);
  // The brief's decay figures are per frame at 60 Hz; raised to dt·60 they
  // mean the same thing on any display.
  float decay = uDecay;

  // The motion label, as six different ways for the same smoke to move.
  if (uFlowStyle == 0) {
    flow += vec2(0.02, 0.0);                       // flow: laminar drift
  } else if (uFlowStyle == 1) {
    flow += radial * sin(TAU * uBeatPhase) * 0.01; // pulse: breathing on the beat
  } else if (uFlowStyle == 2) {
    // shatter: 8 directions only. atan(0, 0) is undefined, and a dead-still
    // pixel in a curl field is not rare — it is every saddle point.
    float speed = length(flow);
    if (speed > 1e-8) {
      float seg = TAU / 8.0;
      float a = floor(atan(flow.y, flow.x) / seg + 0.5) * seg;
      flow = vec2(cos(a), sin(a)) * speed;
    }
  } else if (uFlowStyle == 3) {
    flow *= 0.4;                                   // drift: slow, and it lingers
    decay = DRIFT_DECAY;
  } else if (uFlowStyle == 4) {
    // swarm: the curl plus two slow orbiting vortices.
    vec2 c1 = 0.5 + 0.22 * vec2(cos(uTime * 0.11), sin(uTime * 0.11));
    vec2 c2 = 0.5 + 0.22 * vec2(cos(uTime * 0.11 + 3.14159), sin(uTime * 0.11 + 3.14159));
    vec2 d1 = uv - c1;
    vec2 d2 = uv - c2;
    vec2 swirl = vec2(-d1.y, d1.x) / (dot(d1, d1) + 0.04) + vec2(-d2.y, d2.x) / (dot(d2, d2) + 0.04);
    flow = flow * 1.6 + swirl * 0.06;
  } else if (uFlowStyle == 5) {
    flow += radial * 1.5;                          // bloom: everything outward
  }

  // The total velocity of the material, in uv per second: the curl, the global
  // rotation, and the outward creep. The advection below samples *backward*
  // along it, so a pixel takes the smoke that was upstream of it a frame ago.
  vec2 velocity = tangent * uSpinRate + sweep * uPushOut * PUSH_SCALE;

  // uv' — where this pixel's smoke came from.
  vec2 src = uv
    + flow * uFlowAmt * uDt * FLOW_SCALE
    - velocity * uDt
    + radial * uPushKick
    - curlWarped(p * 1.7 + 11.3) * uTurbulence * TURB_SCALE;

  // The blur's axis: the direction the smoke is actually going, which is the
  // curl plus the rotation plus the push. A pixel with no velocity at all —
  // every saddle point of the curl, and the exact centre — gets the horizontal,
  // which is as good as any other answer and cannot be a NaN.
  vec2 axis = flow * uFlowAmt * FLOW_SCALE + velocity;
  float speed = length(axis);
  vec2 dir = speed > 1e-8 ? axis / speed : vec2(1.0, 0.0);
  // Wider the more turbulent it is: a calm field carries a fine comb, an angry
  // one is a long smear.
  vec2 step1 = dir * uTexel * TAP_1 * (1.0 + 2.0 * clamp(uTurbulence, 0.0, 1.0));
  vec2 step2 = dir * uTexel * TAP_2 * (1.0 + 2.0 * clamp(uTurbulence, 0.0, 1.0));

  vec4 along =
      W_CENTER * texture2D(uPrev, src)
    + W_NEAR * texture2D(uPrev, src + step1)
    + W_NEAR * texture2D(uPrev, src - step1)
    + W_FAR * texture2D(uPrev, src + step2)
    + W_FAR * texture2D(uPrev, src - step2);

  // The isotropic fifth: a 4-tap cross at one texel, which is what softens a
  // sheet's boundary without touching what runs along it.
  vec4 cross4 = 0.25 * (
      texture2D(uPrev, src + vec2(uTexel.x, 0.0))
    + texture2D(uPrev, src - vec2(uTexel.x, 0.0))
    + texture2D(uPrev, src + vec2(0.0, uTexel.y))
    + texture2D(uPrev, src - vec2(0.0, uTexel.y)));

  vec4 smeared = mix(along, cross4, ISOTROPIC);

  vec4 prev = smeared * pow(decay, uDt * 60.0);

  // The scrub. `x == x` is false for a NaN and true for everything else,
  // including an infinity — which the clamp below then handles.
  if (!(prev == prev)) prev = vec4(0.0);

  // The flow angle, for the inject pass to comb across. Packed into 0..1 so it
  // survives the 8-bit fallback target on a machine with no half-float.
  float angle = atan(dir.y, dir.x);
  gl_FragColor = vec4(
    clamp(prev.rgb, vec3(0.0), vec3(MAX_DENSITY)),
    0.5 + 0.5 * angle / 3.14159265);
}

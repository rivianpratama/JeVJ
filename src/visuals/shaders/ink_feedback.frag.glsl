// Stage 1 of the ink: advect and fade what is already there.
//
// This is the whole reason the picture looks like liquid rather than like a
// noise field. Nothing is ever drawn twice: last frame's densities are
// re-sampled a little way *up* the flow, dimmed, and softened, and the result
// becomes this frame. Sampling backward along a divergence-free curl field is
// what produces the folding, marbled sheets — the ink is carried, stretched
// and folded into itself, exactly like paint under glass.
//
// The three channels are three independent inks (A/B/C) sharing one flow, so
// they separate and re-marble against each other over tens of seconds.

varying vec2 vUv;

uniform sampler2D uPrev;
uniform float uFlowAmt;
uniform float uDecay;
uniform float uTurbulence;
uniform float uPushKick;
uniform float uTime;
uniform float uDt;
uniform float uBeatPhase;
uniform int uFlowStyle;
uniform vec2 uTexel;

// How far a unit of flow moves the ink in a second, in uv. Tuned against the
// decay: ink has to cross a good fraction of the frame before it fades, or the
// picture stays an annulus around wherever the lobes were injected instead of
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
 * Named rather than written inline because the ambient wash is now compensated
 * for the decay on the CPU, and the CPU has to compensate for the decay the
 * loop will actually run at — see `DRIFT_DECAY` in ../inkMath.ts, which a test
 * reads out of this line.
 */
const float DRIFT_DECAY = 0.99;

void main() {
  vec2 uv = vUv;

  // radial(uv): outward, fading in away from the middle so a kick pushes the
  // field apart rather than tearing a hole at the exact center.
  vec2 fromCenter = uv - 0.5;
  float dist = length(fromCenter);
  vec2 radial = (dist > 1e-5 ? fromCenter / dist : vec2(0.0)) * smoothstep(0.0, 0.7, dist);

  vec2 p = uv * 2.0 + uTime * 0.05;
  // Two-level domain warp: the flow field itself has structure at every scale,
  // which is what makes the ink fold into sheets rather than slide along.
  vec2 flow = curlWarp2(p, WARP_MIN + WARP_RANGE * clamp(uTurbulence, 0.0, 1.0), uTime);
  // The brief's decay figures are per frame at 60 Hz; raised to dt·60 they
  // mean the same thing on any display.
  float decay = uDecay;

  // The motion label, as six different ways for the same ink to move.
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

  // uv' — where this pixel's ink came from.
  vec2 src = uv
    + flow * uFlowAmt * uDt * FLOW_SCALE
    + radial * uPushKick
    - curlWarped(p * 1.7 + 11.3) * uTurbulence * TURB_SCALE;

  // 4-tap blur, offset by one texel times turbulence: at turbulence 0 the taps
  // land on the same texel and nothing is blurred at all.
  vec2 o = uTexel * uTurbulence;
  vec4 center = texture2D(uPrev, src);
  vec4 blurred = 0.25 * (
      texture2D(uPrev, src + vec2(o.x, 0.0))
    + texture2D(uPrev, src - vec2(o.x, 0.0))
    + texture2D(uPrev, src + vec2(0.0, o.y))
    + texture2D(uPrev, src - vec2(0.0, o.y)));

  vec4 prev = mix(center, blurred, clamp(uTurbulence, 0.0, 1.0) * 0.6) * pow(decay, uDt * 60.0);

  // The scrub. `x == x` is false for a NaN and true for everything else,
  // including an infinity — which the clamp below then handles.
  if (!(prev == prev)) prev = vec4(0.0);
  gl_FragColor = vec4(clamp(prev.rgb, vec3(0.0), vec3(MAX_DENSITY)), 1.0);
}

// The scene mix: up to five scene textures, weighted by the director.
//
// The scenes are all *light* — ink, particles, strands, relief and breath are
// things that emit — so the mix is addition, not alpha compositing. That is
// what lets a crossfade between two layers pass through a moment where both are
// half-lit instead of one occluding the other.
//
// One exception: the dust over the ink is a screen blend, `1 − (1 − a)(1 − b)`.
// Straight addition lets a dense shell sitting over an already-bright fold of
// ink run away to white, and the shape of the shell — the thing the dust is
// for — disappears into the blowout. Screen compresses as it approaches one,
// so the shell stays legible over any ink. The strands add normally: they are
// thin, they are meant to sum where they cross, and screening them would flatten
// a curtain of four hundred veils into one.
//
// Screen is only defined on 0..1, and these buffers are HDR — the ink pushes
// its highlights past one so the bloom has something to catch. So the screen is
// taken on the clamped parts and whatever was above one is added back on top,
// which agrees with the plain formula everywhere inside the unit range and
// keeps the headroom outside it.
//
// The last two layers are the exceptions to "everything is light":
//
//  - **relief** is a *surface*. It occludes, so it composites alpha-over rather
//    than adding — added, a ridge would brighten the ink behind it and read as
//    a fog bank rather than as rock. Its opacity is its weight *squared*, gained
//    1.6 and clamped: a layer that occludes in proportion to its weight puts a
//    floor over the ink the moment the mood has any grief in it at all, and a
//    faint terrain should be a texture the ink shows through rather than a lid
//    on it. Squared, a 0.06 idle weight is 0.6% opaque (invisible, as it should
//    be), a half-share is 40%, and only a layer that has genuinely taken the
//    frame — 0.79 and up — becomes solid ground;
//  - **breath** *replaces*. It runs over a talking voice and the whole point of
//    it is that nothing else is on screen; mixed in, the dust and silk it is
//    meant to clear away would show through it. It crossfades in over the first
//    half of its weight and is the entire frame from 0.5 up. The director does
//    not switch it on at a threshold: the weight it hands over is
//    `smoothstep(0.35, 0.65, spoken) · spoken`, a ramp, so the crossfade below
//    is the second half of one continuous fade rather than the softening of a
//    step.
//
// Then one global contrast term, in linear light and before the bloom: the
// composite of five layers is brighter in its shadows than any one of them, and
// an idle frame that should read as a dark field had drifted to a pale
// lavender mid-tone. A smoothstep curve deepens the darks and holds the
// highlights where they are. It too is taken on the clamped part only — `x²(3 −
// 2x)` turns *negative* above 1.5, which on an HDR buffer would punch black
// holes through exactly the highlights the bloom is there to catch.

varying vec2 vUv;

uniform sampler2D tDiffuse; // unused: this pass generates rather than filters
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform sampler2D uTex4;
uniform float uW[5];

/** How much of the smoothstep curve is mixed in. */
const float CONTRAST = 0.35;
/** The gain on the relief's squared weight; see the note above. */
const float RELIEF_OPACITY = 1.6;
/** The breath weight at which the frame is entirely the breath. */
const float BREATH_FULL = 0.5;

vec3 screen(vec3 a, vec3 b) {
  vec3 lo = 1.0 - (1.0 - min(a, 1.0)) * (1.0 - min(b, 1.0));
  return lo + max(a - 1.0, 0.0) + max(b - 1.0, 0.0);
}

void main() {
  vec3 ink = texture2D(uTex0, vUv).rgb * uW[0];
  vec3 particles = texture2D(uTex1, vUv).rgb * uW[1];

  vec3 col = screen(ink, particles) + texture2D(uTex2, vUv).rgb * uW[2];

  // Relief: alpha-over, by its own coverage times an opacity that rises with
  // the square of its weight. The embers are inside `relief.rgb`, so they fade
  // with the terrain they sit on rather than burning through a layer that is
  // otherwise not there.
  vec4 relief = texture2D(uTex3, vUv);
  float reliefAlpha = min(uW[3] * uW[3] * RELIEF_OPACITY, 1.0);
  col = mix(col, relief.rgb, relief.a * reliefAlpha);

  // Breath: a replace that fades in, rather than a mix that never finishes.
  vec3 breath = texture2D(uTex4, vUv).rgb;
  col = mix(col, breath, clamp(uW[4] / BREATH_FULL, 0.0, 1.0));

  vec3 lo = min(col, 1.0);
  vec3 hi = max(col - 1.0, 0.0);
  col = mix(lo, lo * lo * (3.0 - 2.0 * lo), CONTRAST) + hi;

  gl_FragColor = vec4(col, 1.0);
}

/**
 * What the ink settles at, in closed form.
 *
 * The ink is a feedback loop: every frame the densities are multiplied by a
 * decay and a fresh injection is added. That makes the number on screen not
 * the injection rate but its *equilibrium*, and the two differ by up to two
 * orders of magnitude — at the idle decay of 0.99 a frame, a hundred frames'
 * worth accumulates before the loop balances. Tuning the rate by eye is
 * therefore tuning the wrong number: a rate that looks reasonable written down
 * can land the whole frame at a relative luminance of 0.003, and a rate three
 * times larger can wash it out completely.
 *
 * So the injection constants are derived from a target — "the field reads at
 * this level" — rather than chosen, and this is the arithmetic that does it.
 * It is here rather than in a test helper because it is a fact about the ink,
 * and the next scene that injects into a decaying buffer needs the same answer.
 *
 * Pure: no three.js, no DOM, no GLSL.
 */

/** Frames a second the shader's decay figures are quoted at. */
const DECAY_REFERENCE_FPS = 60;

/**
 * The density a channel settles at when `rate` units of ink a second are added
 * into a buffer that is multiplied by `decay` every 1/60 s.
 *
 * `D(n+1) = D(n)·decay^(dt·60) + rate·dt`, whose fixed point is
 * `rate·dt / (1 − decay^(dt·60))`. The `dt` cancels to first order — halving
 * the frame time halves both the injection and the loss — which is the whole
 * point of quoting injection as a rate and decay per reference frame: the
 * picture is the same on a 120 Hz display as on a 60 Hz one.
 *
 * `decay >= 1` never balances, and is returned as `Infinity`.
 */
export function inkEquilibriumDensity(rate: number, decay: number, dt = 1 / 60): number {
  if (!(decay > 0) || !(dt > 0)) return 0;
  const lost = 1 - decay ** (dt * DECAY_REFERENCE_FPS);
  if (lost <= 0) return Infinity;
  return (rate * dt) / lost;
}

/**
 * The soft knee `smoke_color.frag` samples the palette ramp through:
 * `1 − e^(−knee·d)`, so a density of 0 is the darkest stop and the ramp
 * approaches the lightest without ever clipping to it.
 *
 * `knee` is passed rather than hard-coded because the shader owns it; the
 * tests read both out of the shader source so the two cannot drift apart.
 */
export function inkLevel(density: number, knee: number): number {
  const d = density > 0 ? density : 0;
  return 1 - Math.exp(-knee * d);
}

/**
 * The knee, and the falloff on top of it that v2 adds.
 *
 * `pow(level, 1.35)` is what turns a lit field into smoke. The knee alone puts
 * most of a sheet into the mid greys, where it reads as a gradient; the power
 * pushes the mids down and leaves the cores where they were, which is the
 * reference image's "bright soft cores fading long into black". It is also the
 * single biggest reason the v2 idle field measures darker than v1's at the same
 * ambient level — see `AMBIENT_LEVEL`.
 */
export function smokeLevel(density: number, knee: number, falloff: number): number {
  const level = inkLevel(density, knee);
  return level > 0 ? level ** falloff : 0;
}

/**
 * The density the ambient veined wash is *meant* to stand at, before the vein
 * gate, the card's shadow, the striation comb, the band split and the
 * director's `injectGain`.
 *
 * It is a *target* rather than a by-product. A fixed rate is only a level once
 * you also fix the decay: the equilibrium is `rate·dt / (1 − decay^(dt·60))`, so
 * the same rate that settles here at the idle decay of 0.99 settles six times
 * lower at the 0.94 a loud section asks for. The picture went dark exactly when
 * the music got big, and darker still when the page was hidden and `dt` grew.
 *
 * **v2 re-solves it, and the direction's "ambient at half rate" is delivered
 * somewhere else.** Three v2 changes stand between this number and the screen,
 * and all three take light *out* of the wash: everything injected is multiplied
 * by the striation comb, whose mean is 0.75; the wash is gated down to 0.15
 * inside the card's own square, which is about 0.75 over the frame; and the
 * color stage's knee softened from 2.4 to 2.0 with a 1.35 falloff on top of it.
 * The two gates together are the halving — 0.56 of the wash reaches the buffer
 * — and the falloff takes more again. Halving the *level* as well would have
 * put the idle frame at a mean of 0.06 against a binding window of 0.19–0.27,
 * which is not a dark picture, it is an empty one.
 *
 * So the level is solved for the measurement rather than for the arithmetic,
 * and the measurement has moved twice. It went 2 → 7 when the two gates were
 * first accounted for, and 7 → 9 alongside `VEIN_LO` 0.52 → 0.54 when the vein
 * gate gained a floor (`VEIN_FLOOR`) and the strands gained a gamma, both of
 * which took light back out. At 9 the analytic model of the wash in
 * `tests/helpers/smokeField.ts` — the injection alone, with no advection —
 * reads a mean of 0.231, a darkest fifth at 0.042 and a brightest twentieth at
 * 0.982.
 *
 * What none of those numbers are is a promise about the *screen*: the field
 * there is the wash folded into itself by minutes of flow, and the model above
 * is one frame of injection. It is the lever, not the reading. If the idle
 * page looks washed out or looks dead, this is the number to move, and
 * `tests/visuals/inkMath.test.ts` is what keeps it the fixed point of the loop
 * at every decay while you move it.
 */
export const AMBIENT_LEVEL = 9;

/**
 * The decay `ink_feedback.frag` substitutes for the director's under the
 * `drift` motion, which is the one flow style that overrides it. The ambient
 * compensation has to use the decay the loop will actually run at, so the two
 * are pinned together by a test that reads the shader's own constant.
 */
export const DRIFT_DECAY = 0.99;

/**
 * How much ambient ink to add this frame so that the field stands at `level`
 * whatever the decay and whatever the frame took.
 *
 * Inverting `inkEquilibriumDensity`: the loop settles where what is added
 * equals what is lost, and what is lost in a frame is `D·(1 − decay^(dt·60))`.
 * Adding exactly that much makes `level` the fixed point — for any `dt`, so a
 * throttled page draws the same field as a 120 Hz one, and for any decay, so a
 * climax is no darker than an idle page.
 */
export function ambientInjectPerFrame(level: number, decay: number, dt: number): number {
  if (!(level > 0) || !(decay > 0) || !(dt > 0)) return 0;
  const lost = 1 - decay ** (dt * DECAY_REFERENCE_FPS);
  return lost > 0 ? level * lost : 0;
}

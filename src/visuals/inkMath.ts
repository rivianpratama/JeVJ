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
 * The soft knee `ink_color.frag` samples the palette ramp through:
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

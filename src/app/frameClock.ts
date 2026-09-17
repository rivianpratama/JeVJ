/**
 * The clock the visuals draw on.
 *
 * The audio clock is the right clock for everything that has to line up with
 * the music — beats, cues, the latency compensation — but it is the wrong one
 * to drive a shader's `uTime` with, for two reasons. It jumps: a seek moves it
 * by minutes in either direction. And it stalls: the visuals draw once per
 * display frame while the analyser only produces a snapshot when it has one,
 * so a repeated snapshot hands back the same timestamp and a naive `dt` of
 * zero. A frozen `uTime` stops the ink marbling and the grain moving while the
 * music plays on, which is a bug the eye notices immediately.
 *
 * So this keeps a clock of its own: monotonic, always advancing, following the
 * audio clock whenever the audio clock is behaving and the wall clock whenever
 * it is not. It is the renderer's time, not the music's — nothing timed
 * against the music may use it.
 *
 * Pure: no DOM, no three.js. The caller reads `performance.now()`.
 */

/** Neither clock moved, or one of them moved impossibly: assume 60 fps. */
const FALLBACK_STEP = 1 / 60;
/** A step longer than this is a stall or a seek, not a frame. */
const MAX_STEP = 1;

export interface FrameTick {
  /** How far to advance the simulation, always in (0, MAX_STEP]. */
  step: number;
  /** The renderer's own clock: monotonic, starts near zero. */
  time: number;
}

export interface FrameClock {
  /** One display frame. `audioTime` may repeat, jump or be NaN. */
  advance(audioTime: number, wall: number): FrameTick;
}

export function createFrameClock(): FrameClock {
  let lastAudio = Number.NaN;
  let lastWall = Number.NaN;
  let time = 0;

  return {
    advance(audioTime: number, wall: number): FrameTick {
      const wallStep = usable(wall - lastWall) ? wall - lastWall : FALLBACK_STEP;
      lastWall = wall;

      const audioStep = audioTime - lastAudio;
      // The audio clock is only believed when it moved forward by a plausible
      // frame. A repeat, a seek and a NaN all fall through to the wall clock,
      // which cannot do any of those things.
      const step = usable(audioStep) ? audioStep : wallStep;
      if (Number.isFinite(audioTime)) lastAudio = audioTime;

      time += step;
      return { step, time };
    },
  };
}

function usable(x: number): boolean {
  return Number.isFinite(x) && x > 0 && x <= MAX_STEP;
}

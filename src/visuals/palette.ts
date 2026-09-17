/**
 * The mood's color, as five stops and two singles.
 *
 * Everything on screen is colored by sampling this gradient — the ink shader
 * looks up a density and gets a color, it never picks one. That is what keeps
 * the picture from ever going flat or primary: the only colors that exist in a
 * frame are the ones on this ramp, and the ramp is one hue family with a
 * controlled rotation across it.
 *
 * The rules, all from the brief:
 *  - hue runs violet/ice → amber/crimson with `warmth`, with a nudge per genre;
 *  - chroma rises with `valence` and is pulled toward gray by `melancholy`;
 *  - the five lightness stops are stretched around the middle by `arousal`, so
 *    an excited track has deeper darks and hotter lights;
 *  - the hue rotates across the stops by ±40°·`tension`, which is what turns a
 *    calm monochrome ramp into a split-complement one when things get tense.
 *
 * The colors are **linear light**, not gamma-encoded sRGB: they are uploaded
 * as uniforms into a render chain that works in linear throughout and encodes
 * once at the end. See `oklch.ts`.
 *
 * A palette is rebuilt only when one of the six things it reads has actually
 * moved. The director calls this every frame and the mood behind it changes
 * every few seconds, so all but a handful of those calls would otherwise spend
 * seven chroma bisections producing the object they produced last frame — and
 * returning the same object also lets a consumer compare palettes by identity.
 *
 * Pure: no three.js, no DOM.
 */

import { oklchToLinearRgb } from './oklch';
import type { Genre, MoodVector } from '../shared/types';

export interface Palette {
  /** Five linear-light RGB stops, dark → light. */
  stops: [number, number, number][];
  bg: [number, number, number];
  accent: [number, number, number];
}

/** Violet/ice at warmth 0, amber/crimson at warmth 1. */
const HUE_COLD = 265;
const HUE_WARM = 35;
/** Base lightness of the five stops, before the arousal stretch. */
const BASE_L = [0.08, 0.25, 0.45, 0.68, 0.9] as const;
/** How far the hue swings from end to end of the ramp at full tension. */
const HUE_SWING_DEG = 40;
/** How dark the background sits under the darkest stop. */
const BG_DARKEN = 0.6;
const ACCENT_L = 0.8;
const ACCENT_C = 0.18;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Hue is an angle, so it is interpolated the short way round.
 *
 * This is not a detail: violet 265° → amber 35° the short way passes through
 * magenta and crimson, which is the ramp the brief describes; the long way
 * passes through teal, green and chartreuse, which are colors that appear
 * nowhere in the direction and would make a mid-warmth track read as neither
 * cold nor warm but simply green. The same applies to the pull toward 15° for
 * metal, which the long way round would send through the same greens.
 */
function lerpHue(a: number, b: number, t: number): number {
  const delta = (((b - a) % 360) + 540) % 360 - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

interface GenreNudge {
  /** Degrees added to the base hue. */
  hueOffset?: number;
  /** A hue the genre pulls toward, and how hard. */
  hueToward?: [number, number];
  /** Multiplies chroma. */
  chroma?: number;
  /** Added to every stop's lightness. */
  lift?: number;
  /** Multiplies every stop's lightness. */
  darken?: number;
}

/**
 * The brief's per-genre nudges. Jazz splits indigo/brass, classical goes
 * ivory-and-graphite, dance music goes neon, metal goes dark and red, drone
 * goes quiet.
 */
const GENRE_NUDGE: Partial<Record<Genre, GenreNudge>> = {
  jazz: { hueOffset: 25 },
  classical: { chroma: 0.6, lift: 0.08 },
  electronic_dance: { chroma: 1.3 },
  rock_metal: { hueToward: [15, 0.6], darken: 0.85 },
  ambient_drone: { chroma: 0.7 },
};

/** Everything `build` reads. Anything not in here cannot change a palette. */
interface PaletteKey {
  warmth: number;
  valence: number;
  melancholy: number;
  arousal: number;
  tension: number;
  genre: Genre;
}

/** Below this a scalar has not moved enough to be a different color. */
const SAME = 1e-4;

let cachedKey: PaletteKey | null = null;
let cached: Palette | null = null;

export function paletteFor(m: MoodVector): Palette {
  const key: PaletteKey = {
    warmth: clamp01(m.warmth),
    valence: clamp01(m.valence),
    melancholy: clamp01(m.melancholy),
    arousal: clamp01(m.arousal),
    tension: clamp01(m.tension),
    genre: m.genre,
  };
  if (cached !== null && cachedKey !== null && same(cachedKey, key)) return cached;

  cachedKey = key;
  cached = build(key);
  return cached;
}

function same(a: PaletteKey, b: PaletteKey): boolean {
  return (
    a.genre === b.genre &&
    Math.abs(a.warmth - b.warmth) < SAME &&
    Math.abs(a.valence - b.valence) < SAME &&
    Math.abs(a.melancholy - b.melancholy) < SAME &&
    Math.abs(a.arousal - b.arousal) < SAME &&
    Math.abs(a.tension - b.tension) < SAME
  );
}

function build(m: PaletteKey): Palette {
  const nudge = GENRE_NUDGE[m.genre] ?? {};

  let hue = lerpHue(HUE_COLD, HUE_WARM, clamp01(m.warmth)) + (nudge.hueOffset ?? 0);
  if (nudge.hueToward) hue = lerpHue(hue, nudge.hueToward[0], nudge.hueToward[1]);

  const chroma = lerp(0.03, 0.2, clamp01(m.valence)) * (1 - 0.5 * clamp01(m.melancholy)) * (nudge.chroma ?? 1);

  // Contrast stretch around the middle: arousal pushes the darks down and the
  // lights up without moving the mid.
  const stretch = lerp(0.7, 1.15, clamp01(m.arousal));
  const swing = HUE_SWING_DEG * clamp01(m.tension);

  const stops = BASE_L.map((base, i) => {
    let L = 0.5 + (base - 0.5) * stretch;
    L = (L + (nudge.lift ?? 0)) * (nudge.darken ?? 1);
    // −swing at the darkest stop, +swing at the lightest: the ramp opens into
    // a split-complement as tension rises.
    const h = hue + ((i / (BASE_L.length - 1)) * 2 - 1) * swing;
    return oklchToLinearRgb(clamp01(L), chroma, h);
  });

  const darkest = stops[0]!;
  return {
    stops,
    bg: [darkest[0] * BG_DARKEN, darkest[1] * BG_DARKEN, darkest[2] * BG_DARKEN],
    accent: oklchToLinearRgb(ACCENT_L, ACCENT_C, hue + 180),
  };
}

/**
 * The centre card: a square, feather-edged window onto the video.
 *
 * Square because the picture is not the point. A 16:9 frame is a *screen*, and
 * a screen in the middle of the page makes everything around it a border; a
 * square with no edge to it is an object in the smoke. The feather does the
 * work — the picture dissolves well before its box ends, so there is no rim
 * anywhere for the eye to find — and the blurred halo behind it lifts the
 * visualizer's own light around where the picture is brightest.
 *
 * **The picture is drawn, and the feather is drawn with it.** Every frame is
 * composited onto a canvas in software. The obvious way to do this is a CSS
 * `mask-image` on the box, and it does not work: a Chromium compositing a
 * moving picture — a playing video, and a canvas that redraws every frame just
 * the same — puts it on its own layer and drops any mask over it. Measured,
 * repeatedly: a hard-edged rectangle in the middle of the smoke while the same
 * page feathered correctly the instant the picture stopped moving.
 *
 * **Why fading alone was not enough.** Taking alpha away is not the same as
 * taking an edge away. A sharp frame at 20% is still a sharp frame: the
 * detail in it — a face, a caption, the horizon — keeps its contours, and the
 * eye reconstructs the square from the contours long after the brightness has
 * gone. So the frame does not merely fade out; it *goes out of focus first and
 * then fades*, which is what an object seen through smoke actually does. Two
 * layers are composited per frame:
 *
 *   A — the sharp frame, weighted `1 − smoothstep(0.25, 0.70, d)`
 *   B — the same frame under `blur(0.09 × side)`, weighted
 *       `smoothstep(0.25, 0.70, d) · (1 − smoothstep(0.55, 1.00, d))`
 *
 * over a normalized distance `d` from the middle of the card. The sum of the
 * two weights is `1 − smoothstep(0.25, 0.70, d) · smoothstep(0.55, 1.00, d)`,
 * which runs 1 → 0 with no step in the value *or in the slope* anywhere —
 * both smoothsteps are C¹, so the product is — and that second condition is
 * the one the old single gradient failed. A falloff whose slope jumps reads as
 * a boundary even when its value does not.
 *
 * The layers are added, not blended: each is masked to its own weight and the
 * second is drawn in `lighter`, so the result is `A·wA + B·wB` premultiplied,
 * with the total weight as its alpha. Nothing is clipped and nothing is
 * rounded — a `border-radius` would cut precisely the edge all of this exists
 * to dissolve. The silhouette is the mask and only the mask.
 *
 * The `<video>` itself stays out of the card and out of sight: it is where the
 * sound comes from and where the frames come from, and nothing else. It is
 * also the app's one media element: an audio file plays through the same
 * element with the card hidden, because `createMediaElementSource` may be
 * called on an element only once and the audio graph is built around it for
 * the life of the page.
 */

/** Enough for a retina card; past this the copy costs more than it shows. */
const MAX_CANVAS_PX = 1024;

/**
 * How far out of focus the outer layer is, as a fraction of the canvas side:
 * about 40px on a 440px card, which is wide enough that no feature of the
 * picture survives it as a contour.
 */
const BLUR_FRACTION = 0.09;

/** Where the sharp layer starts giving way to the blurred one, and ends. */
const MELT_IN = 0.25;
const MELT_OUT = 0.7;
/** Where the blurred layer starts leaving, and is gone. */
const FADE_IN = 0.55;
const FADE_OUT = 1;

/**
 * The exponent of the superellipse `(|x|ⁿ + |y|ⁿ)^(1/n)` the distance is
 * measured with. n = 2 is a circle and reads as a blob; n = ∞ is a square and
 * puts corners back. n = 4 is the square the design asks for with the corners
 * rounded off by the arithmetic rather than by a radius.
 */
const SILHOUETTE_EXPONENT = 4;

/** The two layer weights at one distance. They sum to the total alpha. */
export interface FeatherWeights {
  /** How much of the sharp frame survives here. */
  sharp: number;
  /** How much of the blurred frame is added here. */
  blurred: number;
}

/** Hermite `smoothstep`: 0 below `edge0`, 1 above `edge1`, C¹ throughout. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The feather at a normalized distance `d`, where 0 is the middle of the card
 * and 1 is where the picture has to be gone.
 *
 * Pure, and exported for that reason: the property that matters here — that
 * `sharp + blurred` falls from 1 to 0 without a step in value or slope — is
 * checked in `tests/ui/cardFeather.test.ts` rather than by looking at it.
 */
export function featherWeights(d: number): FeatherWeights {
  const melting = smoothstep(MELT_IN, MELT_OUT, d);
  const leaving = smoothstep(FADE_IN, FADE_OUT, d);
  return { sharp: 1 - melting, blurred: melting * (1 - leaving) };
}

/** The per-pixel weights of both layers, as alpha, for a canvas of one size. */
interface Feather {
  side: number;
  /** Alpha = the sharp layer's weight. */
  sharp: HTMLCanvasElement;
  /** Alpha = the blurred layer's weight. */
  blurred: HTMLCanvasElement;
}

/**
 * Both masks, painted pixel by pixel, once per canvas size.
 *
 * A `createRadialGradient` cannot express this: a gradient is a function of
 * *circular* distance and the silhouette is a rounded square, so the falloff
 * would arrive at the corners a diagonal later than at the edges — which is
 * exactly the old feather's failure, an edge the eye finds at the corners
 * first. Written into an `ImageData` the shape is whatever the arithmetic
 * says, and the cost is paid once and then never again while the card holds
 * its size.
 */
function buildFeather(side: number): Feather | null {
  const sharp = document.createElement('canvas');
  const blurred = document.createElement('canvas');
  sharp.width = blurred.width = side;
  sharp.height = blurred.height = side;
  const sharpCtx = sharp.getContext('2d');
  const blurredCtx = blurred.getContext('2d');
  if (!sharpCtx || !blurredCtx) return null;

  const sharpPixels = sharpCtx.createImageData(side, side);
  const blurredPixels = blurredCtx.createImageData(side, side);
  const n = SILHOUETTE_EXPONENT;
  for (let py = 0; py < side; py++) {
    const y = (2 * (py + 0.5)) / side - 1;
    const yn = Math.abs(y) ** n;
    const row = py * side * 4;
    for (let px = 0; px < side; px++) {
      const x = (2 * (px + 0.5)) / side - 1;
      const d = (Math.abs(x) ** n + yn) ** (1 / n);
      const w = featherWeights(d);
      // Alpha only: `destination-in` reads nothing else, and leaving the
      // colour at zero keeps the buffer honest about what it is.
      const at = row + px * 4 + 3;
      sharpPixels.data[at] = Math.round(w.sharp * 255);
      blurredPixels.data[at] = Math.round(w.blurred * 255);
    }
  }
  sharpCtx.putImageData(sharpPixels, 0, 0);
  blurredCtx.putImageData(blurredPixels, 0, 0);
  return { side, sharp, blurred };
}

export interface Card {
  /** The element everything plays through, picture or no picture. */
  video: HTMLVideoElement;
  /**
   * The square itself, laid out whether or not it is shown.
   *
   * The visuals read its bounding rectangle to decide where the smoke is born
   * — it is the hole the annulus goes round — and they read it even when the
   * card is hidden, because the stage is hidden with `visibility` rather than
   * `display` and the box is laid out either way. That is deliberate: an audio
   * file wants the same dark square at the middle of the frame that a video
   * would have occupied.
   */
  frame: HTMLElement;
  /** Show the square. A downloaded video has a picture; a file does not. */
  setVisible(on: boolean): void;
}

export function createCard(root: HTMLElement): Card {
  const stage = document.createElement('div');
  stage.className = 'card-stage';

  const frame = document.createElement('div');
  frame.className = 'card-frame';

  const halo = document.createElement('div');
  halo.className = 'card-halo';

  const card = document.createElement('div');
  card.className = 'card';

  const canvas = document.createElement('canvas');
  canvas.className = 'card-canvas';

  const video = document.createElement('video');
  video.className = 'card-video';
  video.playsInline = true;
  video.muted = false;
  // Our own button drives playback, and the picture never takes the pointer.
  video.controls = false;
  video.preload = 'auto';

  card.append(canvas);
  frame.append(halo, card);
  stage.append(frame);
  // Outside the stage on purpose: see the note above. It is rendered — a video
  // nobody renders is a video the compositor may stop decoding — but it is
  // eight pixels of nothing in a corner.
  root.append(stage, video);

  /**
   * `willReadFrequently` asks for a canvas backed by software rather than by
   * the GPU, and that is the point rather than a hint about reading pixels: a
   * GPU-backed canvas that redraws every frame is promoted to its own layer,
   * and a promoted layer is composited over the page without its own alpha —
   * the same hard-edged rectangle the CSS mask produced. Painted in software
   * it is ordinary page content and the feather blends the way it is drawn.
   */
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  /**
   * The two layers, held for the life of the card rather than made per frame.
   * They never reach the page, so they are free to be GPU-backed — the wide
   * blur is the one expensive thing here and this is where it happens.
   */
  const sharpLayer = document.createElement('canvas');
  const blurredLayer = document.createElement('canvas');
  const sharpCtx = sharpLayer.getContext('2d');
  const blurredCtx = blurredLayer.getContext('2d');

  let drawing = false;
  /** The masks, rebuilt only when the canvas changes size. */
  let feather: Feather | null = null;

  function featherFor(side: number): Feather | null {
    if (feather !== null && feather.side === side) return feather;
    feather = buildFeather(side);
    return feather;
  }

  /**
   * One frame of the video onto the canvas, cropped like `object-fit: cover`,
   * as the sharp layer plus the blurred layer.
   *
   * The canvas is sized to the box it is drawn in rather than to the video:
   * the feather is a fraction of the canvas, so a canvas that did not match
   * the box would fade out somewhere other than where the box says.
   *
   * The blurred layer is drawn from the *video*, not from the sharp layer: a
   * blur pulls in whatever lies beyond what it is given, and a layer copied
   * from a canvas has nothing beyond its own edge but transparency, which
   * would thin the outer picture just where it is all there is. Drawn from the
   * video the crop overflows the canvas — that is what `cover` means — and the
   * blur has real picture to reach for.
   */
  function draw(): void {
    if (!drawing) return;
    requestAnimationFrame(draw);
    if (!ctx || !sharpCtx || !blurredCtx) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    const rect = card.getBoundingClientRect();
    const side = Math.min(MAX_CANVAS_PX, Math.round(rect.width * devicePixelRatio));
    if (side < 1) return;
    if (canvas.width !== side || canvas.height !== side) {
      canvas.width = side;
      canvas.height = side;
      sharpLayer.width = blurredLayer.width = side;
      sharpLayer.height = blurredLayer.height = side;
    }
    const masks = featherFor(side);
    if (masks === null) return;

    const scale = Math.max(side / video.videoWidth, side / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    const x = (side - w) / 2;
    const y = (side - h) / 2;

    // `copy` rather than `source-over` throughout: every one of these buffers
    // still holds the previous frame with its edges already eaten away, and
    // drawing over that would leave the old alpha underneath the new picture.
    sharpCtx.globalCompositeOperation = 'copy';
    sharpCtx.filter = 'none';
    sharpCtx.drawImage(video, x, y, w, h);

    blurredCtx.globalCompositeOperation = 'copy';
    blurredCtx.filter = `blur(${side * BLUR_FRACTION}px)`;
    blurredCtx.drawImage(video, x, y, w, h);
    blurredCtx.filter = 'none';

    sharpCtx.globalCompositeOperation = 'destination-in';
    sharpCtx.drawImage(masks.sharp, 0, 0);
    blurredCtx.globalCompositeOperation = 'destination-in';
    blurredCtx.drawImage(masks.blurred, 0, 0);

    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(sharpLayer, 0, 0);
    // Added, not laid over: the two weights are parts of one alpha, and
    // `source-over` would have the blurred layer hide the sharp one where they
    // overlap instead of the two summing to the falloff they describe.
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(blurredLayer, 0, 0);
  }

  return {
    video,
    frame,
    setVisible(on: boolean): void {
      stage.classList.toggle('is-on', on);
      if (on === drawing) return;
      drawing = on;
      if (on) requestAnimationFrame(draw);
      else ctx?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

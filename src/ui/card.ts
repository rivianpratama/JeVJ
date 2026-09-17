/**
 * The centre card: a square, feather-edged window onto the video.
 *
 * Square because the picture is not the point. A 16:9 frame is a *screen*, and
 * a screen in the middle of the page makes everything around it a border; a
 * square with no edge to it is an object in the smoke. The feather does the
 * work — the mask fades the picture out well before the box ends, so there is
 * no rim anywhere for the eye to find — and the blurred halo behind it lifts
 * the visualizer's own light around where the picture is brightest.
 *
 * **The picture is drawn, and the feather is drawn with it.** Every frame is
 * copied onto a canvas and then eaten away at the edges by a radial gradient
 * in `destination-out`. The obvious way to do this is a CSS `mask-image` on
 * the box, and it does not work: a Chromium compositing a moving picture — a
 * playing video, and a canvas that redraws every frame just the same — puts it
 * on its own layer and drops any mask over it. Measured, repeatedly: a
 * hard-edged rectangle in the middle of the smoke while the same page
 * feathered correctly the instant the picture stopped moving. `border-radius`
 * survives that path and a mask does not, and a rounded rectangle is not the
 * design.
 *
 * Doing it in the pixels costs one gradient fill a frame, is the same
 * arithmetic the CSS mask describes — the falloff below is that gradient,
 * inverted, over the same farthest-corner radius — and cannot be second-
 * guessed by a compositor. The `<video>` itself stays out of the card and out
 * of sight: it is where the sound comes from and where the frames come from,
 * and nothing else.
 *
 * The `<video>` is also the app's one media element: an audio file plays
 * through the same element with the card hidden, because
 * `createMediaElementSource` may be called on an element only once and the
 * audio graph is built around it for the life of the page.
 */

/** Enough for a retina card; past this the copy costs more than it shows. */
const MAX_CANVAS_PX = 1024;

/**
 * The feather, as the alpha the *eraser* paints: the complement of the mask in
 * the design, over a radius of the box's half-diagonal, which is what
 * `radial-gradient(circle, …)` means by 100% on a square.
 */
const FEATHER = [
  [0.4, 0],
  [0.62, 0.45],
  [0.82, 0.85],
  [1, 1],
] as const;
const FEATHER_RADIUS = Math.SQRT1_2;

export interface Card {
  /** The element everything plays through, picture or no picture. */
  video: HTMLVideoElement;
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
   * The copy is a few hundred pixels square; the CPU can afford it.
   */
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let drawing = false;
  /** The eraser, rebuilt only when the canvas changes size. */
  let feather: CanvasGradient | null = null;
  let featherFor = 0;

  /** The eraser for a canvas of `side` pixels, built once per size. */
  function eraserFor(side: number): CanvasGradient | null {
    if (!ctx) return null;
    if (feather !== null && featherFor === side) return feather;
    const half = side / 2;
    const g = ctx.createRadialGradient(half, half, 0, half, half, side * FEATHER_RADIUS);
    for (const [at, alpha] of FEATHER) g.addColorStop(at, `rgba(0, 0, 0, ${alpha})`);
    feather = g;
    featherFor = side;
    return g;
  }

  /**
   * One frame of the video onto the canvas, cropped like `object-fit: cover`.
   *
   * The canvas is resized to the box it is drawn in rather than to the video:
   * the feather is a fraction of the canvas, so a canvas that did not match
   * the square would fade out somewhere other than where the square ends.
   * `copy` rather than `source-over`, because the frame before it has already
   * had its edges eaten away and drawing over it would leave them there.
   */
  function draw(): void {
    if (!drawing) return;
    requestAnimationFrame(draw);
    if (!ctx || video.readyState < 2 || video.videoWidth === 0) return;

    const rect = card.getBoundingClientRect();
    const side = Math.min(MAX_CANVAS_PX, Math.round(rect.width * devicePixelRatio));
    if (side < 1) return;
    if (canvas.width !== side || canvas.height !== side) {
      canvas.width = side;
      canvas.height = side;
    }

    const scale = Math.max(side / video.videoWidth, side / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(video, (side - w) / 2, (side - h) / 2, w, h);

    const eraser = eraserFor(side);
    if (eraser === null) return;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = eraser;
    ctx.fillRect(0, 0, side, side);
  }

  return {
    video,
    setVisible(on: boolean): void {
      stage.classList.toggle('is-on', on);
      if (on === drawing) return;
      drawing = on;
      if (on) requestAnimationFrame(draw);
      else ctx?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

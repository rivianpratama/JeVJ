import { describe, expect, it } from 'vitest';
import { coverDrawingBuffer, outputViewport } from '../../src/visuals/post/Composer';

/**
 * As much of a renderer as the viewport guard touches, with a viewport that
 * something else has already moved.
 *
 * That "something else" is the whole point: every pass in the chain binds a
 * render target of its own — the scenes at half the frame, the bloom's five
 * mips down to 34 px, the afterimage's feedback pair — and each bind leaves the
 * GL viewport at that target's size. What puts it back is three restoring the
 * renderer's *stored* size when the last pass binds the default framebuffer,
 * and that stored size comes from `setSize`, not from the canvas. Nothing in
 * the chain guarantees the two still agree.
 */
function fakeRenderer(o: {
  buffer: [number, number];
  ratio: number;
  /** Where the last internal target left the viewport, in device pixels. */
  leftAt: [number, number];
}): {
  domElement: { width: number; height: number };
  getPixelRatio(): number;
  setViewport(x: number, y: number, w: number, h: number): void;
  /** The viewport in device pixels, as GL would have it. */
  devicePixels(): [number, number];
} {
  let viewport: [number, number] = [o.leftAt[0] / o.ratio, o.leftAt[1] / o.ratio];
  return {
    domElement: { width: o.buffer[0], height: o.buffer[1] },
    getPixelRatio: () => o.ratio,
    setViewport(_x, _y, w, h): void {
      viewport = [w, h];
    },
    devicePixels: () => [
      Math.floor(viewport[0] * o.ratio),
      Math.floor(viewport[1] * o.ratio),
    ],
  };
}

describe('outputViewport', () => {
  it('is the whole drawing buffer, expressed in the CSS pixels setViewport takes', () => {
    expect(outputViewport(2160, 1350, 1.5)).toEqual([1440, 900]);
    expect(outputViewport(1500, 1050, 1.5)).toEqual([1000, 700]);
    expect(outputViewport(1440, 900, 1)).toEqual([1440, 900]);
  });

  it('treats a nonsense pixel ratio as 1 rather than dividing by it', () => {
    // A ratio of 0 would make the viewport infinite and a NaN one would make it
    // nothing; both are a black canvas, which is the failure this guards.
    expect(outputViewport(800, 600, 0)).toEqual([800, 600]);
    expect(outputViewport(800, 600, Number.NaN)).toEqual([800, 600]);
    expect(outputViewport(800, 600, -2)).toEqual([800, 600]);
  });

  it('never returns a zero-sized viewport for a buffer that has not been sized yet', () => {
    expect(outputViewport(0, 0, 1.5)).toEqual([1 / 1.5, 1 / 1.5]);
  });
});

describe('coverDrawingBuffer', () => {
  it('restores the full buffer whatever an internal target left behind', () => {
    // The caps are the sizes the chain's own targets run at: the scenes at half
    // the frame, the bloom base at half of that, its smallest mip at 34 px —
    // and, above the buffer, a target nothing capped at all. The output pass
    // has to cover the drawing buffer after every one of them.
    for (const buffer of [
      [2160, 1350],
      [2880, 1620],
      [1500, 1050],
    ] as const) {
      for (const cap of [34, 512, 1080, 2160, 4096, 8192]) {
        const aspect = buffer[1] / buffer[0];
        const r = fakeRenderer({
          buffer: [buffer[0], buffer[1]],
          ratio: 1.5,
          leftAt: [Math.min(cap, buffer[0]), Math.min(cap * aspect, buffer[1])],
        });
        coverDrawingBuffer(r);
        expect(r.devicePixels(), `buffer ${buffer.join('x')} after a ${cap}px target`).toEqual([
          buffer[0],
          buffer[1],
        ]);
      }
    }
  });

  it('agrees with the drawing buffer at every pixel ratio the governor can pick', () => {
    for (const ratio of [1, 1.25, 1.5, 2]) {
      const buffer: [number, number] = [Math.round(1440 * ratio), Math.round(900 * ratio)];
      const r = fakeRenderer({ buffer, ratio, leftAt: [64, 40] });
      coverDrawingBuffer(r);
      expect(r.devicePixels(), `ratio ${ratio}`).toEqual(buffer);
    }
  });
});

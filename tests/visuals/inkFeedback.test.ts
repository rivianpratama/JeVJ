import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLOW_STYLE, InkFeedback } from '../../src/visuals/scenes/InkFeedback';
import { MOTIONS } from '../../src/shared/types';

/**
 * As much of a WebGLRenderer as the ink touches, recording every draw.
 *
 * The scene allocates real `WebGLRenderTarget`s — they are plain objects until
 * something tries to draw with them — so everything about *which* buffer is
 * written, and with what bound to it, is observable in Node.
 */
function fakeRenderer(): {
  autoClear: boolean;
  extensions: { has: () => boolean };
  setRenderTarget(t: THREE.WebGLRenderTarget | null): void;
  render(scene: THREE.Scene): void;
  draws: { target: THREE.WebGLRenderTarget | null; scene: THREE.Scene }[];
} {
  const draws: { target: THREE.WebGLRenderTarget | null; scene: THREE.Scene }[] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  return {
    autoClear: true,
    extensions: { has: () => true },
    setRenderTarget(t): void {
      target = t;
    },
    render(scene): void {
      draws.push({ target, scene });
    },
    draws,
  };
}

/** What a draw had bound as its source density, if anything. */
function sourceOf(scene: THREE.Scene): unknown {
  const mesh = scene.children[0] as THREE.Mesh | undefined;
  const material = mesh?.material as THREE.ShaderMaterial | undefined;
  return material?.uniforms['uPrev']?.value ?? null;
}

describe('FLOW_STYLE', () => {
  it('numbers the motions in the order ink_feedback.frag branches on', () => {
    // `uFlowStyle` is an int the shader compares against literals 0..5. The
    // mapping is derived from MOTIONS, so reordering that array silently
    // rewires every motion to a different flow — this pins the two together.
    expect(MOTIONS).toEqual(['flow', 'pulse', 'shatter', 'drift', 'swarm', 'bloom']);
    expect(FLOW_STYLE).toEqual({
      flow: 0,
      pulse: 1,
      shatter: 2,
      drift: 3,
      swarm: 4,
      bloom: 5,
    });
  });

  it('has an index for every motion the director can ask for', () => {
    for (const m of MOTIONS) expect(FLOW_STYLE[m]).toBeTypeOf('number');
  });
});

describe('InkFeedback across a resize', () => {
  it('carries the field into the new buffers instead of starting from black', () => {
    // The ink is a feedback loop with no source but itself, so a fresh target
    // is a black frame. That is invisible at 60 fps and ruinous on a page the
    // browser has throttled: the pixel-ratio governor steps down mid-track, the
    // scenes are resized under it, and the field spends tens of seconds
    // climbing back out of the ambient wash — which is the almost-black climax
    // this test exists for.
    const r = fakeRenderer();
    const ink = new InkFeedback();
    ink.init(r as unknown as THREE.WebGLRenderer, 64, 40);
    const before = ink.densityTexture();
    expect(before).not.toBeNull();

    r.draws.length = 0;
    // What a 1.5 → 1.0 pixel-ratio step does to a 1440×900 canvas.
    ink.resize(48, 30);

    expect(r.draws).toHaveLength(1);
    const carry = r.draws[0]!;
    expect(carry.target?.width).toBe(48);
    expect(carry.target?.height).toBe(30);
    // Into the buffer the loop will read next, from the one it was reading.
    expect(carry.target?.texture).toBe(ink.densityTexture());
    expect(sourceOf(carry.scene)).toBe(before);
    ink.dispose();
  });

  it('leaves the buffers alone when the size has not moved', () => {
    const r = fakeRenderer();
    const ink = new InkFeedback();
    ink.init(r as unknown as THREE.WebGLRenderer, 64, 40);
    const before = ink.densityTexture();

    r.draws.length = 0;
    ink.resize(64, 40);
    ink.resize(64.4, 40.9);

    expect(r.draws).toHaveLength(0);
    expect(ink.densityTexture()).toBe(before);
    ink.dispose();
  });

  it('has nothing to carry the first time, and says so by not drawing', () => {
    const r = fakeRenderer();
    const ink = new InkFeedback();
    ink.init(r as unknown as THREE.WebGLRenderer, 64, 40);
    expect(r.draws).toHaveLength(0);
    ink.dispose();
  });
});

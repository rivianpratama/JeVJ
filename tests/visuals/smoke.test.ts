import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FILAMENT_SLOTS, FLOW_STYLE, Smoke } from '../../src/visuals/scenes/Smoke';
import { MOTIONS } from '../../src/shared/types';
import carryFrag from '../../src/visuals/shaders/smoke_carry.frag.glsl?raw';
import colorFrag from '../../src/visuals/shaders/smoke_color.frag.glsl?raw';
import feedbackFrag from '../../src/visuals/shaders/smoke_feedback.frag.glsl?raw';
import injectFrag from '../../src/visuals/shaders/smoke_inject.frag.glsl?raw';
import smokeSource from '../../src/visuals/scenes/Smoke.ts?raw';
import type { FastFrame, RenderParams } from '../../src/visuals/director';

/**
 * As much of a WebGLRenderer as the smoke touches, recording every draw.
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
  it('numbers the motions in the order smoke_feedback.frag branches on', () => {
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

describe('Smoke across a resize', () => {
  it('carries the field into the new buffers instead of starting from black', () => {
    // The smoke is a feedback loop with no source but itself, so a fresh target
    // is a black frame. That is invisible at 60 fps and ruinous on a page the
    // browser has throttled: the pixel-ratio governor steps down mid-track, the
    // scenes are resized under it, and the field spends tens of seconds
    // climbing back out of the ambient wash — which is the almost-black climax
    // this test exists for.
    const r = fakeRenderer();
    const smoke = new Smoke();
    smoke.init(r as unknown as THREE.WebGLRenderer, 64, 40);
    const before = smoke.densityTexture();
    expect(before).not.toBeNull();

    r.draws.length = 0;
    // What a 1.5 → 1.0 pixel-ratio step does to a 1440×900 canvas.
    smoke.resize(48, 30);

    expect(r.draws).toHaveLength(1);
    const carry = r.draws[0]!;
    expect(carry.target?.width).toBe(48);
    expect(carry.target?.height).toBe(30);
    // Into the buffer the loop will read next, from the one it was reading.
    expect(carry.target?.texture).toBe(smoke.densityTexture());
    expect(sourceOf(carry.scene)).toBe(before);
    smoke.dispose();
  });

  it('leaves the buffers alone when the size has not moved', () => {
    const r = fakeRenderer();
    const smoke = new Smoke();
    smoke.init(r as unknown as THREE.WebGLRenderer, 64, 40);
    const before = smoke.densityTexture();

    r.draws.length = 0;
    smoke.resize(64, 40);
    smoke.resize(64.4, 40.9);

    expect(r.draws).toHaveLength(0);
    expect(smoke.densityTexture()).toBe(before);
    smoke.dispose();
  });

  it('has nothing to carry the first time, and says so by not drawing', () => {
    const r = fakeRenderer();
    const smoke = new Smoke();
    smoke.init(r as unknown as THREE.WebGLRenderer, 64, 40);
    expect(r.draws).toHaveLength(0);
    smoke.dispose();
  });
});

describe('the smoke shaders and the scene agree', () => {
  /**
   * Every `uName` a source reads, and every one it declares. Comments are cut
   * first: a doc comment naming a uniform in prose is not a read of it.
   */
  function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  }
  function used(src: string): Set<string> {
    return new Set(code(src).match(/\bu[A-Z]\w*/g) ?? []);
  }
  function declared(src: string): Set<string> {
    const out = new Set<string>();
    for (const m of src.matchAll(/uniform\s+\w+\s+(u\w+)\s*(\[\d+\])?\s*;/g)) out.add(m[1]!);
    return out;
  }

  const SOURCES: [string, string][] = [
    ['smoke_feedback', feedbackFrag],
    ['smoke_inject', injectFrag],
    ['smoke_color', colorFrag],
    ['smoke_carry', carryFrag],
  ];

  it('measures its distances in the aspect-corrected space in both passes', () => {
    // `annulusFor` hands over radii divided by the frame *height*, which is the
    // aspect-corrected space. Both passes gate on those radii, so both have to
    // build their distance in the same space — the feedback pass did not, and
    // the far taper of its outward sweep was therefore never reached
    // horizontally: the sweep ran at full strength over the whole width and
    // drained the field over minutes.
    for (const [name, src] of [
      ['smoke_feedback', feedbackFrag],
      ['smoke_inject', injectFrag],
    ] as const) {
      const body = code(src);
      // The one line where the centre offset is taken, and it must carry the
      // aspect on it.
      const offset = /uCardCenter[^;]*vec2\(\s*uAspect\s*,\s*1\.0\s*\)/.exec(body);
      expect(offset, `${name} must take its card offset in the aspect-corrected space`).not.toBeNull();
      expect(declared(src).has('uAspect'), `${name} must declare uAspect`).toBe(true);
    }
    // And the scene has to actually feed it to both of them.
    expect(smokeSource).toMatch(/feedbackMat\.uniforms\['uAspect'\]!\.value = width \/ height/);
    expect(smokeSource).toMatch(/injectMat\.uniforms\['uAspect'\]!\.value = width \/ height/);
  });

  it('declares every uniform its own source reads', () => {
    // The failure this catches is silent on every machine that has ever run
    // the app: an undeclared identifier is a compile error the driver reports
    // to a console nobody is reading, and the scene renders black.
    for (const [name, src] of SOURCES) {
      for (const u of used(src)) {
        expect(declared(src), `${name} reads ${u}`).toContain(u);
      }
    }
  });

  it('declares every uniform the scene sets', () => {
    // The other direction, and the one that actually bit: a uniform set in TS
    // that the shader does not have is silently dropped by three, so a whole
    // mechanism — the spin, the annulus — is simply absent with no error
    // anywhere.
    const smoke = new Smoke();
    smoke.init(fakeRenderer() as unknown as THREE.WebGLRenderer, 64, 40);
    const scene = smoke as unknown as {
      feedbackMat: THREE.ShaderMaterial;
      injectMat: THREE.ShaderMaterial;
      colorMat: THREE.ShaderMaterial;
    };
    const pairs: [string, THREE.ShaderMaterial, string][] = [
      ['smoke_feedback', scene.feedbackMat, feedbackFrag],
      ['smoke_inject', scene.injectMat, injectFrag],
      ['smoke_color', scene.colorMat, colorFrag],
    ];
    for (const [name, mat, src] of pairs) {
      const decl = declared(src);
      for (const u of Object.keys(mat.uniforms)) {
        expect(decl, `${name} is set ${u}`).toContain(u);
      }
    }
    smoke.dispose();
  });

  it('leaves the flow angle in the alpha the inject pass reads back', () => {
    // The two halves of one mechanism, in two files: the feedback pass packs
    // the local flow direction into alpha, and the inject pass unpacks it to
    // comb its striations across the flow. Neither would fail loudly if the
    // other changed — the picture would simply lose its striations.
    expect(feedbackFrag).toMatch(/gl_FragColor = vec4\([\s\S]*0\.5 \+ 0\.5 \* angle/);
    expect(injectFrag).toContain('texture2D(uPrev, vUv).a * 2.0 - 1.0');
    // And the inject pass must not write over it: a source alpha factor of one
    // would put its own 0 into the channel. See the CustomBlending in Smoke.ts.
    expect(smokeSource).toContain('blendSrcAlpha: THREE.ZeroFactor');
    expect(smokeSource).toContain('blendDstAlpha: THREE.OneFactor');
  });

  it('smears along the flow with the weights the direction specifies', () => {
    // [.1, .2, .4, .2, .1], at one and two texels along `dir`.
    expect(feedbackFrag).toContain('const float W_CENTER = 0.4;');
    expect(feedbackFrag).toContain('const float W_NEAR = 0.2;');
    expect(feedbackFrag).toContain('const float W_FAR = 0.1;');
    expect(feedbackFrag).toContain('const float TAP_1 = 1.0;');
    expect(feedbackFrag).toContain('const float TAP_2 = 2.0;');
    // Five taps along `dir`, plus the 4-tap isotropic cross that is mixed in at
    // `ISOTROPIC` to soften a sheet's boundary — nine in all, and no more.
    expect(feedbackFrag).toContain('const float ISOTROPIC = 0.3;');
    expect((feedbackFrag.match(/texture2D\(uPrev, src/g) ?? []).length).toBe(9);
    // The cross is a cross: two taps on each axis, at one texel.
    expect((feedbackFrag.match(/src [+-] vec2\(uTexel\.x, 0\.0\)/g) ?? []).length).toBe(2);
    expect((feedbackFrag.match(/src [+-] vec2\(0\.0, uTexel\.y\)/g) ?? []).length).toBe(2);
  });
});

describe('Smoke filaments', () => {
  const PARAMS = {
    spinRate: 0.2,
    striate: 400,
    pushOut: 0.012,
    spin: 0,
    palette: {
      stops: [0, 1, 2, 3, 4].map(() => [0.5, 0.5, 0.5]),
      bg: [0, 0, 0],
      accent: [1, 1, 1],
    },
  } as unknown as RenderParams;

  function frame(over: Partial<FastFrame> = {}): FastFrame {
    return {
      rms: 0,
      bands: new Float32Array(8),
      sub: 0,
      onset: 0,
      beatPhase: 0,
      downbeatPulse: 0,
      impact: 0,
      build: 0,
      beatConf: 0,
      regular: 0,
      ...over,
    };
  }

  /** The intensity written into each of the three filament slots. */
  function intensities(s: Smoke): number[] {
    const mat = (s as unknown as { injectMat: THREE.ShaderMaterial }).injectMat;
    return (mat.uniforms['uFilB']!.value as THREE.Vector4[]).map((v) => v.z);
  }

  function seeded(): Smoke {
    const s = new Smoke();
    s.init(fakeRenderer() as unknown as THREE.WebGLRenderer, 64, 40);
    s.setAnnulus({ cx: 0.5, cy: 0.5, inner: 0.3, outer: 0.48 });
    return s;
  }

  it('starts with nothing alight', () => {
    const s = seeded();
    s.update(1 / 60, PARAMS, frame(), 0);
    expect(intensities(s)).toEqual([0, 0, 0]);
    s.dispose();
  });

  it('seeds two on an onset and three on a hard one, and fades them', () => {
    const s = seeded();
    s.update(1 / 60, PARAMS, frame({ onset: 0.5 }), 0);
    expect(intensities(s).filter((x) => x > 0)).toHaveLength(2);

    const before = intensities(s).reduce((a, b) => a + b, 0);
    // The same onset held is one hit, not sixty a second.
    s.update(1 / 60, PARAMS, frame({ onset: 0.5 }), 1 / 60);
    expect(intensities(s).filter((x) => x > 0)).toHaveLength(2);
    expect(intensities(s).reduce((a, b) => a + b, 0)).toBeLessThan(before);

    const hard = seeded();
    hard.update(1 / 60, PARAMS, frame({ onset: 1 }), 0);
    expect(intensities(hard).filter((x) => x > 0)).toHaveLength(3);
    s.dispose();
    hard.dispose();
  });

  it('lets a filament go out rather than holding it for the life of the page', () => {
    const s = seeded();
    s.update(1 / 60, PARAMS, frame({ onset: 1 }), 0);
    for (let i = 0; i < 180; i++) s.update(1 / 60, PARAMS, frame(), i / 60);
    for (const v of intensities(s)) expect(v).toBeLessThan(1e-3);
    s.dispose();
  });

  it('seeds them on the annulus, along the way the field is turning', () => {
    const s = seeded();
    s.update(1 / 60, PARAMS, frame({ onset: 1 }), 0);
    const mat = (s as unknown as { injectMat: THREE.ShaderMaterial }).injectMat;
    const a = mat.uniforms['uFilA']!.value as THREE.Vector4[];
    const b = mat.uniforms['uFilB']!.value as THREE.Vector4[];
    for (let i = 0; i < 3; i++) {
      if (b[i]!.z <= 0) continue;
      // The start point is on the ring, in the aspect-corrected space the
      // inject shader works in.
      const r = Math.hypot(a[i]!.x, a[i]!.y);
      expect(r).toBeGreaterThanOrEqual(0.3);
      expect(r).toBeLessThanOrEqual(0.48);
      // And it goes somewhere: a zero-length filament is a dot.
      const len = Math.hypot(b[i]!.x - a[i]!.x, b[i]!.y - a[i]!.y);
      expect(len).toBeGreaterThan(0.2);
      expect(b[i]!.w).toBeCloseTo(0.004, 9);
    }
    s.dispose();
  });

  it('reuses three slots however dense the music is', () => {
    const s = seeded();
    for (let i = 0; i < 600; i++) {
      s.update(1 / 60, PARAMS, frame({ onset: i % 12 === 0 ? 1 : 0 }), i / 60);
    }
    expect(intensities(s)).toHaveLength(FILAMENT_SLOTS);
    s.dispose();
  });
});

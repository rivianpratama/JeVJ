import { describe, expect, it } from 'vitest';
import breathFrag from '../../src/visuals/shaders/breath.frag.glsl?raw';
import mirrorFrag from '../../src/visuals/shaders/mirror.frag.glsl?raw';
import commonGlsl from '../../src/visuals/shaders/common.glsl?raw';
import reliefFrag from '../../src/visuals/shaders/relief.frag.glsl?raw';
import reliefHeight from '../../src/visuals/shaders/relief_height.glsl?raw';
import reliefVert from '../../src/visuals/shaders/relief.vert.glsl?raw';
import blendFrag from '../../src/visuals/shaders/blend.frag.glsl?raw';
import strandsFrag from '../../src/visuals/shaders/strands.frag.glsl?raw';
import strandsVert from '../../src/visuals/shaders/strands.vert.glsl?raw';

/**
 * Every uniform these scenes set from TypeScript, against what the GLSL
 * declares. A shader compiles perfectly happily with a uniform nobody declared
 * — three simply drops the value on the floor — so a typo here is a feature
 * that silently does nothing, which is the failure mode these scenes are most
 * exposed to and the one a browser check is least likely to catch.
 */
function declares(src: string, names: readonly string[]): void {
  for (const u of names) {
    expect(src).toMatch(new RegExp(`uniform \\w+ ${u}(\\[\\d+\\])?;`));
  }
}

describe('relief shaders', () => {
  const vert = `${commonGlsl}\n${reliefHeight}\n${reliefVert}`;
  const frag = `${commonGlsl}\n${reliefHeight}\n${reliefFrag}`;

  it('declares every uniform the scene sets', () => {
    // The height uniforms are shared, so both stages see them.
    for (const stage of [vert, frag]) {
      declares(stage, ['uTime', 'uFreq', 'uHeight', 'uBands']);
    }
    declares(frag, [
      'uContrast',
      'uBg',
      'uStop4',
      'uEmber',
      'uAggression',
      'uSub',
      'uExposure',
      'uStep',
      'uFade',
    ]);
  });

  it('shares one height function between the displacement and the normal', () => {
    // Two copies that drift apart light a surface that is not the one on
    // screen. Neither stage may define its own.
    expect(reliefHeight).toContain('float reliefHeightAt(vec2 q)');
    expect(reliefVert).not.toContain('float reliefHeightAt');
    expect(reliefFrag).not.toContain('float reliefHeightAt');
    expect(reliefVert).toContain('reliefHeightAt(');
    expect(reliefFrag).toContain('reliefHeightAt(');
  });

  it('carries the brief"s formulas: fbm × height, bands 2–4 ridges, embers', () => {
    expect(reliefHeight).toContain('fbm(q * uFreq + uTime * FIELD_DRIFT) * uHeight');
    expect(reliefHeight).toContain('for (int k = 2; k <= 4; k++)');
    expect(reliefHeight).toContain('uBands[k] * sin(q.x * (3.0 + float(k))');
    expect(reliefFrag).toContain('mix(uBg, uStop4, pow(ndl, uContrast))');
    // Fire, not the palette's complement: see `Palette.ember`.
    expect(reliefFrag).toContain('uEmber * (vH - EMBER_FLOOR) * EMBER_GAIN * (0.5 + 0.5 * uSub)');
    expect(reliefFrag).not.toContain('uAccent');
  });

  it('matches every varying the vertex stage writes with one the fragment reads', () => {
    for (const v of ['vXZ', 'vH', 'vViewDist']) {
      expect(reliefVert).toMatch(new RegExp(`varying \\w+ ${v};`));
      expect(reliefFrag).toMatch(new RegExp(`varying \\w+ ${v};`));
    }
  });

  it('writes an alpha, because the Composer blends it over what is behind', () => {
    expect(reliefFrag).toContain('gl_FragColor = vec4(col * uExposure, fade);');
  });

  it('rakes from the upper left of the *screen*, which is behind the camera', () => {
    // The camera looks down the -z axis, so a light with a positive z points
    // out of the screen toward the viewer and flattens the terrain. Upper-left
    // on screen is -x, +y and *into* the frame.
    const m = /vec3 light = normalize\(vec3\(([^)]*)\)\)/.exec(reliefFrag);
    expect(m).not.toBeNull();
    const [x, y, z] = m![1]!.split(',').map((v) => Number(v.trim()));
    expect(x!).toBeLessThan(0);
    expect(y!).toBeGreaterThan(0);
    expect(z!).toBeLessThan(0);
    // And it stays raking: a high lamp lights the flats and pales the frame.
    expect(y! / Math.hypot(x!, y!, z!)).toBeLessThan(0.35);
  });
});

describe('breath shader', () => {
  it('declares every uniform the scene sets', () => {
    declares(breathFrag, ['uTime', 'uLevel', 'uRms', 'uAspect', 'uBg', 'uStops', 'uGrain']);
  });

  it('scales its whole output by the rate-limited level and nothing else', () => {
    // If any term were multiplied by the raw loudness after this line, the
    // per-frame cap would not be a cap on the output.
    expect(breathFrag).toContain('col *= uLevel;');
    const after = breathFrag.slice(breathFrag.indexOf('col *= uLevel;'));
    expect(after).not.toContain('uRms');
  });

  it('breathes on a six-second period and grains at the brief"s amount', () => {
    expect(breathFrag).toContain('const float GLOW_PERIOD = 6.0;');
    expect(breathFrag).toContain('uGrain');
  });
});

describe('blend', () => {
  it('composites relief alpha-over and breath as a crossfading replace', () => {
    // The relief's opacity is its weight *squared*, gained 1.6 and clamped, so
    // a faint terrain is a translucent texture over the ink and only a terrain
    // that has actually taken the frame becomes a floor that occludes it.
    expect(blendFrag).toContain('const float RELIEF_OPACITY = 1.6;');
    expect(blendFrag).toContain(
      'float reliefAlpha = min(uW[3] * uW[3] * RELIEF_OPACITY, 1.0);',
    );
    expect(blendFrag).toContain('col = mix(col, relief.rgb, relief.a * reliefAlpha);');
    expect(blendFrag).toContain('clamp(uW[4] / BREATH_FULL, 0.0, 1.0)');
  });

  it('reads the relief slot as a vec4 and uses its alpha, never its colour alone', () => {
    // The relief target is cleared to a *transparent* black, so the pixels the
    // terrain does not cover carry colour 0 at alpha 0. Compositing them by the
    // weight alone would darken the ink everywhere the terrain is not.
    expect(blendFrag).toContain('vec4 relief = texture2D(uTex3, vUv);');
    expect(blendFrag).toContain('relief.a');
    // No bare `uTex3` read that drops the alpha.
    expect(blendFrag).not.toMatch(/texture2D\(uTex3, vUv\)\.rgb/);
  });

  it('deepens the darks with a smoothstep curve, on the clamped part only', () => {
    // `x²(3 − 2x)` goes negative above 1.5, and these buffers are HDR.
    expect(blendFrag).toContain('const float CONTRAST = 0.35;');
    expect(blendFrag).toContain('vec3 lo = min(col, 1.0);');
    expect(blendFrag).toContain('col = mix(lo, lo * lo * (3.0 - 2.0 * lo), CONTRAST) + hi;');
  });
});

describe('strands', () => {
  it('uses the visibility ramp below the weight, widened for thicker ribbons', () => {
    expect(strandsFrag).toContain('const float VIS_RAMP = 0.45;');
    expect(strandsFrag).toContain('smoothstep(0.0, VIS_RAMP, uWeight - vHash)');
  });

  it('scales width and alpha per pass, so a halo can be drawn around a core', () => {
    expect(strandsVert).toMatch(/uniform float uWidthScale;/);
    expect(strandsVert).toContain('uThickness * uWidthScale');
    expect(strandsFrag).toMatch(/uniform float uAlphaScale;/);
    expect(strandsFrag).toContain('uAlphaScale');
  });
});

describe('mirror', () => {
  it('blends its figure in by a mix, so a fold count can never snap on screen', () => {
    expect(mirrorFrag).toMatch(/uniform float uMix;/);
    // The early-out is on the mix as well as the count: a pass at mix 0 must
    // cost nothing and must be bit-identical to no pass at all.
    expect(mirrorFrag).toContain('if (uFolds < 0.5 || uMix <= 0.0)');
    expect(mirrorFrag).toContain('mix(src, figure, uMix)');
  });
});

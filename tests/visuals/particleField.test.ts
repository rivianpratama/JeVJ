import { describe, expect, it } from 'vitest';
import velFrag from '../../src/visuals/shaders/particle_vel.frag.glsl?raw';
import { ATTRACTOR_INDEX } from '../../src/visuals/scenes/ParticleField';

describe('ATTRACTOR_INDEX', () => {
  it('numbers the attractors in the order particle_vel.frag branches on', () => {
    // `uAttractor` is an int the shader compares against literals; a mismatch
    // here would silently give every motion the wrong attractor.
    expect(ATTRACTOR_INDEX).toEqual({ sphere: 0, plane: 1, vortex: 2, explode: 3, swarm: 4 });
    for (const [name, i] of Object.entries(ATTRACTOR_INDEX)) {
      // The last one is the fall-through and has no comparison of its own.
      if (name === 'swarm') continue;
      expect(velFrag).toContain(`uAttractor == ${i}`);
    }
  });

  it('declares every uniform the scene sets on the velocity shader', () => {
    for (const u of [
      'uTime',
      'uDt',
      'uCurl',
      'uAttract',
      'uDrag',
      'uAttractor',
      'uRadius',
      'uForce',
      'uExplode',
      'uImpact',
      'uOnset',
      'uImpulse',
    ]) {
      expect(velFrag).toMatch(new RegExp(`uniform \\w+ ${u};`));
    }
  });
});

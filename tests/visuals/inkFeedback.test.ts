import { describe, expect, it } from 'vitest';
import { FLOW_STYLE } from '../../src/visuals/scenes/InkFeedback';
import { MOTIONS } from '../../src/shared/types';

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

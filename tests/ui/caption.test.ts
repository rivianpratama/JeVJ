import { describe, expect, it } from 'vitest';

import { analyzingCaption, READY_CAPTION } from '../../src/ui/caption';

describe('analyzingCaption', () => {
  it('is the one sentence the page says while it works', () => {
    expect(analyzingCaption(0)).toBe('analyzing track 0%');
    expect(analyzingCaption(37)).toBe('analyzing track 37%');
    expect(analyzingCaption(100)).toBe('analyzing track 100%');
  });

  it('rounds to a whole percent', () => {
    expect(analyzingCaption(36.7)).toBe('analyzing track 37%');
    expect(analyzingCaption(0.4)).toBe('analyzing track 0%');
  });

  it('never shows a number outside the bar', () => {
    expect(analyzingCaption(-20)).toBe('analyzing track 0%');
    expect(analyzingCaption(140)).toBe('analyzing track 100%');
    expect(analyzingCaption(Number.NaN)).toBe('analyzing track 0%');
  });

  it('says one word when it is done', () => {
    expect(READY_CAPTION).toBe('ready');
  });
});

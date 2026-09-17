import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/shared/tokens';

describe('estimateTokens', () => {
  it('returns 0 for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates a 640-character string between 160 and 220 tokens', () => {
    const s = 'a'.repeat(640);
    const n = estimateTokens(s);
    expect(n).toBeGreaterThanOrEqual(160);
    expect(n).toBeLessThanOrEqual(220);
  });
});

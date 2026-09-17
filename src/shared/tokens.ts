/**
 * Characters per token. Deliberately low (real English prose is ~4) because the
 * payloads we measure are compact JSON, which is dense in digits and
 * punctuation and therefore tokenizes worse than prose. Erring low keeps us
 * inside the model's budget rather than just outside it.
 */
const CHARS_PER_TOKEN = 3.2;

/** Conservative upper estimate of the token count of `s`. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

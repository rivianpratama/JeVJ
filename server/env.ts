/**
 * `.env`, read by hand.
 *
 * A key lives in one file and is read in two places — the dev plugin gets it
 * from Vite's own `loadEnv`, everything that runs outside Vite gets it here —
 * and neither is worth a dependency. The format is the one everyone writes:
 * `KEY=value`, `#` comments, optional quotes.
 */

import { readFileSync } from 'node:fs';

export function readEnvFile(path: string): Record<string, string> {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key !== '') out[key] = value;
  }
  return out;
}

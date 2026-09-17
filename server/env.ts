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

/**
 * Where the server binds, and on which port.
 *
 * Loopback by default, and that is the security decision this module makes:
 * JeVJ runs yt-dlp on whatever id it is handed and serves the result off the
 * local disk, so a default of `0.0.0.0` would put a download-anything endpoint
 * on every interface of the machine the moment someone ran `npm start` on a
 * café network. Binding it wider is a thing you say out loud, by setting
 * `HOST`.
 *
 * Pure: the environment in, the two numbers out. `server/index.ts` is a script
 * and cannot be imported without starting a server; this can.
 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 5173;

export interface ListenOptions {
  host: string;
  port: number;
}

export function listenOptions(env: Record<string, string | undefined>): ListenOptions {
  const host = (env['HOST'] ?? '').trim();
  const raw = (env['PORT'] ?? '').trim();
  // `Number('')` is 0, and 0 is a real port — the one that means "any free
  // one". An empty `PORT=` in a `.env` is a line nobody filled in, so it has to
  // be caught before the conversion rather than after it.
  const port = raw === '' ? DEFAULT_PORT : Number(raw);
  return {
    host: host === '' ? DEFAULT_HOST : host,
    // A port that is not a port is the default rather than a crash: `PORT=` in
    // a `.env` is a line someone meant to fill in, not a request for port NaN.
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT,
  };
}

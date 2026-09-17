/**
 * The app as one local process: `npm run build && npm start`.
 *
 * Development runs the same routes inside Vite (`devApiPlugin.ts`); this is
 * the other front door, and all it adds is the built `dist/` behind them. It
 * is deliberately the whole deployment story — JeVJ downloads video with
 * yt-dlp and caches gigabytes of it, which is a thing that runs on your own
 * machine and not on someone's serverless function.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentTypeFor, sendFile, sendJson } from './http';
import { readEnvFile } from './env';
import { createJevClient } from './moodHandler';
import { createRoutes } from './routes';
import { JobRunner } from './ytdlp/job';
import { nodeSpawner } from './ytdlp/spawn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const cacheDir = join(root, 'cache');

const env = { ...readEnvFile(join(root, '.env')), ...process.env };
const apiKey = env['TYPESAFE_API_KEY'] ?? '';
const port = Number(env['PORT'] ?? 5173);

mkdirSync(cacheDir, { recursive: true });

const router = createRoutes({
  // No key is a working server with one route that says so, not a server that
  // refuses to start: the visuals and the download path do not need Jev.
  jev: apiKey === '' ? null : createJevClient(apiKey),
  jobs: new JobRunner(cacheDir, nodeSpawner(), env['YT_DLP'] ?? 'yt-dlp'),
  cacheDir,
});

const server = createServer((req, res) => {
  router.handle(req, res, () => serveBuilt(req, res));
});

server.listen(port, () => {
  console.log(`JeVJ on http://localhost:${port}`);
  console.log(`cache: ${cacheDir}`);
  if (apiKey === '') console.log('no TYPESAFE_API_KEY: the mood route will answer 500');
});

/**
 * The built app: a file from `dist/`, or `index.html` for anything else.
 *
 * The fallback is what makes a reload of a deep link work in a single-page
 * app. It is not extended to paths that look like assets — a missing script
 * answered with HTML is a confusing error in the console rather than a 404.
 */
function serveBuilt(req: IncomingMessage, res: ServerResponse): void {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const pathname = safePath(req.url ?? '/');
  if (pathname !== null) {
    const path = pathname.endsWith('/') ? join(distDir, pathname, 'index.html') : join(distDir, pathname);
    if (sendFile(req, res, path, { cacheControl: cacheFor(path) })) return;
    if (contentTypeFor(path) !== 'application/octet-stream' && !path.endsWith('.html')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
  }

  if (sendFile(req, res, join(distDir, 'index.html'), { cacheControl: 'no-store' })) return;
  sendJson(res, 500, { error: 'the app has not been built; run npm run build' });
}

/** The request path, decoded, or null if it tries to leave `dist/`. */
function safePath(url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }
  const full = resolve(distDir, `.${pathname}`);
  return full === distDir || full.startsWith(distDir + sep) ? pathname : null;
}

/** Vite fingerprints what it puts in `assets/`, so that may be cached forever. */
function cacheFor(path: string): string {
  return path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store';
}

/**
 * Every route JeVJ answers, in one place and independent of where it runs.
 *
 * Vite's dev server and the built server both build this router and hand it
 * their requests, so there is no such thing as a route that works in
 * development and not after `npm run build` — the two front doors differ only
 * in what they do with a path the router does not claim.
 *
 * The mood route is the v1 handler unchanged. The rest are v2's download-first
 * pipeline: `/api/resolve` turns a pasted link into a job, `/api/job/:id`
 * reports it, and `/media/:file` serves what came out of it.
 */

import { join } from 'node:path';

import { Router, readJsonBody, sendFile, sendJson, MAX_BODY_BYTES } from './http';
import { handleMood, type JevLike } from './moodHandler';
import { isVideoId } from './ytdlp/cache';
import { JobRunner } from './ytdlp/job';
import { parseYouTubeUrl } from '../src/source/urlParse';

/** The mood payload is one small object; v1's limit, kept. */
const MOOD_BODY_BYTES = 2048;

export interface RouteDeps {
  /** The Jev client, or null when no key was configured. */
  jev: JevLike | null;
  jobs: JobRunner;
  cacheDir: string;
}

export function createRoutes(deps: RouteDeps): Router {
  const router = new Router();

  router.route('POST', '/api/mood', async (req, res) => {
    if (deps.jev === null) {
      // The key is missing, not wrong, and saying which key would be a hint we
      // owe nobody.
      sendJson(res, 500, { error: 'mood service is not configured' });
      return;
    }
    const body = await readJsonBody(req, MOOD_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return;
    }
    const result = await handleMood(body.value, { client: deps.jev });
    sendJson(res, result.status, result.json);
  });

  router.route('POST', '/api/resolve', async (req, res) => {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return;
    }
    const raw = typeof body.value === 'object' && body.value !== null ? (body.value as Record<string, unknown>) : {};
    const url = raw['url'];
    const parsed = typeof url === 'string' ? parseYouTubeUrl(url) : null;
    if (parsed === null) {
      sendJson(res, 400, { error: 'that is not a YouTube link' });
      return;
    }
    // Keyed by video id, so pasting the same track twice — with or without a
    // `t=` offset — joins the download already running.
    sendJson(res, 200, { jobId: deps.jobs.start(parsed.videoId).id });
  });

  router.route('GET', '/api/job/:id', (_req, res, ctx) => {
    const job = deps.jobs.get(ctx.params['id'] ?? '');
    if (job === undefined) {
      sendJson(res, 404, { error: 'no such job' });
      return;
    }
    sendJson(res, 200, job);
  });

  router.route('GET', '/media/:file', (req, res, ctx) => {
    const file = ctx.params['file'] ?? '';
    // The only names that exist in the cache are `<video id>.mp4`. Insisting on
    // exactly that shape is what keeps `..`, absolute paths and a percent-
    // encoded separator from ever becoming a path: there is nothing to
    // normalise, because anything but eleven id characters is already refused.
    if (!file.endsWith('.mp4') || !isVideoId(file.slice(0, -'.mp4'.length))) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // A cached download never changes, and the browser re-fetches it by range
    // on every seek.
    const sent = sendFile(req, res, join(deps.cacheDir, file), {
      contentType: 'video/mp4',
      cacheControl: 'private, max-age=3600',
    });
    if (!sent) sendJson(res, 404, { error: 'not found' });
  });

  return router;
}

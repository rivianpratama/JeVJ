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

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import {
  Router,
  isCrossOrigin,
  isJsonRequest,
  readJsonBody,
  sendFile,
  sendJson,
  MAX_BODY_BYTES,
} from './http';
import { handleMood, type JevLike } from './moodHandler';
import { handleTransition } from './transitionHandler';
import { cachedAnalysis, isVideoId, writeAnalysis } from './ytdlp/cache';
import { JobRunner } from './ytdlp/job';
import { validateTrackAnalysis } from '../src/shared/moodSchema';
import { parseYouTubeUrl } from '../src/source/urlParse';

/** The mood payload is one small object; v1's limit, kept. */
const MOOD_BODY_BYTES = 2048;
/** Four candidates, each carrying two music pages: 8 KB, as the plan sets. */
const TRANSITION_BODY_BYTES = 8 * 1024;
/**
 * An analysis record is the whole transcript of a track — forty segments, up
 * to sixty moments, every request and response body — so it is the one thing
 * we accept that is genuinely large. Four megabytes is several times the worst
 * track we have measured and still a bound.
 */
const ANALYSIS_BODY_BYTES = 4 * 1024 * 1024;

export interface RouteDeps {
  /** The Jev client, or null when no key was configured. */
  jev: JevLike | null;
  jobs: JobRunner;
  cacheDir: string;
}

/**
 * The two things every POST route here insists on before it does any work.
 *
 * These routes spawn processes and spend an API budget, and they answer on
 * localhost, where any page in the browser can reach them. A cross-origin
 * `Origin` header is a page that is not ours driving them, which is refused
 * outright; a POST that did not announce JSON is refused because a request a
 * browser can make *without* an `Origin` — a form post, an image beacon —
 * cannot set that content type, so requiring it is what closes the gap the
 * origin check leaves open.
 *
 * Returns true when the request was answered and the handler should stop.
 */
function refusedGuard(req: IncomingMessage, res: ServerResponse): boolean {
  if (isCrossOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin requests are not allowed' });
    return true;
  }
  if (!isJsonRequest(req)) {
    sendJson(res, 415, { error: 'expected content-type: application/json' });
    return true;
  }
  return false;
}

export function createRoutes(deps: RouteDeps): Router {
  const router = new Router();

  router.route('POST', '/api/mood', async (req, res) => {
    if (refusedGuard(req, res)) return;
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

  router.route('POST', '/api/transition', async (req, res) => {
    if (refusedGuard(req, res)) return;
    if (deps.jev === null) {
      sendJson(res, 500, { error: 'transition service is not configured' });
      return;
    }
    const body = await readJsonBody(req, TRANSITION_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return;
    }
    const result = await handleTransition(body.value, { client: deps.jev });
    sendJson(res, result.status, result.json);
  });

  // The analysis cache: a track that has been analyzed once is instant the
  // next time, which on a four-minute track is the difference between a
  // minute of waiting and none.
  router.route('GET', '/api/analysis/:id', (_req, res, ctx) => {
    const id = ctx.params['id'] ?? '';
    const json = isVideoId(id) ? cachedAnalysis(deps.cacheDir, id) : null;
    if (json === null) {
      sendJson(res, 404, { error: 'no analysis for that video' });
      return;
    }
    // Validated rather than forwarded: a cache file that no longer matches the
    // schema — an older version of it, a truncated write — must read as a miss
    // and be rebuilt, not arrive at the client as a timeline with holes in it.
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      sendJson(res, 404, { error: 'no analysis for that video' });
      return;
    }
    const checked = validateTrackAnalysis(parsed);
    if (!checked.ok) {
      sendJson(res, 404, { error: 'no analysis for that video' });
      return;
    }
    sendJson(res, 200, checked.value);
  });

  router.route('POST', '/api/analysis/:id', async (req, res, ctx) => {
    if (refusedGuard(req, res)) return;
    const id = ctx.params['id'] ?? '';
    if (!isVideoId(id)) {
      sendJson(res, 400, { error: 'not a video id' });
      return;
    }
    const body = await readJsonBody(req, ANALYSIS_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return;
    }
    const checked = validateTrackAnalysis(body.value);
    if (!checked.ok) {
      sendJson(res, 400, { error: checked.error });
      return;
    }
    // Stored as the validated copy, so the file can only ever hold what a
    // `GET` is willing to hand back.
    const stored = writeAnalysis(deps.cacheDir, id, JSON.stringify({ ...checked.value, videoId: id }));
    if (!stored) {
      sendJson(res, 500, { error: 'analysis could not be cached' });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  router.route('POST', '/api/resolve', async (req, res) => {
    if (refusedGuard(req, res)) return;
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

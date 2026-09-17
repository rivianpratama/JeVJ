/**
 * `POST /api/mood` in production: the front door, and nothing else.
 *
 * Everything this file does is about the edge it sits on rather than about
 * mood — the method, the size of the body, whether the key was configured,
 * and whether one caller is asking too often. The judgment itself belongs to
 * `handleMood`, which the dev middleware shares, so the two environments
 * cannot answer differently.
 *
 * The API key is read here and passed to the client; it is never echoed, never
 * logged, and never part of an error body.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { createJevClient, handleMood, type JevLike } from '../server/moodHandler';

/** The biggest payload we will look at. A `MoodInput` is about 460 bytes. */
const MAX_BODY_BYTES = 2048;
/** Per-IP budget: 20 requests a minute, which is well above the 2.5 s floor. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
/** How many callers we remember. A serverless instance is short-lived. */
const MAX_TRACKED_IPS = 1000;

interface Bucket {
  tokens: number;
  refilledAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * One token per request, refilled continuously at `RATE_LIMIT` per window.
 *
 * Per process, which on Vercel means per warm instance: this is a courtesy
 * brake against a loop that got stuck, not a security control. A real limit
 * would need shared state, and would still not be this file's job.
 */
export function takeToken(ip: string, now: number): boolean {
  const bucket = buckets.get(ip);
  if (bucket === undefined) {
    if (buckets.size >= MAX_TRACKED_IPS) buckets.clear();
    buckets.set(ip, { tokens: RATE_LIMIT - 1, refilledAt: now });
    return true;
  }
  const refill = ((now - bucket.refilledAt) / RATE_WINDOW_MS) * RATE_LIMIT;
  bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + Math.max(0, refill));
  bucket.refilledAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** The first hop of `x-forwarded-for`, which is the client the edge saw. */
export function callerIp(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const first = (raw ?? '').split(',')[0]?.trim();
  return first === undefined || first === '' ? 'unknown' : first;
}

/** Cached per process so a warm instance does not rebuild the client. */
let cached: { key: string; client: JevLike } | null = null;

function clientFor(apiKey: string): JevLike {
  if (cached === null || cached.key !== apiKey) cached = { key: apiKey, client: createJevClient(apiKey) };
  return cached.client;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!takeToken(callerIp(req.headers['x-forwarded-for']), Date.now())) {
    res.status(429).json({ error: 'too many requests' });
    return;
  }

  // `req.body` is already parsed by the runtime; measuring the re-serialized
  // form is what we can see of the raw size, and a `MoodInput` cannot grow
  // anywhere near this unless someone is attaching something to it.
  let size = 0;
  try {
    size = JSON.stringify(req.body ?? null)?.length ?? 0;
  } catch {
    res.status(400).json({ error: 'body is not JSON' });
    return;
  }
  if (size > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'payload too large' });
    return;
  }

  const apiKey = process.env['TYPESAFE_API_KEY'] ?? '';
  if (apiKey === '') {
    // Said plainly, without naming what is missing beyond the fact of it.
    res.status(500).json({ error: 'mood service is not configured' });
    return;
  }

  const result = await handleMood(req.body, { client: clientFor(apiKey) });
  res.status(result.status).json(result.json);
}

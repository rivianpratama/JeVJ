/**
 * The download cache: one mp4 per video id, plus the little we keep about it.
 *
 * The cache is addressed by video id and nothing else. Every path this module
 * builds is `<cacheDir>/<id>.<ext>` with the id checked against YouTube's own
 * shape first, so a caller cannot ask for a file outside the cache however the
 * id reached it — the routes validate too, but a directory of user-named files
 * is exactly the place not to rely on one check somewhere else.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What we remember about a video between runs. */
export interface CachedInfo {
  title?: string;
  durationSec?: number;
}

/** YouTube ids are eleven characters of a URL-safe alphabet, and nothing else. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

/** The name the cached video has on disk. */
export function mediaName(videoId: string): string {
  return `${videoId}.mp4`;
}

/** The finished download for a video, or null if there is not one. */
export function cachedMedia(cacheDir: string, videoId: string): string | null {
  if (!isVideoId(videoId)) return null;
  const path = join(cacheDir, mediaName(videoId));
  return sizeOf(path) === null ? null : path;
}

/** The size of a regular file, or null if it is missing or is not one. */
export function sizeOf(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function infoPath(cacheDir: string, videoId: string): string {
  return join(cacheDir, `${videoId}.info.json`);
}

/**
 * The title and duration saved beside a cached video.
 *
 * A cache hit must not need yt-dlp — that is the point of the cache — so the
 * first download writes this sidecar. Anything unreadable or the wrong shape
 * is simply not there: a missing title costs a caption, not a playback.
 */
export function cachedInfo(cacheDir: string, videoId: string): CachedInfo | null {
  if (!isVideoId(videoId)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(infoPath(cacheDir, videoId), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  const info: CachedInfo = {};
  if (typeof raw['title'] === 'string') info.title = raw['title'];
  if (typeof raw['durationSec'] === 'number' && Number.isFinite(raw['durationSec'])) {
    info.durationSec = raw['durationSec'];
  }
  return info;
}

/** Saves what we know about a video. Failing to write is not worth a failure. */
export function writeInfo(cacheDir: string, videoId: string, info: CachedInfo): void {
  if (!isVideoId(videoId)) return;
  try {
    writeFileSync(infoPath(cacheDir, videoId), JSON.stringify(info));
  } catch {
    // The video is downloaded; losing its title only costs the next run a
    // second of yt-dlp.
  }
}

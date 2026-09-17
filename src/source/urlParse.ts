/**
 * Turns whatever a user pastes into a video id plus a start offset.
 *
 * Accepts the shapes YouTube hands out in the wild — `watch?v=`, `youtu.be/`,
 * `/shorts/`, `/embed/`, `/live/`, `music.youtube.com`, protocol-less links —
 * and a bare 11-character id. Returns `null` for anything it cannot recognise
 * so callers can show one honest error instead of loading a broken player.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];
/** `1h2m3s`, `2m30s`, `45s` — at least one unit, in order. */
const CLOCK = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
/** Path prefixes that carry the id in the following segment. */
const PATH_KINDS = ['shorts', 'embed', 'live', 'v', 'e'];

export interface ParsedYouTubeUrl {
  videoId: string;
  startSeconds: number;
}

export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
  const raw = input.trim();
  if (raw === '') return null;
  if (VIDEO_ID.test(raw)) return { videoId: raw, startSeconds: 0 };

  const url = toUrl(raw);
  if (!url || !isYouTubeHost(url.hostname)) return null;

  const videoId = extractId(url);
  if (videoId === null) return null;

  return { videoId, startSeconds: extractStart(url) };
}

function toUrl(raw: string): URL | null {
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function extractId(url: URL): string | null {
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const first = segments[0];

  // youtu.be/<id>
  if (url.hostname.toLowerCase().replace(/^www\./, '') === 'youtu.be') {
    return first !== undefined && VIDEO_ID.test(first) ? first : null;
  }

  // /watch?v=<id> (also /watch_popup, /shorts fallback below)
  const v = url.searchParams.get('v');
  if (v !== null) return VIDEO_ID.test(v) ? v : null;

  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  if (first !== undefined && PATH_KINDS.includes(first.toLowerCase())) {
    const id = segments[1];
    return id !== undefined && VIDEO_ID.test(id) ? id : null;
  }

  return null;
}

function extractStart(url: URL): number {
  const start = parseTime(url.searchParams.get('start'));
  if (start > 0) return start;
  return parseTime(url.searchParams.get('t'));
}

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds. Anything else → 0. */
function parseTime(value: string | null): number {
  if (value === null) return 0;
  const raw = value.trim().toLowerCase();
  if (raw === '') return 0;

  if (/^\d+$/.test(raw)) return Number(raw);

  const m = CLOCK.exec(raw);
  if (!m) return 0;
  const [, h, min, s] = m;
  if (h === undefined && min === undefined && s === undefined) return 0;
  return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

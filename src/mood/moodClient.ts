/**
 * When to ask Jev, and what to do when asking goes wrong.
 *
 * A model call costs about two thousand tokens and a few hundred milliseconds,
 * and the visuals run at sixty frames a second: the only interesting question
 * here is *when not to call*. The rule is that the music decides. A track that
 * is changing earns a call every 2.5 s; a track that is sitting on one loop
 * gets one every 8 s, because asking again would buy the same answer. Novelty
 * drives that interpolation, a section change short-circuits it (a boundary is
 * exactly the moment the old answer stopped being true), and a phrase boundary
 * about a second out is worth a call *now* so the judgment lands before the
 * music does rather than after.
 *
 * It is `maybeRequest` that decides and fires, in one call, because splitting
 * them invites a caller to ask twice or to fire without asking. One request is
 * in flight at a time — the answer to "should I ask again" while a question is
 * outstanding is always no — and a server pushing back is answered with plain
 * exponential backoff rather than a retry storm.
 *
 * Every instant here is the audio clock the caller passes in, never
 * `Date.now`: a paused track and a backgrounded tab must not age the cadence.
 */

import { validateMoodVector } from '../shared/moodSchema';
import type { MoodInput, MoodResponse } from '../shared/types';

export interface MoodClientOptions {
  fetchFn?: typeof fetch;
  /** The fastest we will ever ask, in seconds. */
  minIntervalSec?: number;
  /** The slowest, when nothing is changing. */
  maxIntervalSec?: number;
  /** Quiet at the start of a track, while the analysis settles. */
  firstDelaySec?: number;
  /** Below this, novelty alone is not a reason to ask. */
  noveltyFloor?: number;
  /** Where to post. */
  endpoint?: string;
}

/** The window before a phrase boundary in which a call is worth making. */
const PREFETCH_MIN_SEC = 0.8;
const PREFETCH_MAX_SEC = 1.4;
/** First backoff after a server-side failure, in seconds, and its ceiling. */
const BACKOFF_START_SEC = 4;
const BACKOFF_MAX_SEC = 32;
/** How long we stop asking after the server says the request itself is wrong. */
const REFUSED_PAUSE_SEC = 60;

export interface MoodStats {
  calls: number;
  tokens: number;
  lastLatencyMs: number;
  errors: number;
  backoffUntil: number;
}

export class MoodClient {
  private readonly fetchFn: typeof fetch;
  private readonly minInterval: number;
  private readonly maxInterval: number;
  private readonly firstDelay: number;
  private readonly noveltyFloor: number;
  private readonly endpoint: string;

  /** Audio time of the first frame we were shown; the delay counts from it. */
  private startedAt = Number.NaN;
  /** Audio time the last request was *started* at, not answered at. */
  private lastRequestAt = -Infinity;
  /** The interval the last decision frame worked out, for `nextAllowedAt`. */
  private interval: number;
  private inFlight = false;
  private backoffUntil = -Infinity;
  private backoffSec = 0;
  private refusedLogged = false;

  private calls = 0;
  private tokens = 0;
  private lastLatencyMs = 0;
  private errors = 0;

  constructor(o: MoodClientOptions = {}) {
    this.fetchFn = o.fetchFn ?? ((...args) => fetch(...args));
    this.minInterval = o.minIntervalSec ?? 2.5;
    this.maxInterval = o.maxIntervalSec ?? 8;
    this.firstDelay = o.firstDelaySec ?? 1.5;
    this.noveltyFloor = o.noveltyFloor ?? 0.05;
    this.endpoint = o.endpoint ?? '/api/mood';
    this.interval = this.maxInterval;
  }

  /**
   * Decide, and fire if the decision is yes. Called every frame; returns a
   * promise only when a request was actually started, and that promise
   * resolves to null rather than rejecting when the request fails.
   */
  maybeRequest(
    now: number,
    input: MoodInput,
    novelty: number,
    sectionChanged: boolean,
    playing: boolean,
    visible: boolean,
    nextPhraseBoundaryIn: number | null,
  ): Promise<MoodResponse | null> | null {
    if (Number.isNaN(this.startedAt)) this.startedAt = now;
    this.interval = this.intervalFor(novelty);

    if (!playing || !visible || this.inFlight) return null;
    if (now < this.startedAt + this.firstDelay) return null;
    if (now < this.backoffUntil) return null;

    const sinceLast = now - this.lastRequestAt;
    // A boundary is worth the floor interval however little else has changed.
    const due = sinceLast >= (sectionChanged ? this.minInterval : this.interval);
    const worthIt = novelty >= this.noveltyFloor || sectionChanged || sinceLast >= this.maxInterval;

    // Ahead of a phrase boundary the answer wants to be in hand *before* the
    // bar lands, so this one ignores novelty; the floor still applies.
    const prefetch =
      nextPhraseBoundaryIn !== null &&
      nextPhraseBoundaryIn > PREFETCH_MIN_SEC &&
      nextPhraseBoundaryIn < PREFETCH_MAX_SEC &&
      sinceLast >= this.minInterval;

    if (!prefetch && !(due && worthIt)) return null;

    this.lastRequestAt = now;
    this.inFlight = true;
    return this.send(input, now);
  }

  /** The earliest audio time a request could go out, as things stand. */
  nextAllowedAt(): number {
    const first = Number.isNaN(this.startedAt) ? Infinity : this.startedAt + this.firstDelay;
    const cadence = this.lastRequestAt === -Infinity ? -Infinity : this.lastRequestAt + this.interval;
    return Math.max(first, cadence, this.backoffUntil);
  }

  stats(): MoodStats {
    return {
      calls: this.calls,
      tokens: this.tokens,
      lastLatencyMs: this.lastLatencyMs,
      errors: this.errors,
      backoffUntil: this.backoffUntil === -Infinity ? 0 : this.backoffUntil,
    };
  }

  /** `interval = clamp(max − (max − min)·novelty·2, min, max)`. */
  private intervalFor(novelty: number): number {
    const n = Number.isFinite(novelty) ? Math.max(0, Math.min(1, novelty)) : 0;
    const raw = this.maxInterval - (this.maxInterval - this.minInterval) * n * 2;
    return Math.max(this.minInterval, Math.min(this.maxInterval, raw));
  }

  private async send(input: MoodInput, now: number): Promise<MoodResponse | null> {
    try {
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });

      if (!res.ok) {
        this.fail(now, res.status);
        return null;
      }

      const body = (await res.json()) as Partial<MoodResponse>;
      const mood = validateMoodVector(body?.mood);
      if (!mood.ok) {
        // A 200 carrying something that is not a mood is the server being
        // broken, not the request being wrong: back off like a 5xx.
        this.fail(now, 500);
        return null;
      }

      this.calls += 1;
      this.tokens += (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0);
      this.lastLatencyMs = body.latencyMs ?? 0;
      this.backoffSec = 0;
      this.backoffUntil = -Infinity;
      this.refusedLogged = false;
      return { mood: mood.value, usage: body.usage ?? { input_tokens: 0, output_tokens: 0 }, latencyMs: this.lastLatencyMs };
    } catch {
      // Offline, DNS, a dropped body: indistinguishable from a bad gateway.
      this.fail(now, 0);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * `status` 0 means the request never completed. A 4xx that is not 408/429 is
   * the request itself being refused — retrying it changes nothing, so we go
   * quiet for a minute instead of hammering.
   */
  private fail(now: number, status: number): void {
    this.errors += 1;
    const refused = status >= 400 && status < 500 && status !== 429 && status !== 408;
    if (refused) {
      if (!this.refusedLogged) {
        this.refusedLogged = true;
        console.warn(`[jevj] mood request refused (${status}); pausing for ${REFUSED_PAUSE_SEC}s`);
      }
      this.backoffUntil = now + REFUSED_PAUSE_SEC;
      return;
    }
    this.backoffSec = this.backoffSec === 0 ? BACKOFF_START_SEC : Math.min(BACKOFF_MAX_SEC, this.backoffSec * 2);
    this.backoffUntil = now + this.backoffSec;
  }
}

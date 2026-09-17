/**
 * A fixed-capacity window over the most recent numbers, with the running
 * statistics the analysis layer keeps asking for.
 *
 * Every feature in this app is "compared to the last few seconds" — loudness
 * against its own recent range, flux against its own recent mean — so the
 * shape that keeps recurring is a bounded history with cheap aggregates. The
 * buffer never allocates after construction, which matters at 60 frames a
 * second.
 *
 * Index 0 is always the oldest retained value; `last()` is the newest.
 */
export class Ring {
  private readonly buf: Float32Array;
  /** Where the next value goes; also the oldest value once the ring is full. */
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`Ring capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Float32Array(capacity);
  }

  get capacity(): number {
    return this.buf.length;
  }

  get length(): number {
    return this.count;
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count += 1;
  }

  /** `i` counts from the oldest retained value. */
  at(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) {
      throw new RangeError(`Ring index ${i} is outside 0..${this.count - 1}`);
    }
    return this.buf[this.slot(i)] as number;
  }

  /** The most recently pushed value, or 0 while empty. */
  last(): number {
    return this.count === 0 ? 0 : (this.buf[this.slot(this.count - 1)] as number);
  }

  /** Aggregates answer 0 rather than NaN while empty: callers are per-frame. */
  mean(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.buf[this.slot(i)] as number;
    return sum / this.count;
  }

  min(): number {
    if (this.count === 0) return 0;
    let m = Infinity;
    for (let i = 0; i < this.count; i++) m = Math.min(m, this.buf[this.slot(i)] as number);
    return m;
  }

  max(): number {
    if (this.count === 0) return 0;
    let m = -Infinity;
    for (let i = 0; i < this.count; i++) m = Math.max(m, this.buf[this.slot(i)] as number);
    return m;
  }

  /** A fresh oldest-first copy; safe to keep. */
  toArray(): Float32Array {
    const out = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.buf[this.slot(i)] as number;
    return out;
  }

  /** Oldest-first index -> physical slot. */
  private slot(i: number): number {
    const oldest = this.count < this.buf.length ? 0 : this.head;
    return (oldest + i) % this.buf.length;
  }
}

/**
 * The same bounded history, but every value carries the audio-clock instant it
 * was measured at, and the aggregates are asked for in seconds rather than in
 * frames.
 *
 * The trackers in Task 5 all want the same thing — "the mean loudness over the
 * last three seconds", "the centroid two to six seconds ago" — and a plain
 * `Ring` cannot answer it: frames do not arrive at a fixed rate, so a count of
 * frames is not a span of time. Nothing here assumes one either; it only
 * assumes `t` never goes backwards, which the audio clock guarantees.
 *
 * Index 0 is the oldest retained sample, as in `Ring`.
 */
export class TimedRing {
  private readonly ts: Float64Array;
  private readonly vs: Float64Array;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`TimedRing capacity must be a positive integer, got ${capacity}`);
    }
    this.ts = new Float64Array(capacity);
    this.vs = new Float64Array(capacity);
  }

  get capacity(): number {
    return this.ts.length;
  }

  get length(): number {
    return this.count;
  }

  push(t: number, v: number): void {
    this.ts[this.head] = t;
    this.vs[this.head] = v;
    this.head = (this.head + 1) % this.ts.length;
    if (this.count < this.ts.length) this.count += 1;
  }

  timeAt(i: number): number {
    return this.ts[this.slot(i)] as number;
  }

  valueAt(i: number): number {
    return this.vs[this.slot(i)] as number;
  }

  /** The instant of the oldest sample still retained; NaN while empty. */
  startTime(): number {
    return this.count === 0 ? NaN : this.timeAt(0);
  }

  /** The instant of the newest sample; NaN while empty. */
  endTime(): number {
    return this.count === 0 ? NaN : this.timeAt(this.count - 1);
  }

  /**
   * The smallest index whose time is at or after `t`, or `length` when every
   * sample is older. Binary search: the times ascend.
   */
  indexAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** How many samples fall in `[from, to]`. */
  countIn(from: number, to: number): number {
    return Math.max(0, this.indexAfter(to) - this.indexAtOrAfter(from));
  }

  /** Mean of the samples in `[from, to]`, or 0 when the span holds none. */
  mean(from: number, to: number): number {
    const start = this.indexAtOrAfter(from);
    const end = this.indexAfter(to);
    if (end <= start) return 0;
    let sum = 0;
    for (let i = start; i < end; i++) sum += this.valueAt(i);
    return sum / (end - start);
  }

  /** Largest value in `[from, to]`, or `-Infinity` when the span holds none. */
  max(from: number, to: number): number {
    const start = this.indexAtOrAfter(from);
    const end = this.indexAfter(to);
    let m = -Infinity;
    for (let i = start; i < end; i++) m = Math.max(m, this.valueAt(i));
    return m;
  }

  /** The smallest index whose time is strictly after `t`. */
  private indexAfter(t: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Oldest-first index -> physical slot. */
  private slot(i: number): number {
    const oldest = this.count < this.ts.length ? 0 : this.head;
    return (oldest + i) % this.ts.length;
  }
}

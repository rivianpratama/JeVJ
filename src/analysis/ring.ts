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

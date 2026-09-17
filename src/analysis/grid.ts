/**
 * The beat grid: where the beats are, not just how fast they come.
 *
 * `estimateTempo` answers the period; this answers the phase, and keeps
 * answering it while the music drifts. It is a phase-locked loop in the
 * classical sense — a free-running oscillator that each onset nudges a little
 * toward itself — which is why it survives a missed beat, a rubato bar or a
 * singer landing early, where snapping to every onset would not.
 *
 * On top of that sits the bar: the grid remembers which position in the bar
 * keeps arriving with bass under it and calls that one the downbeat.
 *
 * Every time here is audio-clock seconds, the same clock `FrameFeatures.t`
 * uses. Nothing in this file touches the DOM.
 */

import type { Meter } from '../shared/types';
import type { TempoEstimate } from './tempo';

export interface GridState {
  bpm: number;
  period: number;
  /** Audio-clock time of the next beat the grid will emit. */
  nextBeat: number;
  /** Running count: the index `nextBeat` will be emitted with. */
  beatIndex: number;
  barLength: 3 | 4;
  /** Which `beatIndex % barLength` is the downbeat. */
  downbeatOffset: number;
  barsSinceChange: number;
  barInPhrase: number;
  confidence: number;
}

export interface Beat {
  t: number;
  downbeat: boolean;
  index: number;
}

const DEFAULT_BPM = 120;
const DEFAULT_BAR_LENGTH = 4;

/** How hard an onset pulls the grid toward itself: a third of the error. */
const PULL = 0.3;
/** An onset further than this fraction of a period away belongs to no beat. */
const CAPTURE_WINDOW = 0.15;
/** A tempo this much off the current one is a new tempo, not a re-measure. */
const RE_ANCHOR_RATIO = 0.08;
/** What last bar's downbeat evidence is worth once a bar has gone by. */
const BAR_DECAY = 0.9;
/** Beyond this the accumulator has forgotten everything anyway. */
const MAX_DECAY_BARS = 16;
/** Phrases are sixteen bars until something says otherwise. */
const PHRASE_BARS = 16;
/** A tab left in the background can leave a huge gap; do not grind through it. */
const MAX_BEATS_PER_TICK = 1024;
/** How fast the "is this onset a strong one" reference forgets. */
const STRENGTH_DECAY = 0.9;

export class BeatGrid {
  private bpm = DEFAULT_BPM;
  private period = 60 / DEFAULT_BPM;
  private nextBeat = 0;
  private beatIndex = 0;
  private barLength: 3 | 4 = DEFAULT_BAR_LENGTH;
  private confidence = 0;
  private started = false;

  /** Low-band evidence per position in the bar, decayed once per bar. */
  private evidence = new Float64Array(DEFAULT_BAR_LENGTH);
  private evidenceBar = 0;
  private downbeatOffset = 0;

  private barsSinceChange = 0;

  private strengthReference = 0;
  private lastStrongOnset: number | null = null;

  /**
   * A fresh estimate. The phase is kept — a re-measurement of the same tempo
   * must not restart the bar — unless the tempo really moved, in which case
   * the old phase is meaningless and the grid re-anchors to the last strong
   * onset it saw.
   */
  setTempo(e: TempoEstimate, now: number): void {
    const jumped = !this.started || Math.abs(e.bpm - this.bpm) > RE_ANCHOR_RATIO * this.bpm;

    this.bpm = e.bpm;
    this.period = e.period > 0 ? e.period : 60 / e.bpm;
    this.confidence = e.confidence;

    if (!jumped) return;
    const anchor = this.lastStrongOnset ?? now;
    this.nextBeat = anchor + this.period;
    // The anchor may be well behind `now`; keep its phase, move it forward.
    if (this.nextBeat <= now) {
      this.nextBeat += Math.ceil((now - this.nextBeat) / this.period) * this.period;
    }
    this.started = true;
  }

  /** Triple time counts in threes; everything else, including doubt, in fours. */
  setMeter(m: Meter): void {
    const length = m === 'triple' ? 3 : 4;
    if (length === this.barLength) return;
    this.barLength = length;
    // The old evidence was collected in a different bar: it means nothing now.
    this.evidence = new Float64Array(length);
    this.downbeatOffset = 0;
  }

  /**
   * Every onset, whether or not it looks like a beat. `strength` is the onset
   * detector's detection value and `low` its bass share — the vote this onset
   * casts for its position in the bar being the downbeat.
   */
  onOnset(t: number, strength: number, low: number): void {
    // A "strong" onset is one at least as big as the recent run of them; the
    // grid re-anchors to those and ignores the rest.
    if (strength >= this.strengthReference) this.lastStrongOnset = t;
    this.strengthReference = this.strengthReference * STRENGTH_DECAY + strength * (1 - STRENGTH_DECAY);

    if (!this.started) return;

    const steps = Math.round((t - this.nextBeat) / this.period);
    const nearest = this.nextBeat + steps * this.period;
    const error = t - nearest;
    if (Math.abs(error) >= CAPTURE_WINDOW * this.period) return;

    this.nextBeat += PULL * error;
    this.vote(this.beatIndex + steps, low);
  }

  /**
   * The beats between the last call and `now`, oldest first. Called every
   * frame; usually returns nothing, which is the point — the caller does not
   * have to work out for itself whether a beat went by.
   */
  tick(now: number): Beat[] {
    const out: Beat[] = [];
    if (!this.started) return out;

    let guard = 0;
    while (this.nextBeat <= now && guard < MAX_BEATS_PER_TICK) {
      out.push({ t: this.nextBeat, downbeat: this.isDownbeat(this.beatIndex), index: this.beatIndex });
      if (this.isDownbeat(this.beatIndex)) this.barsSinceChange += 1;
      this.nextBeat += this.period;
      this.beatIndex += 1;
      guard += 1;
    }

    if (this.nextBeat <= now) {
      // Something stalled the loop for minutes. Skip forward silently rather
      // than firing a thousand beats at once.
      const skipped = Math.ceil((now - this.nextBeat) / this.period);
      this.nextBeat += skipped * this.period;
      this.beatIndex += skipped;
    }
    return out;
  }

  /** The next `count` beats strictly after `now` — what to schedule against. */
  predict(count: number, now: number): Array<{ t: number; downbeat: boolean }> {
    const out: Array<{ t: number; downbeat: boolean }> = [];
    if (!this.started) return out;

    // The epsilon keeps a beat that lands exactly on `now` from being
    // predicted again after floating point rounds the division down.
    const first = Math.max(0, Math.floor((now - this.nextBeat) / this.period + 1e-6) + 1);
    for (let i = 0; i < count; i++) {
      const step = first + i;
      out.push({ t: this.nextBeat + step * this.period, downbeat: this.isDownbeat(this.beatIndex + step) });
    }
    return out;
  }

  /** A new section starts the phrase count again. */
  markSectionChange(_now: number): void {
    this.barsSinceChange = 0;
  }

  state(): GridState {
    return {
      bpm: this.bpm,
      period: this.period,
      nextBeat: this.nextBeat,
      beatIndex: this.beatIndex,
      barLength: this.barLength,
      downbeatOffset: this.downbeatOffset,
      barsSinceChange: this.barsSinceChange,
      barInPhrase: this.barsSinceChange % PHRASE_BARS,
      confidence: this.confidence,
    };
  }

  /** 0 on the beat, 0.5 halfway to the next one. 0 until there is a tempo. */
  phase(now: number): number {
    if (!this.started || this.period <= 0) return 0;
    const p = ((now - this.nextBeat) / this.period) % 1;
    return p < 0 ? p + 1 : p;
  }

  private isDownbeat(index: number): boolean {
    return mod(index, this.barLength) === this.downbeatOffset;
  }

  /** Bass on this beat is evidence that this position in the bar is beat one. */
  private vote(index: number, low: number): void {
    const bar = Math.floor(index / this.barLength);
    if (bar !== this.evidenceBar) {
      const decay = BAR_DECAY ** Math.min(MAX_DECAY_BARS, Math.abs(bar - this.evidenceBar));
      for (let i = 0; i < this.evidence.length; i++) this.evidence[i] = this.evidence[i]! * decay;
      this.evidenceBar = bar;
    }

    const slot = mod(index, this.barLength);
    this.evidence[slot] = this.evidence[slot]! + low;

    let best = 0;
    for (let i = 1; i < this.evidence.length; i++) {
      if (this.evidence[i]! > this.evidence[best]!) best = i;
    }
    this.downbeatOffset = best;
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

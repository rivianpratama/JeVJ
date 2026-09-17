import { describe, expect, it } from 'vitest';
import { HIDDEN_STEP_MS, createLoopDriver, type DriverHost } from '../../src/app/loopDriver';

/** A page whose visibility, frames and timers are all under the test's hand. */
function fakeHost() {
  let hidden = false;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { cb: () => void; ms: number }>();
  const listeners = new Set<() => void>();

  const host: DriverHost = {
    requestFrame(cb) {
      const h = nextHandle++;
      frames.set(h, cb);
      return h;
    },
    cancelFrame(h) {
      frames.delete(h);
    },
    setTimer(cb, ms) {
      const h = nextHandle++;
      timers.set(h, { cb, ms });
      return h;
    },
    clearTimer(h) {
      timers.delete(h);
    },
    hidden: () => hidden,
    onVisibilityChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  return {
    host,
    frames,
    timers,
    listeners,
    /** One display frame: the browser calls back whatever is queued. */
    tickFrame(): void {
      const queued = [...frames.entries()];
      frames.clear();
      for (const [, cb] of queued) cb();
    },
    /** One interval period. */
    tickTimer(): void {
      for (const [, t] of [...timers.entries()]) t.cb();
    },
    setHidden(v: boolean): void {
      hidden = v;
      for (const cb of [...listeners]) cb();
    },
  };
}

describe('createLoopDriver', () => {
  it('runs on frames while the page is visible', () => {
    const page = fakeHost();
    let steps = 0;
    const driver = createLoopDriver(() => steps++, page.host);

    driver.start();
    expect(driver.mode()).toBe('frames');
    expect(page.timers.size).toBe(0);

    page.tickFrame();
    page.tickFrame();
    expect(steps).toBe(2);
  });

  it('switches to a timer when the page is hidden, and back again', () => {
    const page = fakeHost();
    let steps = 0;
    const driver = createLoopDriver(() => steps++, page.host);
    driver.start();

    page.setHidden(true);
    expect(driver.mode()).toBe('timer');
    // Nothing is left queued on the frame side: a throttled callback would
    // otherwise step the analysis a second time whenever the browser got round
    // to it.
    expect(page.frames.size).toBe(0);
    expect([...page.timers.values()][0]?.ms).toBe(HIDDEN_STEP_MS);

    page.tickTimer();
    page.tickTimer();
    expect(steps).toBe(2);

    page.setHidden(false);
    expect(driver.mode()).toBe('frames');
    expect(page.timers.size).toBe(0);
    page.tickFrame();
    expect(steps).toBe(3);
  });

  it('starts on a timer when it is started on an already-hidden page', () => {
    const page = fakeHost();
    let steps = 0;
    const driver = createLoopDriver(() => steps++, page.host);
    page.setHidden(true);

    driver.start();
    expect(driver.mode()).toBe('timer');
    page.tickTimer();
    expect(steps).toBe(1);
  });

  it('is idempotent: starting twice does not step twice', () => {
    const page = fakeHost();
    let steps = 0;
    const driver = createLoopDriver(() => steps++, page.host);

    driver.start();
    driver.start();
    page.tickFrame();
    expect(steps).toBe(1);
  });

  it('stops both drivers and stops listening', () => {
    const page = fakeHost();
    let steps = 0;
    const driver = createLoopDriver(() => steps++, page.host);

    driver.start();
    driver.stop();
    expect(driver.mode()).toBe('stopped');
    page.tickFrame();
    expect(steps).toBe(0);

    // A visibility change after `stop` must not resurrect the loop.
    page.setHidden(true);
    expect(page.timers.size).toBe(0);
    expect(driver.mode()).toBe('stopped');
  });

  it('does nothing on a visibility change it is not running for', () => {
    const page = fakeHost();
    const driver = createLoopDriver(() => {}, page.host);
    page.setHidden(true);
    expect(driver.mode()).toBe('stopped');
    expect(page.timers.size).toBe(0);
  });
});

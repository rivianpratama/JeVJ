import { afterEach, describe, expect, it } from 'vitest';
import handler, { callerIp, takeToken } from '../../api/mood';
import { EXAMPLE_INPUT } from '../helpers/moodFixture';

/** Just enough of Vercel's request/response pair to drive the front door. */
function pair(over: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const sent: { status: number; json: unknown; headers: Record<string, string> } = {
    status: 0,
    json: null,
    headers: {},
  };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.json = body;
      return res;
    },
    setHeader(k: string, v: string) {
      sent.headers[k] = v;
    },
  };
  const req = {
    method: over.method ?? 'POST',
    body: over.body,
    headers: over.headers ?? { 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
  };
  // The handler only uses the fields above; the Vercel types describe far more.
  return { req: req as never, res: res as never, sent };
}

const KEY = 'TYPESAFE_API_KEY';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('api/mood', () => {
  it('only answers POST', async () => {
    const { req, res, sent } = pair({ method: 'GET' });
    await handler(req, res);
    expect(sent.status).toBe(405);
    expect(sent.headers['Allow']).toBe('POST');
  });

  it('refuses a body larger than 2 KB', async () => {
    const { req, res, sent } = pair({ body: { ...EXAMPLE_INPUT, padding: 'x'.repeat(2048) } });
    await handler(req, res);
    expect(sent.status).toBe(413);
  });

  it('says the service is unconfigured rather than calling without a key', async () => {
    delete process.env[KEY];
    const { req, res, sent } = pair({ body: EXAMPLE_INPUT });
    await handler(req, res);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.json)).not.toContain(KEY);
  });
});

describe('takeToken', () => {
  it('allows twenty requests a minute and then stops', () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) expect(takeToken('a', t), `request ${i}`).toBe(true);
    expect(takeToken('a', t)).toBe(false);
  });

  it('refills continuously', () => {
    const t = 2_000_000;
    for (let i = 0; i < 20; i++) takeToken('b', t);
    expect(takeToken('b', t + 2_000)).toBe(false); // 0.66 tokens back
    expect(takeToken('b', t + 4_000)).toBe(true); // 1.33
    expect(takeToken('b', t + 60_000)).toBe(true);
  });

  it('counts each caller separately', () => {
    const t = 3_000_000;
    for (let i = 0; i < 20; i++) takeToken('c', t);
    expect(takeToken('c', t)).toBe(false);
    expect(takeToken('d', t)).toBe(true);
  });
});

describe('callerIp', () => {
  it('takes the first hop and nothing else', () => {
    expect(callerIp('203.0.113.7, 70.41.3.18, 150.172.238.178')).toBe('203.0.113.7');
    expect(callerIp(['198.51.100.2, 10.0.0.1'])).toBe('198.51.100.2');
    expect(callerIp(undefined)).toBe('unknown');
    expect(callerIp('')).toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, DEFAULT_PORT, listenOptions } from '../../server/env';

describe('listenOptions', () => {
  it('binds loopback when nothing says otherwise', () => {
    // The one that matters. This server runs yt-dlp on whatever video id it is
    // handed and serves the result off the local disk; a default of 0.0.0.0
    // would publish that to every interface of the machine.
    expect(listenOptions({}).host).toBe('127.0.0.1');
    expect(listenOptions({}).host).toBe(DEFAULT_HOST);
    expect(listenOptions({ PORT: '8080' }).host).toBe(DEFAULT_HOST);
    // An empty `HOST=` in a .env is a line nobody filled in, not a request.
    expect(listenOptions({ HOST: '' }).host).toBe(DEFAULT_HOST);
    expect(listenOptions({ HOST: '   ' }).host).toBe(DEFAULT_HOST);
  });

  it('binds wider only when HOST asks for it', () => {
    expect(listenOptions({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(listenOptions({ HOST: '::1' }).host).toBe('::1');
    expect(listenOptions({ HOST: ' 192.168.1.4 ' }).host).toBe('192.168.1.4');
  });

  it('takes the port from PORT and falls back rather than binding NaN', () => {
    expect(listenOptions({}).port).toBe(DEFAULT_PORT);
    expect(listenOptions({ PORT: '8080' }).port).toBe(8080);
    expect(listenOptions({ PORT: '0' }).port).toBe(0);
    for (const bad of ['', 'nope', '5173.5', '-1', '70000']) {
      expect(listenOptions({ PORT: bad }).port, bad).toBe(DEFAULT_PORT);
    }
  });
});

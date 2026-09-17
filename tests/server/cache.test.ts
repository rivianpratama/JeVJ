import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cachedInfo, cachedMedia, isVideoId, mediaName, writeInfo } from '../../server/ytdlp/cache';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jevj-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cachedMedia', () => {
  it('finds a downloaded video by id', () => {
    writeFileSync(join(dir, 'jNQXAC9IVRw.mp4'), 'x');
    expect(cachedMedia(dir, 'jNQXAC9IVRw')).toBe(join(dir, 'jNQXAC9IVRw.mp4'));
  });

  it('is null when nothing has been downloaded', () => {
    expect(cachedMedia(dir, 'jNQXAC9IVRw')).toBeNull();
  });

  it('is null for a missing directory rather than throwing', () => {
    expect(cachedMedia(join(dir, 'nope'), 'jNQXAC9IVRw')).toBeNull();
  });

  it('refuses an id that is not a video id, whatever it points at', () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'secret.mp4'), 'x');
    expect(cachedMedia(dir, '../sub/secret')).toBeNull();
    expect(cachedMedia(dir, 'sub/secret')).toBeNull();
  });

  it('will not take a directory for a video', () => {
    mkdirSync(join(dir, 'jNQXAC9IVRw.mp4'));
    expect(cachedMedia(dir, 'jNQXAC9IVRw')).toBeNull();
  });
});

describe('info sidecar', () => {
  it('round-trips the title and duration', () => {
    writeInfo(dir, 'jNQXAC9IVRw', { title: 'Me at the zoo', durationSec: 19 });
    expect(cachedInfo(dir, 'jNQXAC9IVRw')).toEqual({ title: 'Me at the zoo', durationSec: 19 });
  });

  it('is null when absent or unreadable', () => {
    expect(cachedInfo(dir, 'jNQXAC9IVRw')).toBeNull();
    writeFileSync(join(dir, 'jNQXAC9IVRw.info.json'), 'not json');
    expect(cachedInfo(dir, 'jNQXAC9IVRw')).toBeNull();
  });

  it('drops fields that are not the shape we wrote', () => {
    writeFileSync(join(dir, 'jNQXAC9IVRw.info.json'), JSON.stringify({ title: 7, durationSec: 'long' }));
    expect(cachedInfo(dir, 'jNQXAC9IVRw')).toEqual({});
  });
});

describe('isVideoId', () => {
  it('accepts the eleven-character ids YouTube hands out', () => {
    expect(isVideoId('jNQXAC9IVRw')).toBe(true);
    expect(isVideoId('_-aB9cD8eF0')).toBe(true);
  });

  it('rejects anything that could walk out of the cache', () => {
    expect(isVideoId('../../etc/pass')).toBe(false);
    expect(isVideoId('jNQXAC9IVR')).toBe(false);
    expect(isVideoId('jNQXAC9IVRw.mp4')).toBe(false);
    expect(isVideoId('')).toBe(false);
  });
});

describe('mediaName', () => {
  it('is the id with the one extension we serve', () => {
    expect(mediaName('jNQXAC9IVRw')).toBe('jNQXAC9IVRw.mp4');
  });
});

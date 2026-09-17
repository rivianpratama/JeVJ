import { describe, expect, it } from 'vitest';
import { parseYouTubeUrl } from '../../src/source/urlParse';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeUrl', () => {
  it('parses a standard watch url with no start time', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}`)).toEqual({
      videoId: ID,
      startSeconds: 0,
    });
  });

  it('parses a youtu.be short link with ?t=90', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=90`)).toEqual({
      videoId: ID,
      startSeconds: 90,
    });
  });

  it('parses a shorts url', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/shorts/${ID}`)).toEqual({
      videoId: ID,
      startSeconds: 0,
    });
  });

  it('parses a music.youtube.com url with a playlist parameter', () => {
    expect(parseYouTubeUrl(`https://music.youtube.com/watch?v=${ID}&list=RD`)).toEqual({
      videoId: ID,
      startSeconds: 0,
    });
  });

  it('parses a colloquial t=1m30s timestamp into seconds', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)).toEqual({
      videoId: ID,
      startSeconds: 90,
    });
  });

  it('accepts a bare 11-character video id', () => {
    expect(parseYouTubeUrl(ID)).toEqual({ videoId: ID, startSeconds: 0 });
  });

  it('rejects a non-YouTube url', () => {
    expect(parseYouTubeUrl('https://vimeo.com/1')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseYouTubeUrl('')).toBeNull();
  });

  it('parses embed and live urls', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/embed/${ID}`)).toEqual({
      videoId: ID,
      startSeconds: 0,
    });
    expect(parseYouTubeUrl(`https://www.youtube.com/live/${ID}`)).toEqual({
      videoId: ID,
      startSeconds: 0,
    });
  });

  it('accepts a url without a protocol and with surrounding whitespace', () => {
    expect(parseYouTubeUrl(`  youtu.be/${ID}  `)).toEqual({ videoId: ID, startSeconds: 0 });
  });

  it('parses t values with a trailing s and h/m/s combinations', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=45s`)?.startSeconds).toBe(45);
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=1h2m3s`)?.startSeconds).toBe(3723);
  });

  it('prefers the start parameter and ignores nonsense time values', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&start=12`)?.startSeconds).toBe(12);
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=abc`)?.startSeconds).toBe(0);
  });

  it('rejects a youtube url with no video id and ids of the wrong length', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=tooshort')).toBeNull();
    expect(parseYouTubeUrl('dQw4w9WgXcQQQQ')).toBeNull();
  });
});

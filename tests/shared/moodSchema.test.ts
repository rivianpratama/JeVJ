import { describe, expect, it } from 'vitest';
import type { Genre, MoodInput } from '../../src/shared/types';
import {
  NEUTRAL_MOOD,
  validateMoodInput,
  validateMoodVector,
  validateTrackAnalysis,
  validateTransitionInput,
  validateTransitionVerdict,
} from '../../src/shared/moodSchema';
import { EXAMPLE_INPUT, exampleAnalysis, exampleTransition, exampleVerdict } from '../helpers/moodFixture';

function validInput(): MoodInput {
  return {
    pos: '1:32/4:10',
    bpm: 128,
    tempo: 'allegro',
    beatConf: 0.9,
    meter: 'duple',
    sync: 0.2,
    regular: 0.8,
    key: 'F#',
    mode: 'minor',
    modeConf: 0.7,
    modal: 'aeolian',
    consonance: 0.6,
    loud: 'mf',
    range: 0.4,
    trend: 'building',
    crest: 0.5,
    bright: 0.55,
    noise: 0.3,
    attack: 'sharp',
    sub: 0.25,
    bands: [3, 5, 7, 6, 4, 4, 2, 1],
    speech: 0.05,
    vocal: 0.2,
    harsh: 0.45,
    onsetsPerSec: 4.2,
    slope4: 1.5,
    slope8: -2.25,
    onsetRatio: 1.4,
    centroidSlope: 0.15,
    gap: false,
    barsSinceChange: 6,
    barInPhrase: 2,
  };
}

describe('validateMoodInput', () => {
  it('accepts a fully valid MoodInput', () => {
    const r = validateMoodInput(validInput());
    expect(r.ok).toBe(true);
  });

  it('rejects bands with 7 entries', () => {
    const r = validateMoodInput({ ...validInput(), bands: [3, 5, 7, 6, 4, 4, 2] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('bands');
  });

  it("rejects tempo 'fast'", () => {
    const r = validateMoodInput({ ...validInput(), tempo: 'fast' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('tempo');
  });

  it("accepts pos '1:32/live'", () => {
    const r = validateMoodInput({ ...validInput(), pos: '1:32/live' });
    expect(r.ok).toBe(true);
  });

  // The reference payload from docs/superpowers/plans/2026-09-17-jevj-visualizer.md;
  // Task 2's summarizer must produce snapshots that validate.
  it('accepts the reference payload from the plan', () => {
    const reference = JSON.parse(
      '{"pos":"1:32/4:05","bpm":128,"tempo":"allegro","beatConf":0.9,"meter":"duple","sync":0.3,"regular":0.9,"key":"F#","mode":"minor","modeConf":0.7,"modal":"aeolian","consonance":0.6,"loud":"f","range":0.2,"trend":"building","crest":0.3,"bright":0.7,"noise":0.4,"attack":"sharp","sub":0.8,"bands":[9,8,6,5,5,6,7,5],"speech":0.05,"vocal":0.2,"harsh":0.45,"onsetsPerSec":4.2,"slope4":3.5,"slope8":6.1,"onsetRatio":2.1,"centroidSlope":0.4,"gap":false,"barsSinceChange":14,"barInPhrase":14}',
    ) as unknown;
    const r = validateMoodInput(reference);
    expect(r.ok).toBe(true);
  });

  it("rejects pos '92s'", () => {
    const r = validateMoodInput({ ...validInput(), pos: '92s' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('pos');
  });
});

describe('validateMoodVector', () => {
  it('accepts NEUTRAL_MOOD', () => {
    const r = validateMoodVector(NEUTRAL_MOOD);
    expect(r.ok).toBe(true);
  });

  it('rejects a MoodVector whose genreP is missing a genre', () => {
    const missing: Genre = 'folk_acoustic';
    const genreP: Record<string, number> = { ...NEUTRAL_MOOD.genreP };
    delete genreP[missing];
    const r = validateMoodVector({ ...NEUTRAL_MOOD, genreP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('genreP');
  });
});

describe('validateTransitionInput', () => {
  it('accepts a well-formed candidate and copies it field by field', () => {
    const input = exampleTransition('2:04');
    const r = validateTransitionInput({ ...input, nonsense: 1 });
    expect(r.ok ? 'ok' : r.error).toBe('ok');
    expect(r.ok && r.value).toEqual(input);
    expect(r.ok && r.value).not.toHaveProperty('nonsense');
  });

  it('insists on m:ss, without a track length after it', () => {
    for (const at of ['2:04/4:05', '204', '2:4', '', 'soon']) {
      expect(validateTransitionInput(exampleTransition(at as string)).ok, at).toBe(false);
    }
  });

  it('refuses a music page that is not one', () => {
    expect(validateTransitionInput({ ...exampleTransition(), before: { bpm: 128 } }).ok).toBe(false);
    expect(validateTransitionInput({ ...exampleTransition(), after: null }).ok).toBe(false);
  });

  it('holds every number to its range', () => {
    const bad: Array<Partial<Record<string, unknown>>> = [
      { jumpDb: 500 },
      { jumpDb: 'loud' },
      { gapBeforeSec: -1 },
      { bpmAfter: 400 },
      { vocalDelta: 2 },
      { harshDelta: -2 },
      { keyChanged: 'yes' },
    ];
    for (const over of bad) {
      const r = validateTransitionInput({ ...exampleTransition(), ...over });
      expect(r.ok, JSON.stringify(over)).toBe(false);
    }
  });
});

describe('validateTransitionVerdict', () => {
  it('accepts a well-formed verdict', () => {
    const v = exampleVerdict();
    const r = validateTransitionVerdict(v);
    expect(r.ok ? 'ok' : r.error).toBe('ok');
    expect(r.ok && r.value).toEqual(v);
  });

  it('refuses a kind it does not know, or a distribution with a hole in it', () => {
    expect(validateTransitionVerdict(exampleVerdict({ kind: 'slam' as never })).ok).toBe(false);
    const holed = exampleVerdict();
    delete (holed.kindP as Record<string, number>)['none'];
    expect(validateTransitionVerdict(holed).ok).toBe(false);
  });
});

describe('validateTrackAnalysis', () => {
  it('round-trips a record through JSON', () => {
    const analysis = exampleAnalysis('jNQXAC9IVRw');
    const parsed: unknown = JSON.parse(JSON.stringify(analysis));
    const r = validateTrackAnalysis(parsed);
    expect(r.ok ? 'ok' : r.error).toBe('ok');
    expect(r.ok && r.value).toEqual(analysis);
  });

  it('keeps the cue fields the transition writer adds', () => {
    const r = validateTrackAnalysis(JSON.parse(JSON.stringify(exampleAnalysis())));
    const hit = r.ok ? r.value.cues.find((c) => c.impact !== undefined) : undefined;
    expect(hit?.flourish).toBe(true);
    expect(hit?.transition).toBe('drop');
  });

  it('is happy without a videoId, since a dropped file has none', () => {
    const r = validateTrackAnalysis(exampleAnalysis());
    expect(r.ok && 'videoId' in r.value).toBe(false);
  });

  it('refuses a record with a piece missing or wrong', () => {
    const base = exampleAnalysis();
    const broken: Array<[string, unknown]> = [
      ['not an object', 42],
      ['no title', { ...base, title: undefined }],
      ['no duration', { ...base, durationSec: 'a while' }],
      ['segments not an array', { ...base, segments: {} }],
      ['a segment with no mood', { ...base, segments: [{ start: 0, end: 1, input: EXAMPLE_INPUT }] }],
      ['a transition with no time', { ...base, transitions: [{ input: {}, verdict: {} }] }],
      ['a cue with no source', { ...base, cues: [{ t: 1 }] }],
      ['a cue from nowhere', { ...base, cues: [{ t: 1, source: 'somewhere' }] }],
      ['a log entry with no direction', { ...base, log: [{ t: 1, json: '{}' }] }],
      ['a log entry that is not text', { ...base, log: [{ t: 1, dir: 'req', json: {} }] }],
    ];
    for (const [name, value] of broken) {
      expect(validateTrackAnalysis(value).ok, name).toBe(false);
    }
  });
});

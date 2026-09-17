import { describe, expect, it } from 'vitest';

import { analyzeTrack, passOneProgress, type TrackAnalysisDeps } from '../../src/app/trackAnalysis';
import { ONSET_REPORT_LAG_SEC } from '../../src/analysis/onset';
import { NEUTRAL_MOOD, validateTrackAnalysis } from '../../src/shared/moodSchema';
import { songFixture } from '../helpers/synth';
import type {
  Cue,
  MoodInput,
  MoodVector,
  TrackAnalysis,
  TransitionInput,
  TransitionKind,
  TransitionVerdict,
} from '../../src/shared/types';

const SR = 44100;
const fixture = songFixture(SR);
/** 120 BPM: two seconds a bar, so a two-bar ramp is four seconds. */
const BAR = 2;

/**
 * A fake Jev that reads what it is shown.
 *
 * Not a canned answer: the acceptance for this pass is that the *whole chain*
 * lines up — that the candidate finder hands the model a moment whose before
 * and after actually describe a drop, and that the writer then puts a hit on
 * the sample. A fake that answered "drop" to everything would pass that test
 * without any of it being true. So this one judges from the payload exactly as
 * the model is asked to: a loud jump out of a hole is a drop, a voice arriving
 * is a vocal entry, a collapse is a breakdown or a fall depending on how far.
 */
function scriptedJev(): TrackAnalysisDeps & { seen: TransitionInput[]; batches: number } {
  const seen: TransitionInput[] = [];
  const state = { batches: 0 };

  const askJev = async (input: MoodInput): Promise<MoodVector> => ({
    ...NEUTRAL_MOOD,
    arousal: Math.min(1, input.bpm / 200),
    confidence: 0.8,
  });

  const kindOf = (t: TransitionInput): TransitionKind => {
    // A hole with everything arriving out of it is the slam; the same hole
    // seen from its own edge, before the music is back, is the silence.
    if (t.gapBeforeSec >= 0.1 && t.jumpDb >= 20) return 'drop';
    if (t.gapBeforeSec >= 0.1 && t.jumpDb >= 6) return 'break_silence';
    if (t.jumpDb >= 6) return 'drop';
    if (t.harshDelta >= 0.25) return 'scream_peak';
    if (t.jumpDb <= -8) return 'breakdown';
    if (t.vocalDelta >= 0.15) return 'vocal_entry';
    if (t.bpmBefore > 0 && Math.abs(t.bpmAfter - t.bpmBefore) / t.bpmBefore > 0.06) return 'tempo_change';
    if (t.keyChanged) return 'key_change';
    return 'none';
  };

  const askTransition = async (inputs: TransitionInput[]): Promise<TransitionVerdict[]> => {
    state.batches += 1;
    seen.push(...inputs);
    return inputs.map((t) => {
      const kind = kindOf(t);
      const intensity = Math.min(1, Math.abs(t.jumpDb) / 15);
      const kindP = { ...emptyKindP(), [kind]: 1 };
      return {
        kind,
        kindP,
        intensity,
        dramatic: kind === 'drop' || kind === 'scream_peak' ? 0.9 : 0.2,
        release: kind === 'drop' ? 1 : 0.5,
        confidence: 0.7,
      };
    });
  };

  return {
    askJev,
    askTransition,
    seen,
    get batches() {
      return state.batches;
    },
    title: 'the song fixture',
  };
}

function emptyKindP(): TransitionVerdict['kindP'] {
  return {
    drop: 0, build_start: 0, breakdown: 0, break_silence: 0, vocal_entry: 0,
    scream_peak: 0, quiet_fall: 0, tempo_change: 0, key_change: 0, none: 0,
  };
}

let analyzed: { analysis: TrackAnalysis; progress: number[]; jev: ReturnType<typeof scriptedJev> } | null = null;

/** The fixture, analyzed once with the scripted model, and reused. */
async function run(): Promise<NonNullable<typeof analyzed>> {
  if (analyzed === null) {
    const jev = scriptedJev();
    const progress: number[] = [];
    const analysis = await analyzeTrack(fixture.signal, SR, jev, (p) => progress.push(p));
    analyzed = { analysis, progress, jev };
  }
  return analyzed;
}

/** Cues of a kind, in time order. */
function cuesWhere(cues: readonly Cue[], p: (c: Cue) => boolean): Cue[] {
  return cues.filter(p);
}

describe('analyzeTrack on the song fixture', () => {
  it('lands the drop on the sample, with a ramp two bars in front of it', async () => {
    const { analysis } = await run();
    const drop = fixture.truth.drop;

    const hit = cuesWhere(analysis.cues, (c) => c.source === 'jev' && c.impact !== undefined).find(
      (c) => Math.abs(c.t - (drop + ONSET_REPORT_LAG_SEC)) <= 0.03,
    );
    expect(hit, 'an impact within 30 ms of the slam').toBeDefined();
    expect(hit?.section).toBe('drop_climax');
    expect(hit?.transition).toBe('drop');
    expect(hit?.flourish).toBe(true);

    // The ramp opens exactly two bars earlier and climbs from there.
    const ramp = cuesWhere(
      analysis.cues,
      (c) => c.source === 'jev' && c.build !== undefined && c.t >= hit!.t - 2 * BAR && c.t < hit!.t,
    );
    expect(ramp[0]!.t).toBeCloseTo(hit!.t - 2 * BAR, 6);
    expect(ramp[0]!.build).toBe(0);
    expect(ramp[ramp.length - 1]!.build).toBeGreaterThan(0.8);
    expect(ramp.length).toBeGreaterThanOrEqual((2 * BAR) / 0.2);
  }, 60_000);

  it('calls the breakdown a section change near 40 s', async () => {
    const { analysis } = await run();
    const section = analysis.cues.find(
      (c) => c.section === 'breakdown' && Math.abs(c.t - fixture.truth.breakdownStart) <= 1,
    );
    expect(section, 'a breakdown cue near 40 s').toBeDefined();
    // The arousal is pulled down and put back two bars later.
    expect(section?.mood?.arousal).toBeLessThan(NEUTRAL_MOOD.arousal);
    const back = analysis.cues.find(
      (c) => c.source === 'jev' && Math.abs(c.t - (section!.t + 2 * BAR)) < 0.01 && c.mood?.arousal !== undefined,
    );
    expect(back).toBeDefined();
  }, 60_000);

  it('hits the scream near 48 s and lets the aggression go a bar later', async () => {
    const { analysis } = await run();
    const scream = analysis.cues.find(
      (c) => c.transition === 'scream_peak' && Math.abs(c.t - fixture.truth.screamStart) <= 0.5,
    );
    expect(scream, 'a scream impact near 48 s').toBeDefined();
    expect(scream?.impact).toBeGreaterThanOrEqual(0.8);
    expect(scream?.mood?.aggression).toBe(1);
    // And it is given back a bar later — a bar as the grid measured it around
    // the scream, which is not exactly the fixture's 2 s once the tempo
    // tracker has had a noise burst train to think about.
    const back = analysis.cues.find(
      (c) => c.t > scream!.t && c.mood?.aggression !== undefined && c.mood.aggression < 1,
    );
    expect(back).toBeDefined();
    expect(back!.t - scream!.t).toBeLessThanOrEqual(2 * BAR);
  }, 60_000);

  it('handles the fall into the quiet outro near 52 s', async () => {
    const { analysis } = await run();
    const fall = analysis.cues.find(
      (c) =>
        (c.transition === 'quiet_fall' || c.transition === 'breakdown') &&
        Math.abs(c.t - fixture.truth.quietStart) <= 0.5,
    );
    expect(fall, 'a fall near 52 s').toBeDefined();
    expect(fall?.section).toBe('breakdown');
  }, 60_000);

  it('asks about every candidate, four to a request', async () => {
    const { analysis, jev } = await run();
    expect(jev.seen.length).toBeGreaterThan(0);
    expect(jev.seen.length).toBeLessThanOrEqual(60);
    expect(jev.batches).toBe(Math.ceil(jev.seen.length / 4));
    // Everything it was asked about, in track order, and the m:ss agrees.
    for (let i = 1; i < analysis.transitions.length; i++) {
      expect(analysis.transitions[i]!.at).toBeGreaterThan(analysis.transitions[i - 1]!.at);
    }
  }, 60_000);

  it('shows the model the music either side of each moment', async () => {
    const { jev } = await run();
    const slam = jev.seen.find((t) => t.at === '0:24');
    expect(slam).toBeDefined();
    expect(slam!.jumpDb).toBeGreaterThan(6);
    expect(slam!.gapBeforeSec).toBeGreaterThan(0.1);
    // The two pages are the music either side, not the same page twice: the
    // drop has a bass note under every beat and the build does not.
    expect(slam!.after.bands[0]!).toBeGreaterThan(slam!.before.bands[0]!);
    expect(slam!.before).not.toEqual(slam!.after);
  }, 60_000);

  it('writes down every request and response with its track time', async () => {
    const { analysis } = await run();
    const segments = analysis.segments.length;
    const transitions = analysis.transitions.length;
    expect(analysis.log).toHaveLength(2 * (segments + transitions));
    expect(analysis.log.filter((e) => e.dir === 'req')).toHaveLength(segments + transitions);

    // Segments first, then moments, each request followed by its response.
    for (let i = 0; i < analysis.log.length; i += 2) {
      expect(analysis.log[i]!.dir).toBe('req');
      expect(analysis.log[i + 1]!.dir).toBe('res');
      expect(analysis.log[i + 1]!.t).toBe(analysis.log[i]!.t);
      expect(() => JSON.parse(analysis.log[i]!.json)).not.toThrow();
    }
    expect(analysis.log[0]!.t).toBe(analysis.segments[0]!.start);
    expect(analysis.log[2 * segments]!.t).toBe(analysis.transitions[0]!.at);
  }, 60_000);

  it('hands back a record the schema accepts, and a sorted timeline', async () => {
    const { analysis } = await run();
    const checked = validateTrackAnalysis(JSON.parse(JSON.stringify(analysis)));
    expect(checked.ok ? 'ok' : checked.error).toBe('ok');
    expect(analysis.title).toBe('the song fixture');
    expect(analysis.durationSec).toBeCloseTo(60, 1);
    expect(analysis.cues.map((c) => c.t)).toEqual([...analysis.cues.map((c) => c.t)].sort((a, b) => a - b));
    // The sweep's own cues are still there under the transition cues.
    expect(analysis.cues.some((c) => c.source === 'offline' && c.beat === true)).toBe(true);
  }, 60_000);

  it('reports progress forward, through both passes, to 1', async () => {
    const { progress } = await run();
    expect(progress.length).toBeGreaterThan(10);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThan(progress[i - 1]!);
    }
    expect(progress[0]!).toBeGreaterThanOrEqual(0);
    expect(progress[progress.length - 1]).toBe(1);
    // Each phase reports inside its own slice of the bar.
    expect(progress.some((p) => p > 0 && p < 1 / 3)).toBe(true);
    expect(progress.some((p) => p > 1 / 3 && p < 0.75)).toBe(true);
    expect(progress.some((p) => p > 0.75 && p < 1)).toBe(true);
  }, 60_000);
});

describe('passOneProgress', () => {
  it('maps the sweep onto the first third and the calls onto the rest', () => {
    expect(passOneProgress(0)).toBe(0);
    expect(passOneProgress(0.4)).toBeCloseTo(1 / 6, 6);
    expect(passOneProgress(0.8)).toBeCloseTo(1 / 3, 6);
    expect(passOneProgress(0.9)).toBeCloseTo(1 / 3 + (0.75 - 1 / 3) / 2, 6);
    expect(passOneProgress(1)).toBeCloseTo(0.75, 6);
  });

  it('clamps and stays monotone', () => {
    expect(passOneProgress(-1)).toBe(0);
    expect(passOneProgress(2)).toBeCloseTo(0.75, 6);
    let last = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const q = passOneProgress(p);
      expect(q).toBeGreaterThanOrEqual(last);
      last = q;
    }
  });
});

describe('analyzeTrack on nothing at all', () => {
  it('answers an empty buffer with an empty record', async () => {
    const analysis = await analyzeTrack(new Float32Array(0), SR, scriptedJev());
    expect(analysis.transitions).toEqual([]);
    expect(analysis.cues).toEqual([]);
    expect(analysis.durationSec).toBe(0);
    expect(validateTrackAnalysis(analysis).ok).toBe(true);
  });
});

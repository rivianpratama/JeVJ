/**
 * What we ask Jev, and the state we ask it about.
 *
 * This is the creative brief for the model: the wording of every instruction
 * and every rubric level is the interface, not decoration. A level is a word
 * the model reasons *with*, so "grieving, desolate, hopeless" and "sad" are
 * different questions. Change the text and you change the visuals.
 *
 * Deliberately free of any TypeSafe runtime import. The client bundle imports
 * this file (the HUD and Task 8's visuals want to know the label sets), and
 * the SDK refuses to load in a browser at all; the question shapes below are
 * plain objects that match the SDK's `Questions` structurally, so the server
 * can hand them straight to `systemOne`.
 */

import type { MoodInput, MoodVector } from '../shared/types';

/** A JSON value, as the API accepts for instructions, criteria and state. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** Text, a JSON object or array, or null. */
export type Entry = string | { [key: string]: JsonValue } | JsonValue[] | null;

export interface NoulQuestion {
  type: 'noul';
  instructions?: Entry;
  criteria?: { true?: Entry; false?: Entry } | null;
}

export interface ScoreQuestion {
  type: 'score';
  instructions?: Entry;
  /** Ordered levels, lowest first: the answer's score indexes into this. */
  criteria: readonly [Entry, Entry, ...Entry[]];
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions?: Entry;
  criteria: { readonly [label: string]: Entry };
}

export type Question = NoulQuestion | ScoreQuestion | ChoiceQuestion;

/**
 * What each field of the payload means, sent once per call as `state.legend`.
 *
 * The payload itself is aggressively abbreviated to keep it small, which makes
 * it unreadable without this: `crest` and `sub` are not English. Spelling the
 * units out here costs a fixed ~230 estimated tokens and buys every question
 * the same vocabulary.
 */
export const MOOD_PREAMBLE: Record<string, string> = {
  bpm: 'beats per minute',
  tempo: 'Italian tempo marking',
  beatConf: '0-1 how clearly a steady beat exists',
  sync: '0-1 syncopation',
  regular: '0-1 rhythmic regularity',
  modeConf: '0-1 certainty of major/minor',
  consonance: '0 dissonant..1 consonant',
  loud: 'pp..ff relative to this track',
  range: '0 compressed..1 wide dynamics',
  crest: '0 smooth..1 spiky',
  bright: '0 dark..1 bright',
  noise: '0 tonal..1 noisy',
  sub: '0-1 sub-bass weight',
  bands: '8 log bands 20Hz-16kHz, 0-9',
  speech: '0-1 talking rather than music',
  pause: '0-1 holes between phrases; music has none',
  vocal: '0-1 a sung voice is present',
  harsh: '0-1 abrasive, distorted or screamed',
  'slope4/slope8': 'loudness change in dB over last 4/8 bars',
  onsetRatio: 'note density now vs 8 bars ago',
  centroidSlope: '-1 darkening..1 brightening',
  gap: 'silence in the last beat',
  barInPhrase: 'bar index within a 16-bar phrase',
};

export const MOOD_QUESTIONS: Record<string, Question> = {
  valence: {
    type: 'score',
    instructions:
      'What emotional valence does this music express right now? Judge from mode, consonance, tempo, brightness and dynamics.',
    criteria: [
      'grieving, desolate, hopeless',
      'bittersweet, melancholic, wistful',
      'neutral, matter-of-fact, ambiguous',
      'uplifting, warm, hopeful',
      'euphoric, triumphant, ecstatic',
    ],
  },
  arousal: {
    type: 'score',
    instructions: 'How much physical energy does the music carry right now?',
    criteria: [
      'still, suspended, near-silent',
      'calm, gentle, unhurried',
      'moving, steady, engaged',
      'driving, intense, propulsive',
      'frantic, overwhelming, explosive',
    ],
  },
  tension: {
    type: 'score',
    instructions:
      'How much unresolved tension is there right now (dissonance, build-up, withheld resolution)?',
    criteria: [
      'fully resolved and restful',
      'relaxed with mild pull',
      'moderate tension, expecting movement',
      'high tension, strongly anticipating release',
      'unbearable suspense right before a release',
    ],
  },
  warmth: {
    type: 'score',
    instructions: 'What color temperature does the sound evoke?',
    criteria: ['icy, glassy, cold', 'cool, airy, clean', 'neutral', 'warm, rounded, glowing', 'hot, saturated, burning'],
  },
  synthetic: {
    type: 'score',
    instructions: 'How electronic versus acoustic does the sound source seem?',
    criteria: [
      'fully acoustic and organic (voices, strings, wood, breath)',
      'mostly acoustic with some processing',
      'mixed acoustic and electronic',
      'mostly electronic with some organic elements',
      'fully synthetic and machine-made',
    ],
  },
  space: {
    type: 'score',
    instructions: 'How large is the implied space?',
    criteria: [
      'intimate, dry, close to the ear',
      'small room',
      'medium hall',
      'large hall, long reverb',
      'vast, cosmic, boundless',
    ],
  },
  aggression: {
    type: 'noul',
    instructions: 'Is the music hostile, abrasive or violent in character right now?',
    criteria: {
      true: 'distorted, harsh, pounding, screaming, menacing',
      false: 'gentle, smooth, friendly or neutral',
    },
  },
  melancholy: {
    type: 'noul',
    instructions: 'Does the music carry sadness or longing right now?',
    criteria: { true: 'minor, slow, descending, mournful, nostalgic', false: 'no sadness present' },
  },
  hypnotic: {
    type: 'noul',
    instructions: 'Is the music trance-like: repetitive, cyclical, entrancing?',
    criteria: {
      true: 'steady loops, minimal change, repeating patterns that pull the listener in',
      false: 'varied, narrative or through-composed',
    },
  },
  euphoric_peak: {
    type: 'noul',
    instructions: 'Is this moment a peak or drop: the highest-energy payoff of a section?',
    criteria: {
      true: 'full-band impact, maximal loudness after a build, celebratory release',
      false: 'not a peak moment',
    },
  },
  spoken: {
    type: 'noul',
    instructions: 'Is this primarily spoken word (podcast, speech, narration) rather than music?',
    criteria: {
      true: {
        what: 'a talk, podcast, narration or interview',
        signals: ['speech >= 0.5', 'pause >= 0.15', 'no steady beat', 'vocal high with irregular pitch'],
        note: 'high beatConf with regular near 0 is the tracker locking onto syllables, not a beat; applause between passages is still spoken word',
      },
      false: {
        what: 'music, singing over instruments, or instrumental',
        signals: ['pause near 0', 'regular well above 0', 'sung notes that are held'],
      },
    },
  },
  genre: {
    type: 'choice',
    instructions: 'Which family best describes what is playing?',
    criteria: {
      classical: { what: 'orchestral, chamber, piano, wide dynamics, rubato' },
      jazz: { what: 'swing, complex harmony, improvisation, brass/piano/upright bass' },
      electronic_dance: {
        what: 'four-on-the-floor or breakbeat, synthetic, 120-180 bpm, builds and drops',
        not_for: 'distorted guitars and screamed vocals, or anything with no beat at all',
      },
      hiphop_trap: { what: '70-100 bpm half-time feel, heavy sub 808s, sparse hats, rap vocals' },
      rock_metal: {
        what: 'distorted guitars, live drums, dense midrange, aggressive',
        signals: ['distorted guitars', 'live drums', 'harsh >= 0.5', 'dense midrange'],
      },
      ambient_drone: { what: 'beatless or nearly beatless, sustained textures, slow evolution' },
      pop: { what: 'compressed, vocal-led, verse-chorus, moderate tempo' },
      folk_acoustic: { what: 'acoustic guitar, voice, small ensemble, intimate' },
      spoken: {
        what: 'speech, podcast, narration',
        signals: ['speech >= 0.5', 'pause ratio >= 0.15', 'no steady beat', 'vocal high with irregular pitch'],
      },
    },
  },
  section: {
    type: 'choice',
    instructions: 'Which part of the musical form is playing right now?',
    criteria: {
      intro: { what: 'sparse opening, establishing' },
      verse_steady: { what: 'steady groove, main material, moderate energy' },
      build: { what: 'energy rising, density increasing, tension accumulating toward a release' },
      drop_climax: { what: 'full-energy payoff, loudest densest section' },
      breakdown: { what: 'energy pulled back after a peak, stripped down' },
      outro: { what: 'winding down, fading' },
    },
  },
  motion: {
    type: 'choice',
    instructions: 'How should abstract visuals move to match this music?',
    criteria: {
      flow: { what: 'continuous laminar streams, smooth' },
      pulse: { what: 'beat-locked expansion and contraction' },
      shatter: { what: 'sharp fragments, jump cuts, glitch' },
      drift: { what: 'slow floating, weightless' },
      swarm: { what: 'many small agents moving with collective purpose' },
      bloom: { what: 'radial growth outward from the center, unfolding' },
    },
  },
  drop_imminent: {
    type: 'noul',
    instructions:
      'Given the build cues (slope4, slope8, onsetRatio, centroidSlope, gap, barInPhrase), will a drop or climax land within the next 2 bars?',
    criteria: {
      true: 'rising loudness, note density doubling, brightening riser, near the end of a 16-bar phrase, or a sudden gap',
      false: 'no build underway or the release already happened',
    },
  },
  beats_to_change: {
    type: 'choice',
    instructions: 'How many beats until the next section change?',
    criteria: {
      '1': { what: 'about 1 beat' },
      '2': { what: 'about 2 beats' },
      '4': { what: 'about 4 beats' },
      '8': { what: 'about 8 beats' },
      '16': { what: 'about 16 beats' },
      none: { what: 'no change expected in the next 16 beats' },
    },
  },
  impact: {
    type: 'score',
    instructions: 'How hard will the next section change hit?',
    criteria: [
      'imperceptible, seamless',
      'gentle shift',
      'clear change',
      'strong hit',
      'massive slam after a gap',
    ],
  },
  pre_drop_style: {
    type: 'choice',
    instructions: 'What kind of build is underway?',
    criteria: {
      silence_slam: { what: 'a gap or filter-cut right before the hit' },
      riser: { what: 'brightening upward sweep' },
      snare_roll: { what: 'note density doubling and quadrupling' },
      swell: { what: 'gradual loudness increase without a roll' },
      none: { what: 'no build underway' },
    },
  },
};

/** The state one call carries: the payload, and what its field names mean. */
export function buildState(input: MoodInput): { music: MoodInput; legend: Record<string, string> } {
  return { music: input, legend: MOOD_PREAMBLE };
}

/* ----------------------------------------------------------- what to ask */

/**
 * Not every question is worth asking every time.
 *
 * Measured on the live smoke: eighteen questions cost about 3.4k tokens and
 * 1.1 s, and the questions themselves — the rubrics above — are nearly all of
 * that. The payload is 150 tokens. So the cheapest thing this app can do is ask
 * fewer questions, and the only honest way to choose is by how fast each answer
 * goes stale.
 *
 * - **core**, every call: the six standing scores plus `spoken` and the three
 *   labels the whole look is built on. These are what the director reads every
 *   frame; a stale one is a wrong picture.
 * - **nouls**, every other call: aggression, melancholy, hypnotic and the peak.
 *   They move over bars rather than beats, and the mood state slews them over a
 *   second anyway, so asking at half the rate costs nothing anyone can see.
 * - **predictive**, only into a build: "is a drop coming, in how many beats,
 *   how hard, what kind of build". Outside a build the answer is always "no",
 *   and paying 900 tokens for it is paying for silence. The local drop detector
 *   keeps the deadline in the meantime.
 */
export const CORE_IDS = [
  'valence',
  'arousal',
  'tension',
  'warmth',
  'synthetic',
  'space',
  'spoken',
  'genre',
  'section',
  'motion',
] as const;

export const NOUL_IDS = ['aggression', 'melancholy', 'hypnotic', 'euphoric_peak'] as const;

export const PREDICTIVE_IDS = [
  'drop_imminent',
  'beats_to_change',
  'impact',
  'pre_drop_style',
] as const;

/** Loudness over the last 8 bars, in dB, that counts as a build. */
const BUILD_SLOPE8_DB = 2;
/** Note density against 8 bars ago that counts as one. */
const BUILD_ONSET_RATIO = 1.3;
/** From this bar of a 16-bar phrase on, a boundary is close enough to matter. */
const BUILD_BAR_IN_PHRASE = 12;

export interface QuestionChoice {
  /** How many calls have gone out already; the nouls ride on its parity. */
  callIndex: number;
  input: MoodInput;
  /** Jev's last answer, or null before there is one. */
  previous: MoodVector | null;
}

/**
 * Whether anything in front of us looks like a build.
 *
 * Three of the four cues are measurements — rising loudness, doubling density,
 * the end of a phrase — and the fourth is Jev's own last word: once it has said
 * `build`, the build is underway by definition and the predictions stay live
 * until it says otherwise.
 */
export function buildAhead(o: QuestionChoice): boolean {
  const i = o.input;
  return (
    i.slope8 > BUILD_SLOPE8_DB ||
    i.onsetRatio > BUILD_ONSET_RATIO ||
    i.barInPhrase >= BUILD_BAR_IN_PHRASE ||
    o.previous?.section === 'build'
  );
}

/** Which questions this call asks. */
export function selectQuestionIds(o: QuestionChoice): string[] {
  const ids: string[] = [...CORE_IDS];
  if (o.callIndex % 2 === 0) ids.push(...NOUL_IDS);
  if (buildAhead(o)) ids.push(...PREDICTIVE_IDS);
  return ids;
}

/**
 * The named questions, in the order `MOOD_QUESTIONS` declares them.
 *
 * Names it does not know are dropped rather than trusted: this runs on the
 * server against whatever the request carried. An empty selection is not an
 * instruction to ask nothing — it is a request that arrived without one — so it
 * falls back to the whole set.
 */
export function questionsFor(ids: readonly string[]): Record<string, Question> {
  const wanted = new Set(ids);
  const out: Record<string, Question> = {};
  for (const [id, q] of Object.entries(MOOD_QUESTIONS)) {
    if (wanted.has(id)) out[id] = q;
  }
  return Object.keys(out).length === 0 ? MOOD_QUESTIONS : out;
}

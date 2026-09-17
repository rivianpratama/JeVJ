# JeVJ Visualizer Design Spec (2026-09-17)

> **v1 design; superseded.** This is the design the app was first built to, and
> it is kept for the reasoning behind the analysis, the mood taxonomy and the
> look. Three of its load-bearing decisions no longer hold: it is a local app
> rather than a Vercel one, playback is a downloaded file through one media
> element rather than the YouTube IFrame API with `getDisplayMedia` tapping the
> tab, and the whole analysis runs *before* a note plays rather than
> periodically while one does. Where this document and
> `docs/superpowers/plans/2026-09-17-jevj-v2-download-pipeline.md` disagree
> about hosting, playback source or analysis timing, the v2 plan is right.

Status: approved by user in planning session 2026-09-17. Supersedes nothing; greenfield.

## Context

JeVJ (`/Users/rivianpratama/Documents/GitHub/JeVJ`, empty repo) is a browser visualizer: paste a YouTube link, press play, and the whole page becomes a TouchDesigner-grade three.js visual that adapts to the *mood* of whatever is playing, from a Mahler adagio to a 150 BPM drop to a podcast. The mood is not hand-coded from thresholds; it is judged by TypeSafe's Jev (System One model, ~100–300 ms per request) from a compact JSON summary of the music that the browser computes with Web Audio and music-theory-derived analysis. The reference images show the target look: liquid-ink feedback fields, GPGPU particle clouds, silk strands, mirrored monochrome relief, acid chroma-shifted textures, with an oval blurred-edge card in the center showing the video.

Hard constraints from the user:
- **Hosted on Vercel Hobby.** No yt-dlp / server-side extraction (YouTube blocks datacenter IPs, Hobby functions can't stream long audio). Playback uses the official YouTube IFrame API; analysis taps tab audio via `getDisplayMedia` (Chromium). Fallback input: local audio file drop. No microphone.
- **Jev is text-only** (confirmed in docs): the browser extracts features, Jev judges mood. Input JSON must be concise; calls are periodic, not per-frame.
- **Actually use Jev for the mood** (user's standing feedback from the JevPixelArt experiment: don't substitute local heuristics for what the tool is being tested on). Local DSP feeds Jev and handles only the sub-second reactivity Jev cannot.
- Stack: **Vite + TypeScript + three.js**, one Vercel serverless function holding the TypeSafe key. Center card: **oval-ish**, feathered/blurred edge, video inside.

Sources consulted (music theory + MIR): Open Music Theory (mode/meter), Wikipedia on music & emotion (Juslin; tempo/mode/loudness/articulation → affect table), Krumhansl–Kessler key profiles (rnhart.net), consonance/dissonance (Plomp–Levelt critical band), Italian tempo markings, syncopation, timbre correlates, musical form. TypeSafe docs: API contract, Score/Noul/Choice, structured criteria, parallel questions cookbook (13 questions in one call, 0.27 s). Prior art: noisotron (`/Users/rivianpratama/Documents/GitHub/noisotron/main.js`) 5-axis taxonomy + thresholds at lines 2359–2420, adaptive smoothing window, v2 log-band adaptive normalization at `v2/index.html:880–930`.

## Architecture: two-tier reactivity

```
YouTube iframe (playback)        file drop (<audio>)
        │ tab audio capture                │ MediaElementSource
        └──────────► AudioContext ◄────────┘
                         │ AnalyserNode (fft 4096) + time-domain
        ┌────────────────┴────────────────┐
  FAST LAYER (every frame, local)   SLOW LAYER (Jev, every 2.5–8 s)
  bands, RMS, onsets, beat phase,   summarizer → MoodInput JSON (~120 tok)
  flux, chroma                      → POST /api/mood → Jev (≈14 parallel
        │                              questions) → MoodVector
        │                                   │ slewed over ~2 s
        └──────────► Director ◄─────────────┘
              scene weights, palette, post params, impulses
                         │
              three.js scenes → EffectComposer → canvas (fullscreen bg)
```

- **Fast layer** gives beat-locked punch (kicks, strobes, particle bursts) that a 100 ms round trip cannot.
- **Slow layer** decides *what the music feels like*: valence, arousal, tension, warmth, organic↔synthetic, space, speech-vs-music, genre family, section (build/drop/breakdown), motion character. It selects and blends scenes and palettes.
- Jev never sees audio; it sees a musician's-shorthand summary built with theory-aware code (key/mode, tempo marking, dynamics class, consonance, syncopation, articulation).

## Repo layout (new files)

```
index.html
package.json  vite.config.ts  tsconfig.json  vercel.json  .env.example  .gitignore
api/mood.ts                       Vercel function: validate MoodInput → Jev → MoodVector
src/main.ts                       bootstrap, loop, wiring
src/ui/        card.ts controls.ts toast.ts hud.ts styles.css
src/source/    youtubePlayer.ts tabCapture.ts fileSource.ts audioGraph.ts urlParse.ts
src/analysis/  features.ts onset.ts tempo.ts key.ts rhythm.ts dynamics.ts timbre.ts speech.ts summarizer.ts types.ts
src/mood/      questions.ts (shared w/ api) moodClient.ts moodState.ts types.ts
src/visuals/   director.ts palette.ts
src/visuals/scenes/  Scene.ts InkFeedback.ts ParticleField.ts Strands.ts Relief.ts Breath.ts
src/visuals/post/    Composer.ts MirrorPass.ts ChromaPass.ts GrainVignettePass.ts
src/visuals/shaders/ *.glsl (imported via `?raw`)
src/shared/    moodSchema.ts (MoodInput/MoodVector types + runtime validation, used by api/ and src/)
docs/superpowers/specs/2026-09-17-jevj-visualizer-design.md   (spec, per brainstorming skill)
docs/music-theory-notes.md        what theory was applied and how it maps to features/questions
tests/analysis/*.test.ts          vitest on synthetic signals
```

## Part 1 — Sources & UI

**URL parsing** (`urlParse.ts`): accept `watch?v=`, `youtu.be/`, `/shorts/`, `music.youtube.com`, `?t=` start offsets.

**YouTube player** (`youtubePlayer.ts`): load `https://www.youtube.com/iframe_api`, `new YT.Player` with `playsinline`, `controls: 0`, `rel: 0`, `origin`. Expose `load(id)`, `play()`, `pause()`, `state$`, `currentTime()`, `duration()`, `title()`. Map errors 101/150 → toast "owner disabled embedding, try another link"; 100 → not found.

**Tab capture** (`tabCapture.ts`): on first Play, `getDisplayMedia({ video: true, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' })`; stop the video track immediately, keep the audio track, `MediaStreamAudioSourceNode` → analyser (never to destination; playback stays with the iframe). Handle `ended` (user stops sharing) → analysis goes to idle mode with toast. Feature-detect: not Chromium / no `getDisplayMedia` → banner explaining Chrome/Edge requirement and offering file drop.

**File source** (`fileSource.ts`): drag-drop / picker → `<audio>` → `MediaElementAudioSourceNode` → analyser + destination. Same controls drive it. Card shows filename instead of iframe.

**Audio graph** (`audioGraph.ts`): single `AudioContext` (resume on user gesture), `AnalyserNode` fft 4096, `smoothingTimeConstant 0` (smooth manually, as noisotron does), float frequency data in dB, time-domain buffer.

**UI** (`ui/`): URL input bar top-center (glassy, blurred), oval card center, play/pause pill under it, HUD toggle (`H`) showing BPM / key / mood vector / Jev tokens used / call count. Card: wrapper with `aspect-ratio: 16/9`, `border-radius: 50% / 45%` (superellipse via `clip-path` if needed), feathered edge via `mask-image: radial-gradient(ellipse at center, #000 62%, transparent 100%)` plus an outer `backdrop-filter: blur` halo ring so the video melts into the visualizer like the reference. Iframe fills the wrapper and is cropped by the oval.

## Part 2 — Analysis (fast layer + summarizer)

All modules are pure functions over typed arrays, unit-tested with synthetic signals.

- **features.ts**: per frame — RMS, dBFS loudness, 8 log-spaced band energies (20 Hz–16 kHz) with the v2 adaptive attack/release normalization, spectral centroid (Hz), flatness, rolloff, spectral flux (half-wave rectified), ZCR, **chroma** (12 pitch classes by folding FFT bins ≥ 60 Hz onto MIDI pitch classes with magnitude weighting).
- **onset.ts**: onset envelope = band-wise spectral flux; adaptive median threshold; emits `onset(strength)`; tracks `beatPhase` 0–1 from tempo + last beat.
- **tempo.ts**: autocorrelation of the last ~6 s onset envelope, 60–200 BPM search, octave disambiguation preferring 90–150 unless evidence strong; `bpm`, `beatConfidence`, and the **Italian tempo marking** (Largo <66, Adagio 66–76, Andante 76–108, Moderato 108–120, Allegro 120–156, Vivace 156–176, Presto >176).
- **key.ts**: accumulate chroma over the window (exp decay ~8 s), correlate with **Krumhansl–Kessler** profiles (major `6.35 2.23 3.48 2.33 4.38 4.09 2.52 5.19 2.39 3.66 2.29 2.88`, minor `6.33 2.68 3.52 5.38 2.60 3.53 2.54 4.75 3.98 2.69 3.34 3.17`) across 24 keys → `key`, `mode`, `modeConfidence` (margin between best major and best minor). Also report modal flavor when the 7-note set fits Dorian/Phrygian/Lydian/Mixolydian better than Ionian/Aeolian.
- **rhythm.ts**: beat regularity (variance of inter-onset intervals), **syncopation index** (onset energy at off-beat phases 0.25/0.5/0.75 vs on-beat), meter guess duple vs triple from autocorrelation peaks at 2× vs 3× beat period.
- **dynamics.ts**: short-term loudness (LUFS-ish via K-weighting approximation or A-weighted RMS), loudness range over the window (classical wide vs compressed pop), pp–ff class from relative loudness within the session's running range, **trend** building/fading/steady (noisotron's 60-frame compare), crest factor.
- **timbre.ts**: brightness (centroid normalized), noisiness (flatness), **roughness/consonance** estimate: weight chroma pair energies by interval-class dissonance (m2/M7 and tritone high, P5/P8 low, thirds/sixths medium) → `consonance` 0–1; **attack sharpness** (staccato vs legato) from mean onset rise slope; sub weight (20–60 Hz band share).
- **speech.ts**: speech-likeness from 3–6 Hz amplitude-modulation energy of the envelope, ZCR variance, moderate flatness, weak tempo periodicity, harmonicity concentrated 100–400 Hz, spectral centroid 1–3 kHz. Output 0–1.
- **summarizer.ts**: every frame updates running stats; on demand emits a **MoodInput** (~110–140 tokens), e.g.:

```json
{"pos":"1:32/4:05","bpm":128,"tempo":"allegro","beatConf":0.9,"meter":"duple","sync":0.3,"regular":0.9,
 "key":"F#","mode":"minor","modeConf":0.7,"modal":"aeolian","consonance":0.6,
 "loud":"f","range":0.2,"trend":"building","crest":0.3,
 "bright":0.7,"noise":0.4,"attack":"sharp","sub":0.8,"bands":[9,8,6,5,5,6,7,5],
 "speech":0.05,"onsets/s":4.2}
```
  Numbers rounded to 1–2 significant digits, bands as 0–9 integers, strings from fixed vocabularies. Also computes a **novelty score** (distance between the current and last-sent MoodInput vectors) to drive call cadence.

## Part 3 — Mood layer (Jev)

**questions.ts** (shared): one `systemOne` request, all independent, ~14 questions with structured criteria (`what` / `signals` per level, per TypeSafe advanced-structure guidance):

| id | type | meaning |
|---|---|---|
| valence | Score 5 | grieving → bittersweet → neutral → uplifting → euphoric |
| arousal | Score 5 | still → calm → moving → driving → frantic |
| tension | Score 5 | resolved/restful → … → unbearable suspense |
| warmth | Score 5 | icy/cold → cool → neutral → warm → hot/glowing |
| synthetic | Score 5 | fully acoustic/organic → … → fully electronic/machine |
| space | Score 5 | intimate/close → … → vast/cathedral |
| aggression | Noul | is this hostile, abrasive, violent in character? |
| melancholy | Noul | does it carry sadness or longing? |
| hypnotic | Noul | trance-like, repetitive, entrancing? |
| euphoric_peak | Noul | is this a climax/drop moment right now? |
| spoken | Noul | is this primarily spoken word (podcast, speech) rather than music? |
| genre | Choice | classical / jazz / electronic_dance / hiphop_trap / rock_metal / ambient_drone / pop / folk_acoustic / spoken |
| section | Choice | intro / verse_steady / build / drop_climax / breakdown / outro |
| motion | Choice | flow / pulse / shatter / drift / swarm / bloom (how the visuals should *move*) |

State = the MoodInput object plus a fixed ~40-token preamble describing field meanings (sent every call; it's small). Answers → **MoodVector** (all normalized 0–1 via `score/(levels-1)`, Nouls as probabilities, Choices with probabilities kept for soft blending).

**api/mood.ts**: Vercel Node function. `@typesafe-ai/sdk` `TypeSafeClient` with `TYPESAFE_API_KEY` from env, `model: 'jev-latest'`. Validates body against `moodSchema`, rejects >2 KB, simple per-IP token bucket (Hobby safety). Returns `{mood, usage, latencyMs}`. Retries 429/529 once with backoff. Key never reaches the browser.

**moodClient.ts** cadence (token conservation):
- first call 1.5 s after audio starts;
- then `next = clamp(8 s − 5.5 s × novelty, 2.5 s, 8 s)`; a detected section change (energy trend flip, onset-density jump, key change) forces a call at the 2.5 s floor;
- skip when paused, when the page is hidden, or when novelty < 0.05 (music unchanged);
- in-flight guard (one request at a time), exponential backoff on errors, HUD shows tokens/min.
- Budget at ~100 input tokens/question: ≈1.5–2 k tokens per call, ≈12–25 k tokens/min on active music, far less on steady passages.

**moodState.ts**: holds target MoodVector, slews current toward it (τ ≈ 1.5 s for scores, faster for `euphoric_peak`/`section`), exposes `confidence`. Offline/error fallback: keep last vector, or a neutral default with arousal derived locally from RMS so visuals never freeze.

## Part 3b — Cue timeline: hitting the drop at the exact millisecond

The visualizer does not react to Jev's answers directly. Everything is written onto a **cue timeline** at 200 ms resolution, indexed by the *audio clock* (`AudioContext.currentTime`, not rAF), and the Director reads the cue for "now" every frame with interpolation. Sharp events (drop, downbeat, section flip) are stored as exact timestamps on that timeline, so the visual fires on the sample, not on the next Jev reply.

```ts
// src/timeline/types.ts
type Cue = { t: number /* audio-clock seconds */, mood: Partial<MoodVector>, impact?: number /* 0-1, sharp hit */,
             section?: Section, beat?: boolean, downbeat?: boolean, source: 'jev'|'grid'|'detector'|'offline' }
type Timeline = { step: 0.2, cues: Cue[] /* sorted by t; spans now-2s .. now+8s in live mode, whole track in file mode */ }
```

Three writers fill the same timeline:

1. **Beat grid (`analysis/grid.ts`)**: from `tempo.ts` bpm + beat phase, predicts the next 16 beat times to within ±10–20 ms and marks downbeats (bar = 4 beats unless triple meter). Keeps a **phrase counter**: bars since the last section change; EDM/pop phrases are 8/16/32 bars, so the most likely drop instant is the downbeat of the next phrase boundary.
2. **Jev (predictive questions, added to the same request)**: the MoodInput gains build cues — energy slope over last 4 and 8 bars, onset-density ratio vs. 8 bars ago (snare rolls double/quadruple), centroid slope (risers), `gap` (silence/filter dip in the last beat), `barsSinceChange`, `barInPhrase`. New questions: `drop_imminent` Noul ("will a drop / climax land within the next 2 bars?"), `beats_to_change` Choice (1 / 2 / 4 / 8 / 16 / none), `impact` Score 5 (how hard the incoming moment will hit), `pre_drop_style` Choice (silence-then-slam / riser / snare-roll / gradual swell). Code converts these into cues **snapped to the grid**: e.g. at the predicted phrase-boundary downbeat write `{impact: 0.9, section: 'drop_climax'}`, and 2 bars before it write tightening cues (`build`, contracting particles, rising feedback decay) so the visual *leads into* the hit.
3. **Local detector (`analysis/drop.ts`, per frame)**: the instant confirmer. Within ±1 beat of a predicted cue, a broadband + sub-band energy jump ≥ ~8 dB relative to the preceding dip triggers the impact **immediately** (within one analyser hop, ≈5–10 ms) and re-anchors the timeline to the measured instant. If no transient arrives, the predicted cue decays gracefully (no fake drop). If a drop arrives unpredicted, the detector still fires it (less anticipation, same exact hit). Also emits `beat`/`downbeat` cues from onsets to keep the grid phase-locked.

Live mode (YouTube via tab capture) uses all three writers for a rolling now−2 s … now+8 s window. **File mode** additionally does a full **offline pre-analysis** (`OfflineAudioContext` decode → feature timeline for the whole track → novelty-based segmentation → one Jev call per segment, ~10–40 calls per track, plus exact drop timestamps from the detector run offline) and writes the *entire* track's cue timeline before playback starts, so every hit is known in advance and anticipation can be exact.

Latency handling: measured capture offset (`baseLatency` + `outputLatency` + iframe-to-capture path, typically 20–60 ms) is subtracted when converting analyser time to audio-clock cue time; HUD exposes a ±200 ms trim slider persisted in `localStorage`. The Jev cadence also schedules a call ~1 s before each predicted phrase boundary so the predictive answers are fresh when they matter.

Files: `src/timeline/{types.ts,timeline.ts,gridWriter.ts,jevWriter.ts,detectorWriter.ts,offlineAnalyzer.ts}`. Tests: click track with a silent bar then a full-band slam → detector fires within one hop of the slam and the grid predicts the slam's downbeat within ±25 ms; synthetic riser + snare roll → build cues rise monotonically; offline analyzer on a generated 60 s file yields a timeline covering every 200 ms with the slam timestamp exact.

## Part 4 — Visuals (be creative; concert grade)

Fullscreen `WebGLRenderer` behind the UI, `EffectComposer` chain. Scenes render into shared targets and are **blended by weight** in a final composite pass so moods crossfade over seconds rather than hard-cutting.

Scenes (`scenes/`):
1. **InkFeedback** — ping-pong `WebGLRenderTarget` feedback fluid: previous frame advected by curl-noise flow, displaced by low bands, slowly decaying; palette gradient mapped by luminance. The marbled liquid of reference 1. Always-on base layer; `motion=flow/drift` favors it.
2. **ParticleField** — `GPUComputationRenderer` (position/velocity textures, 512²–1024² points) with curl noise, mood-chosen attractor (sphere / plane / vortex / explode), onsets inject radial impulses, `arousal` scales speed, `synthetic` sharpens point sprites. References 4 and 6.
3. **Strands** — instanced ribbons along a flow field (vertical silk of reference 6), tension bends them, sub band thickens them; favored by `motion=drift/flow`, low-mid arousal.
4. **Relief** — displaced plane rendered monochrome with rim light, fed through MirrorPass for the black/white symmetrical reference 2 and the charcoal-red relief of reference 5; favored by melancholy, aggression, `rock_metal`, `ambient_drone`.
5. **Breath** — speech/podcast mode: slow, near-monochrome field that breathes with the speech envelope, subtle waveform ridges, no strobing; engaged when `spoken > 0.6`.

Post (`post/`): **MirrorPass** (kaleidoscopic n-fold, n from tension, enabled by `hypnotic`), **ChromaPass** (chromatic aberration + posterize/palette-shift for the acid look of reference 3, driven by `synthetic × arousal`), bloom (`UnrealBloomPass`, strength from arousal, threshold from valence), **GrainVignettePass** (film grain ∝ noisiness, vignette ∝ space⁻¹), final feedback trail.

**Director** (`director.ts`): pure function `(mood, frame, dt) → RenderParams`:
- scene weights via soft rules (e.g. `particles = arousal·(1−spoken)`, `strands = (1−arousal)·(0.5+tension/2)`, `relief = max(melancholy, aggression)·0.8`, `breath = spoken`), normalized, slewed;
- **palette** (`palette.ts`, OKLCH ramps): hue from warmth (violet/ice → amber/crimson), saturation from valence, lightness contrast from arousal, desaturate with melancholy, genre families nudge hue (jazz: brass/indigo; classical: ivory/graphite; edm: neon);
- the Director reads the **cue timeline** (Part 3b) for the current audio-clock time: `impact` cues → burst + exposure lift on the exact sample, `downbeat` cues → global pulse, `build` cues → rising feedback decay, contracting particles and camera dolly; per-frame onsets → particle kick + feedback displacement; sub → camera breathing;
- `motion` choice selects the flow-field style (laminar / turbulent / radial / swarm);
- safety: strobe rate capped (<3 Hz luminance flips), reduced-motion media query respected.

Idle (no audio yet): slow autonomous drift so the page is never blank.

## Part 5 — Docs & tests

- `docs/superpowers/specs/2026-09-17-jevj-visualizer-design.md`: this design, per brainstorming skill.
- `docs/music-theory-notes.md`: the theory → feature → question mapping (mode/valence, tempo markings, dynamics classes, consonance intervals, syncopation, articulation → affect per Juslin's table), so future tuning is grounded.
- `tests/analysis`: vitest — 120 BPM click track → bpm≈120 & regular≈1; C-major sawtooth chord → key C major; A-minor → minor; white noise → flatness≈1, consonance low; 4 Hz AM noise burst → speech high; loud→quiet ramp → trend fading; syncopated pattern → sync > straight pattern.
- `tests/mood`: schema validation, cadence scheduler (novelty → interval), summarizer token length (< 160 tokens by a rough tokenizer estimate).

## Implementation order

1. Scaffold (Vite+TS+three, vitest, vercel.json, `.env.example` with `TYPESAFE_API_KEY`), `.gitignore` incl. `.env`.
2. UI shell: URL bar, oval feathered card with YouTube player, play/pause, toast, HUD. Verify embed + errors.
3. Audio graph + tab capture + file drop; analyser producing FrameFeatures; HUD shows bands/RMS.
4. Analysis modules with tests (tempo, key, rhythm, dynamics, timbre, speech) → summarizer MoodInput.
5. `api/mood.ts` + questions (incl. predictive ones) + moodClient + moodState; HUD shows live MoodVector and tokens. `vercel dev` locally.
5b. Timeline: grid writer, detector writer, Jev writer, offline analyzer for files; HUD timeline strip showing upcoming cues and the measured latency trim.
6. Visuals: InkFeedback + post chain first (whole page already looks good), then ParticleField, Strands, Relief, Breath; Director blending and palette.
7. Tuning pass across genres; docs; commit spec and notes.

## Verification

- `npm run dev` + `vercel dev` (or Vite proxy to `vercel dev` port) with a real `TYPESAFE_API_KEY`.
- Manual: paste links for a classical adagio, an EDM track with a drop, a trap beat, a metal track, a jazz trio, an ambient piece, a podcast. Confirm: capture dialog appears once, audio audible, HUD BPM/key plausible, Jev calls at 2.5–8 s cadence with tokens shown, visuals shift scene/palette per genre, podcast goes to Breath mode.
- Drop timing: on the EDM track, HUD timeline shows a predicted `impact` cue on the phrase-boundary downbeat before the drop and the visual burst lands on the drop with no perceptible lag (record screen + audio, check the frame of the burst against the waveform transient; target < 1 frame after the transient, adjustable with the latency trim).
- Drop a local mp3 → same pipeline without capture dialog.
- Firefox/Safari → banner + file drop still works.
- `npm test` green; `npm run build` clean; deploy preview to Vercel with env var set and repeat one YouTube run there.
- Watch network: MoodInput bodies < 2 KB; no key in client bundle (`grep` the dist for `TYPESAFE`).

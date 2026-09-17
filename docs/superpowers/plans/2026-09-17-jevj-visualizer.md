# JeVJ Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Vercel-hosted three.js visualizer that plays a YouTube link inside an oval feathered card, analyzes the tab's audio with music-theory-aware DSP, asks TypeSafe's Jev for the mood every few seconds from a ~130-token JSON, and renders concert-grade visuals that hit drops on the exact sample via a beat-grid cue timeline.

**Architecture:** Two-tier reactivity. Fast layer (per frame, local DSP) drives beat-locked punch; slow layer (Jev, 2.5–8 s cadence, one serverless function) decides mood, genre, section, and predicted drops. Both write onto a 200 ms cue timeline indexed by the audio clock; the Director reads the timeline and blends five three.js scenes through a post chain.

**Tech Stack:** Vite 8 + TypeScript (strict) + three 0.186 (addons: EffectComposer, UnrealBloomPass, ShaderPass, GPUComputationRenderer) + vitest 5 + `@typesafe-ai/sdk` 0.6 (server only) + Vercel Node functions (`@vercel/node` types). No React, no CSS framework.

Spec: `docs/superpowers/specs/2026-09-17-jevj-visualizer-design.md`. Theory: `docs/music-theory-notes.md`.

## Global Constraints

- Hosted on **Vercel Hobby**; no server-side YouTube extraction. Playback = official YouTube IFrame API; live analysis = `getDisplayMedia` tab audio (Chromium). Fallback input = local audio file drop. **No microphone.**
- Jev is **text-only**. The browser never sends audio. `MoodInput` JSON must stay **under 160 tokens** (≈ 640 chars); numbers rounded to ≤ 2 significant digits; strings from fixed vocabularies. Server rejects bodies over 2 KB.
- The mood **must come from Jev** (Score/Noul/Choice answers). Local heuristics only feed Jev and handle sub-second reactivity. Never fake a MoodVector from thresholds except the documented offline fallback (keep last vector).
- `TYPESAFE_API_KEY` lives only in `.env` (gitignored) and Vercel env. It must never appear in the client bundle. Client calls `POST /api/mood` only.
- All analysis modules under `src/analysis/**` and `src/timeline/**` are **pure** (no DOM, no Web Audio) so vitest runs them in Node.
- Timing is on the **audio clock** (`AudioContext.currentTime`), never `performance.now()` for cues.
- Cue timeline **step = 0.2 s**. Sharp events keep exact timestamps.
- Visual safety: luminance flip rate capped below **3 Hz**; respect `prefers-reduced-motion` (halve motion amplitudes, disable strobe, disable mirror).
- File names and module boundaries in this plan are binding. One responsibility per file. GLSL lives in `src/visuals/shaders/*.glsl` imported with `?raw`.
- Commit after each task with a conventional-commit subject; end commit bodies with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

```
index.html                         page shell: #bg canvas mount, #ui root
package.json vite.config.ts tsconfig.json vitest.config.ts vercel.json .env.example .gitignore README.md
api/mood.ts                        Vercel function → server/moodHandler
server/moodHandler.ts              framework-agnostic: validate → Jev → MoodVector (uses @typesafe-ai/sdk)
server/devApiPlugin.ts             Vite dev middleware mounting /api/mood on server/moodHandler
src/main.ts                        bootstrap + frame loop wiring
src/shared/types.ts                FrameFeatures, MoodInput, MoodVector, Cue, Timeline, enums
src/shared/moodSchema.ts           runtime validation for MoodInput/MoodVector (hand-written, no zod)
src/shared/tokens.ts               estimateTokens(str) ≈ chars/4 + numbers
src/ui/styles.css  card.ts  controls.ts  toast.ts  hud.ts  banner.ts
src/source/urlParse.ts  youtubePlayer.ts  tabCapture.ts  fileSource.ts  audioGraph.ts  latency.ts
src/analysis/fft.ts  features.ts  onset.ts  tempo.ts  grid.ts  key.ts  rhythm.ts  dynamics.ts  timbre.ts  speech.ts  drop.ts  summarizer.ts  ring.ts
src/mood/questions.ts  moodClient.ts  moodState.ts  decode.ts
src/timeline/timeline.ts  gridWriter.ts  jevWriter.ts  detectorWriter.ts  offlineAnalyzer.ts
src/visuals/renderer.ts  director.ts  palette.ts  oklch.ts
src/visuals/scenes/Scene.ts  InkFeedback.ts  ParticleField.ts  Strands.ts  Relief.ts  Breath.ts
src/visuals/post/Composer.ts  MirrorPass.ts  ChromaPass.ts  GrainVignettePass.ts  BlendPass.ts
src/visuals/shaders/*.glsl
tests/**                            vitest mirrors src/
```

---

### Task 1: Scaffold, shared types, schema, token estimator

**Files:**
- Create: `package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `vercel.json`, `.env.example`, `.gitignore`, `index.html`, `src/main.ts`, `src/vite-env.d.ts`, `src/shared/types.ts`, `src/shared/moodSchema.ts`, `src/shared/tokens.ts`, `server/devApiPlugin.ts` (stub that 501s until Task 7), `README.md`
- Test: `tests/shared/moodSchema.test.ts`, `tests/shared/tokens.test.ts`

**Interfaces produced (binding for every later task):**

```ts
// src/shared/types.ts
export const BAND_EDGES_HZ = [20, 60, 130, 250, 500, 1000, 2000, 5000, 16000] as const; // 8 bands
export type TempoMarking = 'largo'|'adagio'|'andante'|'moderato'|'allegro'|'vivace'|'presto';
export type Meter = 'duple'|'triple'|'unclear';
export type Mode = 'major'|'minor'|'unclear';
export type ModalFlavor = 'ionian'|'dorian'|'phrygian'|'lydian'|'mixolydian'|'aeolian'|'locrian'|'unclear';
export type DynClass = 'pp'|'p'|'mp'|'mf'|'f'|'ff';
export type Trend = 'building'|'fading'|'steady';
export type Attack = 'sharp'|'soft'|'mixed';
export const GENRES = ['classical','jazz','electronic_dance','hiphop_trap','rock_metal','ambient_drone','pop','folk_acoustic','spoken'] as const;
export type Genre = typeof GENRES[number];
export const SECTIONS = ['intro','verse_steady','build','drop_climax','breakdown','outro'] as const;
export type Section = typeof SECTIONS[number];
export const MOTIONS = ['flow','pulse','shatter','drift','swarm','bloom'] as const;
export type Motion = typeof MOTIONS[number];
export const BEATS_TO_CHANGE = ['1','2','4','8','16','none'] as const;
export type BeatsToChange = typeof BEATS_TO_CHANGE[number];
export const PRE_DROP_STYLES = ['silence_slam','riser','snare_roll','swell','none'] as const;
export type PreDropStyle = typeof PRE_DROP_STYLES[number];

export interface FrameFeatures {
  t: number;              // audio-clock seconds at which this frame was measured
  rms: number;            // 0..1 linear
  db: number;             // dBFS, -100..0
  bands: Float32Array;    // 8, adaptive-normalized 0..1
  bandsRaw: Float32Array; // 8, mean linear magnitude per band
  centroid: number;       // Hz
  flatness: number;       // 0..1
  rolloff: number;        // Hz where 95% cumulative energy is reached
  flux: number;           // half-wave rectified spectral flux, >=0
  zcr: number;            // zero crossings per second
  chroma: Float32Array;   // 12, sums to 1 (all zeros if silent)
  sub: number;            // share of energy in 20-60 Hz, 0..1
}

export interface MoodInput {
  pos: string; bpm: number; tempo: TempoMarking; beatConf: number; meter: Meter;
  sync: number; regular: number;
  key: string; mode: Mode; modeConf: number; modal: ModalFlavor; consonance: number;
  loud: DynClass; range: number; trend: Trend; crest: number;
  bright: number; noise: number; attack: Attack; sub: number; bands: number[]; // 8 ints 0..9
  speech: number; onsetsPerSec: number;
  slope4: number; slope8: number; onsetRatio: number; centroidSlope: number; gap: boolean;
  barsSinceChange: number; barInPhrase: number;
}

export interface MoodVector {
  valence: number; arousal: number; tension: number; warmth: number; synthetic: number; space: number;
  aggression: number; melancholy: number; hypnotic: number; euphoricPeak: number; spoken: number;
  genre: Genre; genreP: Record<Genre, number>;
  section: Section; sectionP: Record<Section, number>;
  motion: Motion; motionP: Record<Motion, number>;
  dropImminent: number; beatsToChange: BeatsToChange; impact: number; preDropStyle: PreDropStyle;
  confidence: number;
}

export type CueSource = 'jev'|'grid'|'detector'|'offline';
export interface Cue {
  t: number; source: CueSource;
  mood?: Partial<MoodVector>; impact?: number; section?: Section; beat?: boolean; downbeat?: boolean; build?: number; // build 0..1 anticipation ramp
}
export interface Timeline { step: 0.2; cues: Cue[] }

export interface MoodResponse { mood: MoodVector; usage: { input_tokens: number; output_tokens: number }; latencyMs: number }
```

```ts
// src/shared/moodSchema.ts
export function validateMoodInput(x: unknown): { ok: true; value: MoodInput } | { ok: false; error: string };
export function validateMoodVector(x: unknown): { ok: true; value: MoodVector } | { ok: false; error: string };
export const NEUTRAL_MOOD: MoodVector; // all scores 0.5, nouls 0.2, genre 'pop', section 'verse_steady', motion 'flow', beatsToChange 'none', preDropStyle 'none', impact 0.3, dropImminent 0.1, confidence 0
```
Validation rules: every numeric field finite and within 0..1 except `bpm` (0..300), `slope4/slope8` (−60..60), `onsetRatio` (0..20), `onsetsPerSec` (0..20), `centroidSlope` (−1..1), `barsSinceChange` (0..999), `barInPhrase` (0..31), `crest` (0..1); `bands` exactly 8 ints 0..9; enum fields must be members of the const arrays; `pos` matches `/^\d+:\d{2}\/(\d+:\d{2}|live)$/`; `key` matches `/^([A-G][#b]?|\?)$/`.

```ts
// src/shared/tokens.ts
export function estimateTokens(s: string): number; // Math.ceil(s.length / 3.2) — conservative for JSON with digits/punctuation
```

- [ ] **Step 1: package.json**

```json
{
  "name": "jevj", "private": true, "version": "0.1.0", "type": "module",
  "scripts": { "dev": "vite", "build": "tsc --noEmit && vite build", "preview": "vite preview", "test": "vitest run", "test:watch": "vitest" },
  "dependencies": { "three": "^0.186.0", "@typesafe-ai/sdk": "^0.6.0" },
  "devDependencies": { "vite": "^8.3.0", "vitest": "^5.0.0", "typescript": "^5.6.0", "@types/three": "^0.186.0", "@vercel/node": "^5.0.0", "@types/node": "^22.0.0" }
}
```
Run `npm install`. If `@types/three@0.186` does not exist, use the latest available `@types/three`.

- [ ] **Step 2: tsconfig.json** — `"strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2022","DOM","DOM.Iterable"], "types": ["vite/client","node"], "noUncheckedIndexedAccess": true, "include": ["src","server","api","tests","vite.config.ts","vitest.config.ts"]`.

- [ ] **Step 3: vite.config.ts** — `defineConfig({ plugins: [devApiPlugin()], server: { port: 5173 } })`. `server/devApiPlugin.ts` exports `devApiPlugin(): Plugin` with `configureServer(server)` that registers `server.middlewares.use('/api/mood', handler)`; for this task the handler responds `501 {"error":"not implemented"}`. Load env with `loadEnv(mode, process.cwd(), '')` inside the plugin (so `TYPESAFE_API_KEY` is available to Task 7 without exposing it to the client).

- [ ] **Step 4: vitest.config.ts** — `test: { include: ['tests/**/*.test.ts'], environment: 'node' }`.

- [ ] **Step 5: vercel.json** — `{ "framework": "vite", "functions": { "api/**/*.ts": { "maxDuration": 10 } } }`. `.env.example` contains `TYPESAFE_API_KEY=`. `.gitignore`: `node_modules dist .env .env.* !.env.example .vercel .superpowers .DS_Store`.

- [ ] **Step 6: index.html** — dark page, `<canvas id="bg">` fixed fullscreen behind `<div id="ui">`. Loads `/src/main.ts`. `src/main.ts` for now: `document.title = 'JeVJ'` and a console line. `src/vite-env.d.ts`: `/// <reference types="vite/client" />` plus `declare module '*.glsl?raw' { const s: string; export default s }`.

- [ ] **Step 7: Write failing tests**

`tests/shared/moodSchema.test.ts`: (a) a fully valid MoodInput fixture passes; (b) `bands` with 7 entries fails; (c) `tempo: 'fast'` fails; (d) `pos: '1:32/live'` passes and `pos: '92s'` fails; (e) `NEUTRAL_MOOD` passes `validateMoodVector`; (f) MoodVector with `genreP` missing a genre fails.
`tests/shared/tokens.test.ts`: `estimateTokens('')===0`; a 640-char string estimates ≥ 160 and ≤ 220.

- [ ] **Step 8: Run tests, verify fail** — `npx vitest run` → modules not found.
- [ ] **Step 9: Implement types, schema, tokens.** Schema is hand-written checks; keep helper `num(x, lo, hi)` and `oneOf(x, list)`.
- [ ] **Step 10: Run tests, verify pass; `npm run build` passes.**
- [ ] **Step 11: README.md** — one paragraph, how to run (`cp .env.example .env`, put key, `npm i`, `npm run dev`), Chrome requirement, deploy note (set `TYPESAFE_API_KEY` in Vercel project env).
- [ ] **Step 12: Commit** `chore: scaffold vite+ts+three, shared types and schema`.

---

### Task 2: UI shell — URL parsing, YouTube player, oval card, controls, toast, banner, HUD skeleton

**Files:**
- Create: `src/source/urlParse.ts`, `src/source/youtubePlayer.ts`, `src/ui/styles.css`, `src/ui/card.ts`, `src/ui/controls.ts`, `src/ui/toast.ts`, `src/ui/banner.ts`, `src/ui/hud.ts`
- Modify: `index.html`, `src/main.ts`
- Test: `tests/source/urlParse.test.ts`

**Interfaces produced:**
```ts
// urlParse.ts
export function parseYouTubeUrl(input: string): { videoId: string; startSeconds: number } | null;
// youtubePlayer.ts
export type PlayerState = 'unstarted'|'ended'|'playing'|'paused'|'buffering'|'cued';
export interface YouTubePlayer {
  load(videoId: string, startSeconds?: number): Promise<void>;
  play(): void; pause(): void;
  currentTime(): number; duration(): number; title(): string;
  onState(cb: (s: PlayerState) => void): () => void;
  onError(cb: (code: number, message: string) => void): () => void;
}
export function createYouTubePlayer(mount: HTMLElement): YouTubePlayer;
// card.ts
export function createCard(root: HTMLElement): { playerMount: HTMLElement; setLabel(text: string): void; setMode(m: 'video'|'file'): void };
// controls.ts
export function createControls(root: HTMLElement, h: { onSubmitUrl(url: string): void; onPlay(): void; onPause(): void; onFile(f: File): void }): { setPlaying(b: boolean): void; setBusy(b: boolean): void };
// toast.ts
export function toast(message: string, kind?: 'info'|'error', ms?: number): void;
// banner.ts
export function showBanner(html: string): void; export function hideBanner(): void;
// hud.ts
export interface HudData { bpm?: number; beatConf?: number; key?: string; mode?: string; tempo?: string; loud?: string; speech?: number; mood?: Record<string, number|string>; tokensTotal?: number; calls?: number; lastLatencyMs?: number; upcoming?: { dt: number; label: string }[]; latencyTrimMs?: number }
export function createHud(root: HTMLElement, onTrim: (ms: number) => void): { update(d: HudData): void; toggle(): void };
```

**Design (binding):**
- Page background is the visualizer canvas (Task 9). UI is a thin layer: top-center URL bar (glass: `backdrop-filter: blur(18px) saturate(140%)`, `background: rgba(10,10,14,.35)`, 1px `rgba(255,255,255,.14)` border, radius 999px, font `Inter, system-ui`, 14px). Placeholder text: `paste a youtube link`. Drop zone hint below the bar: `or drop an audio file`. Whole page accepts drag-drop.
- **Card:** centered, width `min(56vw, 900px)`, `aspect-ratio: 16/9`. Oval: `border-radius: 50% / 42%`. Feathered edge: card wrapper gets `mask-image: radial-gradient(ellipse at center, #000 58%, rgba(0,0,0,.6) 78%, transparent 100%)` and `-webkit-mask-image` same. A second, larger sibling ("halo") sits behind it with the same shape scaled 1.12, `backdrop-filter: blur(22px)`, `background: rgba(255,255,255,.04)`, masked `radial-gradient(ellipse, #000 55%, transparent 100%)` — this produces the blurred outer rim from the reference image. The iframe fills the wrapper (`position:absolute; inset:0; width:100%; height:100%`); pointer events on the iframe are disabled (our buttons control playback).
- **Controls:** a pill under the card with a single toggle button (▶ / ❚❚), 56px circle, glass style, 1px border, `transition: transform .15s`; hover scale 1.05. Keyboard: Space toggles when the URL input is not focused.
- **Toast:** bottom-center, 3.5 s, glass.
- **Banner:** top full-width thin strip for the browser-support message; dismissable.
- **HUD:** top-left monospace (`ui-monospace, SFMono-Regular, Menlo`, 11px, `opacity .8`), hidden by default, toggled by `H`. Shows key/value rows and an `upcoming` list (`+1.6s downbeat`, `+3.2s IMPACT 0.9`). Contains a range input `latency trim` −200…200 ms (step 5) calling `onTrim`.
- YouTube: load `https://www.youtube.com/iframe_api` once (resolve on `window.onYouTubeIframeAPIReady`). `new YT.Player(mount, { videoId, playerVars: { autoplay: 0, controls: 0, rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin, start }, events })`. Map `YT.PlayerState` ints → `PlayerState`. Error codes: 2 → 'invalid video id', 5 → 'html5 player error', 100 → 'video not found or private', 101/150 → 'the owner disabled embedding for this video — try another link'. Declare minimal `YT` global types in `src/source/youtube.d.ts` (do not add `@types/youtube`).
- `main.ts` wires: submit → `parseYouTubeUrl` (toast on null) → `player.load` → card label = title when available; play/pause → player; state changes → `controls.setPlaying`.

- [ ] **Step 1: Write failing tests** `tests/source/urlParse.test.ts` covering: `https://www.youtube.com/watch?v=dQw4w9WgXcQ` → id, start 0; `https://youtu.be/dQw4w9WgXcQ?t=90` → start 90; `https://www.youtube.com/shorts/dQw4w9WgXcQ` → id; `https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD` → id; `?t=1m30s` → 90; bare `dQw4w9WgXcQ` (11 chars `[A-Za-z0-9_-]{11}`) → id; `https://vimeo.com/1` → null; `''` → null.
- [ ] **Step 2: Run, verify fail.** **Step 3: Implement urlParse.** **Step 4: Run, verify pass.**
- [ ] **Step 5: Implement youtubePlayer, card, controls, toast, banner, hud, styles; wire main.ts.**
- [ ] **Step 6: Manual check** — `npm run dev`, paste a link, video plays inside the oval, feathered edge visible, play/pause works, error toast on an embedding-disabled video (e.g. many major-label uploads).
- [ ] **Step 7: Commit** `feat(ui): url bar, oval youtube card, controls, toast, hud skeleton`.

---

### Task 3: Audio graph, tab capture, file source, FFT, per-frame features

**Files:**
- Create: `src/source/audioGraph.ts`, `src/source/tabCapture.ts`, `src/source/fileSource.ts`, `src/source/latency.ts`, `src/analysis/fft.ts`, `src/analysis/features.ts`, `src/analysis/ring.ts`
- Test: `tests/analysis/fft.test.ts`, `tests/analysis/features.test.ts`, `tests/analysis/ring.test.ts`

**Interfaces produced:**
```ts
// ring.ts — fixed-capacity numeric ring buffer
export class Ring { constructor(capacity: number); push(v: number): void; get length(): number; at(i: number): number /* 0 = oldest */; last(): number; mean(): number; min(): number; max(): number; toArray(): Float32Array }
// fft.ts — radix-2 real FFT, pure
export function fftMagnitudes(frame: Float32Array /* length power of 2, Hann applied inside */): Float32Array; // length N/2, linear magnitude
export function hann(n: number): Float32Array;
// features.ts — pure; works from a magnitude spectrum + optional time-domain frame
export interface FeatureExtractorOptions { sampleRate: number; fftSize: number }
export class FeatureExtractor {
  constructor(o: FeatureExtractorOptions);
  /** mags: linear magnitudes length fftSize/2; time: optional time-domain frame for zcr/rms; t: audio clock */
  extract(mags: Float32Array, time: Float32Array | null, t: number): FrameFeatures;
}
export function bandIndexRanges(sampleRate: number, fftSize: number): Array<[number, number]>; // bin ranges for BAND_EDGES_HZ
export function chromaFromMagnitudes(mags: Float32Array, sampleRate: number, fftSize: number): Float32Array; // 12, normalized, bins >= 60 Hz, weight = mag^2
// audioGraph.ts — browser only
export interface AudioGraph { ctx: AudioContext; analyser: AnalyserNode; connectSource(node: AudioNode, toDestination: boolean): void; disconnectSource(): void; readFrame(): { mags: Float32Array; time: Float32Array; t: number } }
export function createAudioGraph(): AudioGraph; // fftSize 4096, smoothingTimeConstant 0, minDecibels -100, maxDecibels -10; mags computed from getFloatFrequencyData (dB → linear 10^(dB/20))
// tabCapture.ts
export function isTabCaptureSupported(): boolean; // 'getDisplayMedia' in navigator.mediaDevices && /Chrom/.test(UA)
export async function captureTabAudio(ctx: AudioContext): Promise<{ node: MediaStreamAudioSourceNode; stop(): void; onEnded(cb: () => void): void }>;
// fileSource.ts
export function createFileSource(ctx: AudioContext, file: File): Promise<{ node: MediaElementAudioSourceNode; el: HTMLAudioElement; buffer: AudioBuffer /* decoded copy for offline analysis */ }>;
// latency.ts
export function estimateCaptureLatency(ctx: AudioContext): number; // (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0) + 0.02
export function loadTrim(): number; export function saveTrim(ms: number): void; // localStorage key 'jevj.latencyTrimMs'
```

**Feature definitions (binding):**
- `rms` = sqrt(mean(time²)) if time given, else sqrt(Σ mags²)/(N/2) scaled so a full-scale sine ≈ 0.7. `db = 20·log10(max(rms, 1e-5))`.
- `bandsRaw[i]` = mean magnitude over the band's bins. `bands[i]` = adaptive normalization with per-band peak tracker: `peak = max(raw, peak·0.995, max(1e-4, 0.05·maxPeakAcrossBands))`; `norm = clamp((raw − 0.05·peak)/(0.95·peak), 0, 1)`; `shaped = norm^1.3`; asymmetric smoothing `level += (shaped − level)·(shaped > level ? 0.6 : 0.12)`.
- `centroid` = Σ f·m² / Σ m² over bins ≥ 20 Hz. `flatness` = geomean(m²+ε)/mean(m²+ε) over 60 Hz–8 kHz. `rolloff` = frequency at 95% cumulative m². `flux` = Σ max(0, m_t − m_{t−1}) over bins 60 Hz–8 kHz, divided by bin count. `zcr` = crossings/frame × sampleRate/frameLength. `sub` = Σ m² in band 0 / Σ m² all bands. `chroma`: for each bin with f ≥ 60 Hz, `midi = 69 + 12·log2(f/440)`, pc = round(midi) mod 12, accumulate m²; normalize to sum 1.
- Tab capture options: `{ video: true, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' }` (cast to any for non-standard keys). Immediately `getVideoTracks().forEach(t => t.stop())`. Reject with a clear Error when the stream has no audio track ("share the tab with 'Also share tab audio' ticked"). Source node is connected to the analyser only, never to destination.
- File source: `el.src = URL.createObjectURL(file)`, node → analyser and destination; also `decodeAudioData(await file.arrayBuffer())` for Task 8's offline pass.

- [ ] **Step 1: Failing tests.** `fft.test.ts`: a 1 kHz sine at 44.1 kHz, N=4096 → argmax bin ≈ round(1000·4096/44100)=93 (±1); Parseval-ish: white noise magnitudes all finite. `features.test.ts` (use `fftMagnitudes` to build mags): 100 Hz sine → `sub` low but band 1 (60–130) dominant, `centroid` within 80–140 Hz; white noise → `flatness > 0.6`; 440 Hz sine → chroma index 9 (A) ≥ 0.8; silence → chroma all zeros, `db ≤ -99`; two consecutive frames identical → `flux ≈ 0`; adaptive `bands`: after 60 frames of constant sine, band level ∈ [0.8, 1]. `ring.test.ts`: capacity 3 push 1..5 → toArray [3,4,5], mean 4.
- [ ] **Step 2–4: run fail → implement → run pass.**
- [ ] **Step 5: Browser modules** (`audioGraph`, `tabCapture`, `fileSource`, `latency`) — no unit tests; wire in `main.ts`: on Play with a loaded video and no source yet → `captureTabAudio` (toast on failure, banner if unsupported); on file drop → `createFileSource`, card `setMode('file')`, label = filename; per frame `graph.readFrame()` → `extractor.extract` → HUD rows `rms`, `centroid`, band bars (8 small text bars using `█` count 0–8).
- [ ] **Step 6: Manual check** — capture dialog appears once; HUD bands move with music; file drop works.
- [ ] **Step 7: Commit** `feat(audio): audio graph, tab capture, file source, FFT and frame features`.

---

### Task 4: Onsets, tempo, beat grid

**Files:**
- Create: `src/analysis/onset.ts`, `src/analysis/tempo.ts`, `src/analysis/grid.ts`
- Test: `tests/analysis/onset.test.ts`, `tests/analysis/tempo.test.ts`, `tests/analysis/grid.test.ts`, `tests/helpers/synth.ts`

**Interfaces produced:**
```ts
// onset.ts
export class OnsetDetector {
  constructor(o?: { historyFrames?: number /* 43 */, thresholdRatio?: number /* 1.5 */, minGapSec?: number /* 0.05 */ });
  /** returns onset strength (>0) when this frame is an onset, else 0. Uses f.flux and f.bandsRaw[0..2] (low-weighted) */
  push(f: FrameFeatures): number;
  /** onset envelope resampled at 100 Hz for the last `seconds` */
  envelope(seconds: number, now: number): Float32Array;
  lowOnsetStrength(): number; // strength of the last onset in bands 0-1 (for downbeat weighting)
}
// tempo.ts
export interface TempoEstimate { bpm: number; period: number; confidence: number; marking: TempoMarking }
export function estimateTempo(envelope100Hz: Float32Array): TempoEstimate; // autocorrelation, lags for 60..200 BPM, log-normal prior centered 120 BPM (σ=0.5 in ln space), octave rule below
export function tempoMarking(bpm: number): TempoMarking; // <66 largo, <76 adagio, <108 andante, <120 moderato, <156 allegro, <176 vivace, else presto
// grid.ts
export interface GridState { bpm: number; period: number; nextBeat: number; beatIndex: number /* running count */; barLength: 3|4; downbeatOffset: number /* beatIndex mod barLength that is the downbeat */; barsSinceChange: number; barInPhrase: number; confidence: number }
export class BeatGrid {
  constructor();
  setTempo(e: TempoEstimate, now: number): void;
  /** call with every onset (t, strength, lowStrength) to phase-lock; nudges nextBeat toward onsets within ±15% of period */
  onOnset(t: number, strength: number, low: number): void;
  /** advance; returns beats that elapsed since last call */
  tick(now: number): Array<{ t: number; downbeat: boolean; index: number }>;
  predict(count: number, now: number): Array<{ t: number; downbeat: boolean }>;
  markSectionChange(now: number): void; // resets barsSinceChange
  state(): GridState;
  phase(now: number): number; // 0..1 position within the current beat
}
```

**Algorithms (binding):**
- Onset: `flux' = flux + 0.5·(Δ bandsRaw[0] + Δ bandsRaw[1])₊`; onset when `flux' > thresholdRatio·median(last 43) + 0.01` AND `flux'` ≥ previous two values (local max) AND `t − lastOnset ≥ minGapSec`. Envelope: keep `(t, flux')` pairs for 8 s; `envelope(seconds, now)` linearly resamples to 100 Hz.
- Tempo: mean-remove envelope; autocorrelation `r[L]` for lags 30..100 samples (200→60 BPM); score `s[L] = r[L] · prior(60·100/L)`; prior = exp(−(ln(bpm/120))²/(2·0.5²)). Pick argmax `L*`. Octave rule: if `s[L*/2]` exists and `≥ 0.8·s[L*]` and bpm(L*/2) ≤ 150 → use L*/2; if `s[2L*] ≥ 0.9·s[L*]` and bpm(2L*) ≥ 90 → use 2L*. `confidence = clamp(s[L*] / (Σ s / count) / 8, 0, 1)` (peak-to-mean ratio scaled). `period = L/100`.
- Grid: on `setTempo`, keep phase (`nextBeat` unchanged) unless bpm differs > 8% then re-anchor `nextBeat` to the last strong onset + period. `onOnset`: if `|t − nearestBeat| < 0.15·period` → `nextBeat += 0.3·(t − nearestBeat)` (PLL-style). Downbeat: accumulate `lowStrength` per `beatIndex mod barLength` with decay 0.9 per bar; `downbeatOffset` = argmax. `barLength` from meter (Task 5 passes it via `setMeter(m)`; default 4). `barInPhrase = barsSinceChange mod 16`.

- [ ] **Step 1: `tests/helpers/synth.ts`** — helpers: `clickTrack(bpm, seconds, sr=44100)` (5 ms decaying noise bursts on each beat, louder every 4th), `framesFrom(signal, sr, fftSize=4096, hop=735 /* 60 fps */)` → `FrameFeatures[]` via `fftMagnitudes` + `FeatureExtractor`.
- [ ] **Step 2: Failing tests.** onset: 120 BPM click track for 8 s → onsets within ±20 ms of ≥ 14 of the 16 beats, no more than 2 extra. tempo: envelope from that track → bpm ∈ [118,122], marking 'allegro', confidence > 0.5; 90 BPM → [88,92] 'andante'; 170 BPM → [166,174] 'vivace' (octave rule must not halve it, since 85 is < 90? — no: rule halves only if ≤150 and strong; assert it stays ≥ 160); flat envelope → confidence < 0.2. `tempoMarking(66)`='adagio', `(140)`='allegro'. grid: after setTempo(120) at t=0 with nextBeat 0.5 and onsets exactly on 0.5+0.5k, `predict(4, 2.0)` ≈ [2.5,3.0,3.5,4.0] ±5 ms; onsets 20 ms early consistently → predicted beats drift earlier (PLL); louder low onsets every 4th → `downbeatOffset` correct.
- [ ] **Step 3–5: run fail → implement → run pass.**
- [ ] **Step 6: Wire into main loop** (extractor → onset → every 1 s `estimateTempo(envelope(6, now))` → `grid.setTempo`; onsets → `grid.onOnset`; HUD shows bpm/conf/phase).
- [ ] **Step 7: Commit** `feat(analysis): onset detection, tempo estimation, beat grid`.

---

### Task 5: Key/mode, rhythm, dynamics, timbre, speech

**Files:**
- Create: `src/analysis/key.ts`, `src/analysis/rhythm.ts`, `src/analysis/dynamics.ts`, `src/analysis/timbre.ts`, `src/analysis/speech.ts`
- Test: one test file per module under `tests/analysis/`

**Interfaces produced:**
```ts
// key.ts
export const KK_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
export const KK_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
export const PC_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export interface KeyEstimate { key: string /* PC name or '?' */; mode: Mode; modeConf: number; modal: ModalFlavor; tonic: number }
export class KeyTracker { constructor(decayPerSecond?: number /* 0.88 */); push(chroma: Float32Array, dt: number): void; estimate(): KeyEstimate }
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number;
export function modalFlavor(chroma: Float32Array, tonic: number): ModalFlavor; // best-matching 7-note template by dot product of normalized chroma rotated to tonic; 'unclear' if best-second < 0.05
// rhythm.ts
export class RhythmTracker { pushOnset(t: number, strength: number, phase: number /* grid.phase */): void; syncopation(): number; regularity(): number; meter(): Meter; onsetsPerSec(now: number): number; onsetRatio(now: number, barSec: number): number /* density last 2 bars / density 8 bars ago (bars 8..10 back), clamp 0..20 */ }
// dynamics.ts
export class DynamicsTracker {
  push(db: number, t: number): void;
  loudClass(): DynClass;      // position of 3 s loudness within session running [min,max] (min/max decay toward current slowly): <0.1 pp, <0.3 p, <0.45 mp, <0.6 mf, <0.8 f, else ff
  range(): number;            // (p95 − p10 of 20 s loudness history in dB) / 30, clamp 0..1
  trend(): Trend;             // mean(last 1.5 s) − mean(1.5–4.5 s ago): > +3 dB building, < −3 dB fading, else steady
  crest(): number;            // (peak − rms of last 2 s in dB)/20 clamp 0..1
  slopeDb(barsBack: number, barSec: number, now: number): number; // loudness now (0.5 s mean) − loudness barsBack bars ago (0.5 s mean), dB, rounded to 1 decimal
  gap(now: number, beatSec: number): boolean; // any 0.15 s window within the last beat whose mean dB is ≥ 12 dB below the 4 s mean
}
// timbre.ts
export const IC_DISSONANCE = [0, 1.0, 0.6, 0.2, 0.15, 0.05, 0.9]; // index = interval class 0..6
export function consonance(chroma: Float32Array): number; // 1 − Σ_{i<j} c_i c_j w(ic(i,j)) / Σ_{i<j} c_i c_j ; 1 when chroma is a single pitch class or all zero
export class TimbreTracker { push(f: FrameFeatures, onsetStrength: number, dt: number): void; brightness(): number /* clamp(log2(centroid/200)/5, 0, 1) smoothed */; noisiness(): number /* smoothed flatness */; attack(): Attack /* mean onset rise (flux jump / mean flux) > 2.5 sharp, < 1.4 soft, else mixed */; subWeight(): number; centroidSlope(): number /* (centroid mean last 2 s − mean 2–6 s ago)/2000 clamp −1..1 */ }
// speech.ts
export class SpeechDetector { push(rms: number, t: number, f: FrameFeatures): void; score(beatConfidence: number): number }
```
Speech score = `clamp(0.4·modRatio + 0.25·(1 − beatConfidence) + 0.2·centroidMid + 0.15·zcrVar, 0, 1)` where `modRatio` = energy of the 3–6 Hz band of the RMS-envelope modulation spectrum (envelope resampled to 50 Hz over 4 s, mean-removed, 200-point DFT) divided by energy in 0.5–15 Hz (clamp 0..1 after ×2); `centroidMid` = 1 when centroid ∈ [1000, 3000] Hz falling to 0 at 400 / 6000 Hz; `zcrVar` = normalized std of zcr over 2 s (÷ mean, clamp 0..1).

- [ ] **Step 1: Failing tests** (use `synth.ts`; add `chord(freqsHz, seconds)` sawtooth helper and `amNoise(rateHz, seconds)`).
  key: C major triad + scale tones weighted → key 'C', mode 'major', modeConf > 0.3; A natural minor scale → 'A' minor; D dorian scale (D E F G A B C) → tonic D, modal 'dorian' (given tonic weight boost: repeat D twice); silence → '?' 'unclear'. `pearson([1,2,3],[2,4,6]) ≈ 1`.
  rhythm: onsets exactly on integer beats → syncopation < 0.15, regularity > 0.9; onsets at .5 offsets half the time → syncopation > 0.4; onsets with jittered intervals (±30%) → regularity < 0.6; meter: strong onsets every 3 beats → 'triple', every 4 → 'duple'.
  dynamics: ramp −40 → −10 dB over 6 s → trend 'building' at the end; constant → 'steady'; alternating −60/−10 → range > 0.8; 12 dB dip for 0.2 s in last beat → gap true.
  timbre: `consonance(chroma with only C)` = 1; C+G → > 0.9; C+C# → < 0.2; C major triad ∈ [0.75, 0.95].
  speech: 4 Hz AM noise with centroid ~2 kHz, beatConf 0.1 → score > 0.55; 120 BPM click track, beatConf 0.9 → score < 0.3.
- [ ] **Step 2–4: run fail → implement → run pass.**
- [ ] **Step 5: Wire trackers in main loop; HUD shows key/mode/modal, loud/trend, speech, consonance.** Pass `rhythm.meter()` to `grid.setMeter` (add `setMeter(m: Meter)` to BeatGrid: 'triple' → barLength 3, else 4).
- [ ] **Step 6: Commit** `feat(analysis): key/mode, rhythm, dynamics, timbre, speech trackers`.

---

### Task 6: Summarizer (MoodInput + novelty) and drop detector

**Files:**
- Create: `src/analysis/summarizer.ts`, `src/analysis/drop.ts`
- Test: `tests/analysis/summarizer.test.ts`, `tests/analysis/drop.test.ts`

**Interfaces produced:**
```ts
// summarizer.ts
export interface SummarizerDeps { grid: BeatGrid; key: KeyTracker; rhythm: RhythmTracker; dyn: DynamicsTracker; timbre: TimbreTracker; speech: SpeechDetector; tempo: () => TempoEstimate }
export class Summarizer {
  constructor(d: SummarizerDeps);
  snapshot(now: number, positionSec: number, durationSec: number | null): MoodInput; // durationSec null → 'live'
  /** 0..1 distance between two MoodInputs over a fixed numeric feature vector (bpm/200, beatConf, sync, regular, modeConf, consonance, range, bright, noise, sub, speech, bands/9, slope8/30, onsetRatio/4, centroidSlope, loud index/5, trend ±) — mean absolute difference × 2, clamp */
  static novelty(a: MoodInput, b: MoodInput): number;
  /** true when a section boundary is likely: trend flips sign vs 4 s ago, or |slope4| ≥ 6 dB, or onsetRatio ≥ 1.8 or ≤ 0.55, or key tonic changed with modeConf > 0.4 */
  sectionChanged(prev: MoodInput | null, cur: MoodInput): boolean;
  static serialize(m: MoodInput): string; // compact JSON, rounding: 2 sig digits for 0..1 fields, ints for bpm/bars, 1 decimal for slopes
}
// drop.ts
export interface DropEvent { t: number; strength: number /* 0..1 */; kind: 'impact'|'gap' }
export class DropDetector {
  constructor(o?: { jumpDb?: number /* 8 */, dipWindowSec?: number /* 1.0 */, shortSec?: number /* 0.2 */ });
  push(f: FrameFeatures, onset: number): DropEvent | null; // impact when short loudness ≥ min(loudness over preceding dipWindow) + jumpDb AND (bands[0]+bands[1])/2 ≥ 0.5 AND onset > 0; at most one impact per 1.5 s. Emits 'gap' when short loudness ≤ 4 s mean − 12 dB (once per 2 s).
}
```
Serialization example (must be ≤ 160 tokens by `estimateTokens`):
```json
{"pos":"1:32/4:05","bpm":128,"tempo":"allegro","beatConf":0.9,"meter":"duple","sync":0.3,"regular":0.9,"key":"F#","mode":"minor","modeConf":0.7,"modal":"aeolian","consonance":0.6,"loud":"f","range":0.2,"trend":"building","crest":0.3,"bright":0.7,"noise":0.4,"attack":"sharp","sub":0.8,"bands":[9,8,6,5,5,6,7,5],"speech":0.05,"onsetsPerSec":4.2,"slope4":3.5,"slope8":6.1,"onsetRatio":2.1,"centroidSlope":0.4,"gap":false,"barsSinceChange":14,"barInPhrase":14}
```

- [ ] **Step 1: Failing tests.** summarizer: with stub trackers returning fixed values, `snapshot` validates via `validateMoodInput`, `serialize` ≤ 160 tokens, `pos` = '1:32/4:05' for 92/245 s and '1:32/live' for null; `novelty(a,a)=0`, `novelty(a, a with bpm 60→180 and bands inverted) > 0.3`; `sectionChanged` true on trend flip building→fading and on onsetRatio 2.2, false on identical. drop: frames at −30 dB for 1 s then −12 dB with bands[0..1]=0.9 and onset 1 → impact within the first two loud frames, strength > 0.5; then another loud frame 0.3 s later → null (cooldown); −8 dB steady then a 0.2 s −40 dB dip → 'gap'.
- [ ] **Step 2–4: run fail → implement → run pass.**
- [ ] **Step 5: Wire: main loop keeps `lastSent: MoodInput|null`; HUD shows `novelty` and the serialized length.**
- [ ] **Step 6: Commit** `feat(analysis): mood input summarizer, novelty, drop detector`.

---

### Task 7: Jev layer — questions, server handler, Vercel function, dev middleware, client cadence, mood state

**Files:**
- Create: `src/mood/questions.ts`, `src/mood/decode.ts`, `server/moodHandler.ts`, `api/mood.ts`, `src/mood/moodClient.ts`, `src/mood/moodState.ts`, `scripts/jev-smoke.ts`
- Modify: `server/devApiPlugin.ts` (mount real handler), `.env` locally (copy key from `/Users/rivianpratama/Documents/GitHub/JevPixelArt/.env` line 2 — the bare token; never print it)
- Test: `tests/mood/questions.test.ts`, `tests/mood/decode.test.ts`, `tests/mood/moodClient.test.ts`, `tests/mood/moodState.test.ts`, `tests/server/moodHandler.test.ts` (with injected fake client)

**Interfaces produced:**
```ts
// questions.ts  (imports score/noul/choice from '@typesafe-ai/sdk' — type-only usage in client bundle is fine, but keep this file free of runtime SDK calls: define plain objects matching the SDK's question shapes {type:'score'|'noul'|'choice', instructions, criteria})
export const MOOD_PREAMBLE: Record<string, string>; // ~40 tokens: field meanings, see below
export const MOOD_QUESTIONS: Record<string, Question>; // keys exactly: valence, arousal, tension, warmth, synthetic, space, aggression, melancholy, hypnotic, euphoric_peak, spoken, genre, section, motion, drop_imminent, beats_to_change, impact, pre_drop_style
export function buildState(input: MoodInput): { music: MoodInput; legend: Record<string, string> };
// decode.ts
export function decodeAnswers(answers: Record<string, any>): MoodVector; // score/(levels−1); noul prob; choice + probabilities; confidence = mean of score/choice confidences
// server/moodHandler.ts
export interface JevLike { systemOne(req: { state: unknown; questions: Record<string, unknown>; model?: string }): Promise<{ answers: Record<string, any>; usage: { input_tokens: number; output_tokens: number } }> }
export async function handleMood(body: unknown, deps: { client: JevLike; now?: () => number }): Promise<{ status: number; json: MoodResponse | { error: string } }>;
export function createJevClient(apiKey: string): JevLike; // new TypeSafeClient({ apiKey, timeout: 8000 })
// api/mood.ts (Vercel): default export (req, res) → 405 unless POST; 413 if body > 2048 bytes; 500 if no TYPESAFE_API_KEY; else handleMood
// moodClient.ts
export interface MoodClientOptions { fetchFn?: typeof fetch; minIntervalSec?: number /* 2.5 */; maxIntervalSec?: number /* 8 */; firstDelaySec?: number /* 1.5 */; noveltyFloor?: number /* 0.05 */ }
export class MoodClient {
  constructor(o?: MoodClientOptions);
  /** decide + fire. Called every frame. Returns a promise only when a request was started. */
  maybeRequest(now: number, input: MoodInput, novelty: number, sectionChanged: boolean, playing: boolean, visible: boolean, nextPhraseBoundaryIn: number | null): Promise<MoodResponse | null> | null;
  nextAllowedAt(): number; stats(): { calls: number; tokens: number; lastLatencyMs: number; errors: number; backoffUntil: number };
}
// moodState.ts
export class MoodState { constructor(initial?: MoodVector); setTarget(m: MoodVector, now: number): void; tick(now: number): MoodVector /* slew: scores τ=1.5 s, nouls τ=1.0 s, euphoricPeak/impact/dropImminent τ=0.4 s; choice probabilities slewed τ=1.5 s and argmax recomputed */; current(): MoodVector }
```

**Question text (binding — this is the creative brief for Jev; copy verbatim, structured criteria as objects with `what`/`signals` where shown):**

Preamble legend (sent as `state.legend`): `{"bpm":"beats per minute","tempo":"Italian tempo marking","beatConf":"0-1 how clearly a steady beat exists","sync":"0-1 syncopation","regular":"0-1 rhythmic regularity","modeConf":"0-1 certainty of major/minor","consonance":"0 dissonant..1 consonant","loud":"pp..ff relative to this track","range":"0 compressed..1 wide dynamics","crest":"0 smooth..1 spiky","bright":"0 dark..1 bright","noise":"0 tonal..1 noisy","sub":"0-1 sub-bass weight","bands":"8 log bands 20Hz-16kHz, 0-9","speech":"0-1 speech-likeness","slope4/slope8":"loudness change in dB over last 4/8 bars","onsetRatio":"note density now vs 8 bars ago","centroidSlope":"-1 darkening..1 brightening","gap":"silence in the last beat","barInPhrase":"bar index within a 16-bar phrase"}`

- `valence` (score): instructions `"What emotional valence does this music express right now? Judge from mode, consonance, tempo, brightness and dynamics."` criteria: `["grieving, desolate, hopeless", "bittersweet, melancholic, wistful", "neutral, matter-of-fact, ambiguous", "uplifting, warm, hopeful", "euphoric, triumphant, ecstatic"]`
- `arousal` (score): `"How much physical energy does the music carry right now?"` `["still, suspended, near-silent", "calm, gentle, unhurried", "moving, steady, engaged", "driving, intense, propulsive", "frantic, overwhelming, explosive"]`
- `tension` (score): `"How much unresolved tension is there right now (dissonance, build-up, withheld resolution)?"` `["fully resolved and restful", "relaxed with mild pull", "moderate tension, expecting movement", "high tension, strongly anticipating release", "unbearable suspense right before a release"]`
- `warmth` (score): `"What color temperature does the sound evoke?"` `["icy, glassy, cold", "cool, airy, clean", "neutral", "warm, rounded, glowing", "hot, saturated, burning"]`
- `synthetic` (score): `"How electronic versus acoustic does the sound source seem?"` `["fully acoustic and organic (voices, strings, wood, breath)", "mostly acoustic with some processing", "mixed acoustic and electronic", "mostly electronic with some organic elements", "fully synthetic and machine-made"]`
- `space` (score): `"How large is the implied space?"` `["intimate, dry, close to the ear", "small room", "medium hall", "large hall, long reverb", "vast, cosmic, boundless"]`
- `aggression` (noul): `"Is the music hostile, abrasive or violent in character right now?"` criteria `{true: "distorted, harsh, pounding, screaming, menacing", false: "gentle, smooth, friendly or neutral"}`
- `melancholy` (noul): `"Does the music carry sadness or longing right now?"` `{true: "minor, slow, descending, mournful, nostalgic", false: "no sadness present"}`
- `hypnotic` (noul): `"Is the music trance-like: repetitive, cyclical, entrancing?"` `{true: "steady loops, minimal change, repeating patterns that pull the listener in", false: "varied, narrative or through-composed"}`
- `euphoric_peak` (noul): `"Is this moment a peak or drop: the highest-energy payoff of a section?"` `{true: "full-band impact, maximal loudness after a build, celebratory release", false: "not a peak moment"}`
- `spoken` (noul): `"Is this primarily spoken word (podcast, speech, narration) rather than music?"` `{true: "speech-like rhythm, no steady beat, mid-frequency voice, pauses", false: "music, singing over instruments, or instrumental"}`
- `genre` (choice): `"Which family best describes what is playing?"` criteria: `classical: {what: "orchestral, chamber, piano, wide dynamics, rubato"}, jazz: {what: "swing, complex harmony, improvisation, brass/piano/upright bass"}, electronic_dance: {what: "four-on-the-floor or breakbeat, synthetic, 120-180 bpm, builds and drops"}, hiphop_trap: {what: "70-100 bpm half-time feel, heavy sub 808s, sparse hats, rap vocals"}, rock_metal: {what: "distorted guitars, live drums, dense midrange, aggressive"}, ambient_drone: {what: "beatless or nearly beatless, sustained textures, slow evolution"}, pop: {what: "compressed, vocal-led, verse-chorus, moderate tempo"}, folk_acoustic: {what: "acoustic guitar, voice, small ensemble, intimate"}, spoken: {what: "speech, podcast, narration"}`
- `section` (choice): `"Which part of the musical form is playing right now?"` `intro: {what: "sparse opening, establishing"}, verse_steady: {what: "steady groove, main material, moderate energy"}, build: {what: "energy rising, density increasing, tension accumulating toward a release"}, drop_climax: {what: "full-energy payoff, loudest densest section"}, breakdown: {what: "energy pulled back after a peak, stripped down"}, outro: {what: "winding down, fading"}`
- `motion` (choice): `"How should abstract visuals move to match this music?"` `flow: {what: "continuous laminar streams, smooth"}, pulse: {what: "beat-locked expansion and contraction"}, shatter: {what: "sharp fragments, jump cuts, glitch"}, drift: {what: "slow floating, weightless"}, swarm: {what: "many small agents moving with collective purpose"}, bloom: {what: "radial growth outward from the center, unfolding"}`
- `drop_imminent` (noul): `"Given the build cues (slope4, slope8, onsetRatio, centroidSlope, gap, barInPhrase), will a drop or climax land within the next 2 bars?"` `{true: "rising loudness, note density doubling, brightening riser, near the end of a 16-bar phrase, or a sudden gap", false: "no build underway or the release already happened"}`
- `beats_to_change` (choice): `"How many beats until the next section change?"` criteria `1,2,4,8,16,none` each with `{what: "about N beats"}` and `none: {what: "no change expected in the next 16 beats"}`
- `impact` (score): `"How hard will the next section change hit?"` `["imperceptible, seamless", "gentle shift", "clear change", "strong hit", "massive slam after a gap"]`
- `pre_drop_style` (choice): `"What kind of build is underway?"` `silence_slam: {what: "a gap or filter-cut right before the hit"}, riser: {what: "brightening upward sweep"}, snare_roll: {what: "note density doubling and quadrupling"}, swell: {what: "gradual loudness increase without a roll"}, none: {what: "no build underway"}`

**Cadence (binding):** `interval = clamp(max − (max − min)·novelty·2, min, max)`; request when `now ≥ nextAllowedAt` and `playing && visible` and (`novelty ≥ noveltyFloor` or `sectionChanged` or `now − lastRequestAt ≥ max`); `sectionChanged` allows firing at `min` even if novelty is low; if `nextPhraseBoundaryIn` ∈ (0.8, 1.4) s and `now − lastRequestAt ≥ min` → fire. One in-flight request; on HTTP 429/529/5xx → backoff 4 s doubling to 32 s; on 4xx other → log once and stop retrying for 60 s.

- [ ] **Step 1: Failing tests.** questions: exactly 18 keys; each score has 5 levels except none other; each choice's criteria keys equal the corresponding const arrays (GENRES, SECTIONS, MOTIONS, BEATS_TO_CHANGE, PRE_DROP_STYLES); `JSON.stringify(buildState(fixture))` ≤ 320 tokens. decode: fixture answers → valence `score/4`, nouls pass-through, choice argmax + probabilities, `validateMoodVector` ok. moodHandler: invalid body → 400; valid → 200 with mood from fake client and `latencyMs ≥ 0`; fake client throwing → 502. moodClient (fake fetch + fake clock): no call before 1.5 s; call at 1.5 s; with novelty 0 no second call until 8 s; with novelty 1 second call at +2.5 s; sectionChanged true → call at +2.5 s; paused → never; 429 → backoff 4 s then 8 s. moodState: after setTarget(valence 1) from 0, tick at +1.5 s → ≈ 0.63, +4.5 s → > 0.9; choice argmax flips only when slewed probability overtakes.
- [ ] **Step 2–4: run fail → implement → run pass.**
- [ ] **Step 5: `scripts/jev-smoke.ts`** (run with `npx tsx scripts/jev-smoke.ts` after adding `tsx` devDependency) — loads `.env`, sends the serialization example from Task 6 through `handleMood` with the real client, prints decoded MoodVector, usage tokens and latency. Run it once and paste output into the report (redact nothing; there is no key in the output).
- [ ] **Step 6: Wire** in `main.ts`: per frame `client.maybeRequest(...)`; on response `moodState.setTarget`; HUD shows mood rows, calls, tokens, latency. Dev middleware mounts `handleMood` with `createJevClient(env.TYPESAFE_API_KEY)`.
- [ ] **Step 7: Manual check** — play a track; HUD mood changes within ~2 s of start; tokens/call ≈ 1.5–2.5 k.
- [ ] **Step 8: Commit** `feat(mood): jev questions, serverless handler, cadence client, mood state`.

---

### Task 8: Cue timeline — store, grid writer, Jev writer, detector writer, offline analyzer

**Files:**
- Create: `src/timeline/timeline.ts`, `src/timeline/gridWriter.ts`, `src/timeline/jevWriter.ts`, `src/timeline/detectorWriter.ts`, `src/timeline/offlineAnalyzer.ts`
- Test: `tests/timeline/*.test.ts`

**Interfaces produced:**
```ts
// timeline.ts
export class CueTimeline {
  readonly step = 0.2;
  add(c: Cue): void;                       // keeps cues sorted; merges cues within 5 ms from the same source
  prune(before: number): void;             // drop cues older than `before`
  at(t: number): { mood: Partial<MoodVector>; impact: number; build: number; section?: Section } // mood: linear interpolation between the nearest 'jev'/'offline' cues; impact: max over cues within [t−0.05, t] decayed exp(−(t−cue.t)/0.25); build: latest build value ≤ t
  upcoming(now: number, horizon: number): Cue[];
  replaceSource(source: CueSource, from: number, cues: Cue[]): void; // remove that source's cues with t ≥ from, then add
  reanchor(predictedT: number, actualT: number): void;  // shift all 'jev' and 'grid' cues with t ≥ predictedT−0.05 by (actualT − predictedT)
}
// gridWriter.ts
export function writeGridCues(tl: CueTimeline, grid: BeatGrid, now: number, horizon: number /* 8 */): void; // replaceSource('grid', now, predicted beats as {beat:true, downbeat})
// jevWriter.ts
export function writeJevCues(tl: CueTimeline, mood: MoodVector, grid: BeatGrid, now: number): void;
//   always: add {t: now, source:'jev', mood}
//   if dropImminent ≥ 0.6 and beatsToChange ≠ 'none': target = grid-predicted downbeat nearest to now + beats·period, snapped to the next phrase boundary downbeat if within 2 bars; write build ramp cues every 0.2 s from now to target (build = (t−now)/(target−now)) and an impact cue {t: target, impact, section: 'drop_climax'}
//   if section is 'breakdown' with sectionP ≥ 0.6: add {t: now, section:'breakdown'}
// detectorWriter.ts
export function applyDetectorEvent(tl: CueTimeline, ev: DropEvent, now: number): void; // impact: if a 'jev' impact cue exists within ±1 beat → reanchor(cue.t, ev.t) and set its impact = max(cue.impact, ev.strength); else add {t: ev.t, source:'detector', impact: ev.strength}. gap: add {t: ev.t, source:'detector', build: 1}
// offlineAnalyzer.ts (pure; takes decoded channel data, not an AudioBuffer)
export interface OfflineResult { features: FrameFeatures[]; timeline: Cue[]; segments: Array<{ start: number; end: number; input: MoodInput }> }
export async function analyzeOffline(mono: Float32Array, sampleRate: number, askJev: (input: MoodInput) => Promise<MoodVector>, onProgress?: (p: number) => void): Promise<OfflineResult>;
//   hop 0.0167 s (60 fps), fftSize 4096; run the full Task 3–6 chain; segment boundaries where Summarizer.sectionChanged or novelty ≥ 0.35 with min segment 8 s; one askJev per segment (sequential, ≤ 40 segments — merge shortest neighbors if more); cues: 'offline' mood at each segment start, grid beats/downbeats for the whole track, detector impacts at exact times
```

- [ ] **Step 1: Failing tests.** timeline: add jev cues at t=0 (valence 0) and t=4 (valence 1) → `at(2).mood.valence ≈ 0.5`; impact cue at 3.0 → `at(3.0).impact = 1`, `at(3.25).impact ≈ 0.37`, `at(2.9).impact = 0`; `reanchor(3.0, 3.04)` moves the cue to 3.04; `replaceSource('grid', 5, [...])` keeps grid cues before 5. gridWriter: 120 BPM grid → 16 beat cues over 8 s with downbeats every 4. jevWriter: mood with dropImminent 0.9, beatsToChange '8', impact 0.8 at now=10 with 120 BPM → impact cue at ≈ 14.0 snapped to a downbeat, build cues rising 0→1. detectorWriter: predicted impact at 14.0, detector event at 14.03 → cue moves to 14.03; unpredicted event → new detector cue. offlineAnalyzer: 30 s synthetic track (10 s quiet 90 BPM clicks, then 20 s loud 128 BPM clicks with a 0.3 s gap before the switch) with a fake askJev → ≥ 2 segments, an impact cue within ±30 ms of 10.0 s, grid cues covering the track, askJev called once per segment.
- [ ] **Step 2–4: run fail → implement → run pass.**
- [ ] **Step 5: Wire** in `main.ts`: per frame `writeGridCues`; on mood response `writeJevCues`; on drop event `applyDetectorEvent`; `tl.prune(now − 2)`; HUD `upcoming` from `tl.upcoming(now, 8)`. File mode: after `createFileSource`, run `analyzeOffline` on channel 0 (downmix if stereo) with progress toast, then `replaceSource('offline', 0, cues)` and play. Cue time for file mode is `el.currentTime` mapped to the audio clock (`ctx.currentTime − el.currentTime` offset captured at play).
- [ ] **Step 6: Commit** `feat(timeline): cue timeline with grid, jev, detector writers and offline analyzer`.

---

### Task 9: Visual core — renderer, palette, post chain, InkFeedback scene, Director v1, idle mode

**Files:**
- Create: `src/visuals/renderer.ts`, `src/visuals/oklch.ts`, `src/visuals/palette.ts`, `src/visuals/director.ts`, `src/visuals/scenes/Scene.ts`, `src/visuals/scenes/InkFeedback.ts`, `src/visuals/post/Composer.ts`, `src/visuals/post/BlendPass.ts`, `src/visuals/post/ChromaPass.ts`, `src/visuals/post/MirrorPass.ts`, `src/visuals/post/GrainVignettePass.ts`, `src/visuals/shaders/common.glsl`, `src/visuals/shaders/ink_feedback.frag.glsl`, `src/visuals/shaders/ink_inject.frag.glsl`, `src/visuals/shaders/ink_color.frag.glsl`, `src/visuals/shaders/blend.frag.glsl`, `src/visuals/shaders/chroma.frag.glsl`, `src/visuals/shaders/mirror.frag.glsl`, `src/visuals/shaders/grain.frag.glsl`, `src/visuals/shaders/fullscreen.vert.glsl`
- Test: `tests/visuals/oklch.test.ts`, `tests/visuals/palette.test.ts`, `tests/visuals/director.test.ts`

**Interfaces produced:**
```ts
// oklch.ts
export function oklchToRgb(L: number, C: number, hDeg: number): [number, number, number]; // sRGB 0..1, gamut-clipped by reducing C until inside
// palette.ts
export interface Palette { stops: [number, number, number][]; /* 5 RGB stops dark→light */ bg: [number, number, number]; accent: [number, number, number] }
export function paletteFor(m: MoodVector): Palette;
// director.ts
export interface FastFrame { rms: number; bands: Float32Array; sub: number; onset: number; beatPhase: number; downbeatPulse: number /* 1 on downbeat decaying τ=0.3 */; impact: number; build: number }
export interface RenderParams {
  weights: { ink: number; particles: number; strands: number; relief: number; breath: number }; // sum 1
  palette: Palette;
  flowAmt: number; decay: number; turbulence: number; injectGain: number; pushKick: number; // ink
  particleSpeed: number; attractor: 'sphere'|'plane'|'vortex'|'explode'|'swarm'; pointSize: number; // particles (Task 10)
  strandBend: number; strandThickness: number; // strands (Task 10)
  reliefHeight: number; reliefContrast: number; // relief (Task 11)
  bloomStrength: number; bloomThreshold: number; chroma: number; posterize: number; mirrorFolds: number /* 0 = off */; grain: number; vignette: number; exposure: number;
  flowStyle: Motion;
}
export function direct(mood: MoodVector, fast: FastFrame, dt: number, prev: RenderParams | null, reducedMotion: boolean): RenderParams;
export const IDLE_MOOD: MoodVector; // valence .55 arousal .25 tension .3 warmth .45 synthetic .5 space .7 nouls .1 genre ambient_drone section intro motion drift
// Scene.ts
export interface Scene { readonly name: keyof RenderParams['weights']; init(r: THREE.WebGLRenderer, w: number, h: number): void; resize(w: number, h: number): void; update(dt: number, p: RenderParams, fast: FastFrame, time: number): void; render(r: THREE.WebGLRenderer): THREE.Texture; dispose(): void }
// renderer.ts
export function createVisuals(canvas: HTMLCanvasElement): { frame(dt: number, p: RenderParams, fast: FastFrame, time: number): void; resize(): void; addScene(s: Scene): void; dispose(): void }
// Composer.ts: takes scene textures + weights → BlendPass → MirrorPass → ChromaPass → UnrealBloomPass → GrainVignettePass → screen. Half-resolution scene targets (devicePixelRatio capped at 1.5).
```

**Creative direction (binding — this is the look):**
- **Palette** (`paletteFor`): hue `h = lerp(265, 35, warmth)` (violet/ice → amber/crimson), with genre nudges: jazz +25 (toward indigo/brass split), classical → C reduced ×0.6 and L stops shifted up (ivory/graphite), electronic_dance → C ×1.3 (neon), rock_metal → h toward 15 and stops darker, ambient_drone → C ×0.7. Chroma `C = lerp(0.03, 0.2, valence)·(1 − 0.5·melancholy)`. Five stops L = `[0.08, 0.25, 0.45, 0.68, 0.9]`, contrast stretched by arousal (`L_i = 0.5 + (L_i − 0.5)·lerp(0.7, 1.15, arousal)`), hues rotate across stops by `±40°·tension` (split-complement at high tension). `bg` = stop 0 darkened 0.6; `accent` = hue+180 at L 0.8, C 0.18. Test: warmth 0 → stop[2] blue-dominant (b > r); warmth 1 → r > b; melancholy 1 → lower saturation (max−min channel) than melancholy 0.
- **InkFeedback** (the base layer; the marbled liquid of reference 1): two half-res RGBA16F ping-pong targets holding three ink densities (R,G,B channels = ink A/B/C). Per frame:
  1. `ink_feedback.frag`: `uv' = uv + flow(uv)·uFlowAmt·dt + radial(uv)·uPushKick − curlOf(domainWarpedFbm)·uTurbulence`; `prev = texture(uPrev, uv')`; `prev *= uDecay`; small blur (4-tap) proportional to `uTurbulence`. Flow field = curl of `fbm(uv·2 + time·0.05)` domain-warped once (`q = fbm(p); p += 0.6·q`). `radial(uv)` = normalized (uv − center) × smoothstep on distance. Style switch by `uFlowStyle` int: flow=laminar (add constant drift `vec2(0.02, 0.0)`), pulse (radial breathing by beat phase `sin(2π·phase)·0.01`), shatter (flow quantized to 8 directions), drift (flow × 0.4, decay 0.99), swarm (curl × 1.6 with two rotating centers), bloom (radial outward × 1.5).
  2. `ink_inject.frag` (additive): 3 soft blobs (gaussian radius 0.06–0.14) orbiting the center with radius `0.18 + 0.1·sub` at angles `2π·(beatPhase + k/3)` (3 lobes; when meter triple the orbit uses 3 lobes anyway, when duple 4 lobes offset by k/4) — each blob's intensity = `bands[1+2k]·uInjectGain`; plus a thin ring (width 0.01) at radius `0.3` flashing with `downbeatPulse`; plus on `impact` a full-screen splash `impact·(1 − smoothstep(0, 0.6, dist))·1.5` into all three inks.
  3. `ink_color.frag`: map densities to color: `col = stops(sat(density.r))·wA + stops(sat(density.g)·hueShift)·wB + …` — concretely sample the 5-stop palette gradient at `luma = clamp(density.r·0.6 + density.g·0.3 + density.b·0.1)` and tint by `mix(paletteAccent, 1, 0.7)` where `density.b` dominates; `exposure` multiplies. Background `bg` where density < 0.02.
  Defaults: `decay 0.955`, `flowAmt 0.35`, `turbulence 0.4`, `injectGain 1.0`. Director: `decay = lerp(0.93, 0.985, build·0.6 + hypnotic·0.4)`, `flowAmt = lerp(0.15, 0.9, arousal)`, `turbulence = lerp(0.1, 1.0, tension)`, `pushKick = sub·0.02 + impact·0.08`, `injectGain = lerp(0.6, 1.6, arousal)`.
- **Post:** `MirrorPass` — n-fold kaleidoscope in polar coords around center, `folds = round(lerp(0, 8, tension))` when `hypnotic ≥ 0.6` or genre electronic_dance with `hypnotic ≥ 0.4`, else 0 (pass-through); soft seam blend 0.02 rad. `ChromaPass` — RGB split radial `chroma = lerp(0, 0.012, synthetic·arousal) + impact·0.02`; `posterize` levels = `synthetic > 0.7 && arousal > 0.7 ? 6 : 0` (0 = off); when posterize on, also rotate hue by `+0.15·beatPhase` (the acid look of reference 3 appears only for hard electronic peaks). Bloom: `strength = lerp(0.3, 1.4, arousal)`, `threshold = lerp(0.85, 0.55, valence)`, radius 0.6. `GrainVignettePass`: `grain = lerp(0.02, 0.12, noise)`, `vignette = lerp(0.55, 0.2, space)` (vast space = less vignette), `exposure = 1 + 0.25·impact + 0.1·downbeatPulse·arousal`.
- **Director v1:** weights for ink = 1 (others 0 until later tasks); implement all param formulas above; slew every scalar toward target with τ = 0.8 s except impact-driven terms (instant). `reducedMotion`: halve `flowAmt`, `pushKick`, `chroma`; `mirrorFolds = 0`; cap `exposure` ≤ 1.1. Strobe cap: `exposure` changes limited so that luminance direction flips ≤ 3 Hz (track last flip time).
- **Idle mode:** before audio, `main.ts` feeds `IDLE_MOOD` and a synthetic `FastFrame` (`beatPhase` from a 60 BPM clock, bands from slow sines) so the page breathes.
- `renderer.ts`: `WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })`, `setPixelRatio(min(devicePixelRatio, 1.5))`, resize on `ResizeObserver`, `dt` clamped to 0.1.

- [ ] **Step 1: Failing tests.** oklch: `oklchToRgb(0.9, 0, 0)` ≈ light gray (all channels within 0.02); `oklchToRgb(0.6, 0.2, 30)` → r > b; out-of-gamut request returns values within 0..1. palette: assertions above. director: with `IDLE_MOOD` and zero fast frame, weights.ink = 1; arousal 1 → flowAmt > 0.7 and bloomStrength > 1.0; reducedMotion → mirrorFolds 0; impact 1 → exposure ≥ 1.2; strobe cap: alternating impact 1/0 every frame at 60 fps → exposure direction flips ≤ 3 per second.
- [ ] **Step 2–4: run fail → implement pure modules → run pass.**
- [ ] **Step 5: Implement renderer, Composer, passes, InkFeedback, shaders. Wire `main.ts`: FastFrame from features/grid/timeline (`impact`, `build` from `tl.at(now)`), mood from `moodState.tick(now)` merged with `tl.at(now).mood` overrides (timeline wins when present); `direct()` → `visuals.frame()`.**
- [ ] **Step 6: Manual check** (the controller will screenshot): idle page shows slow marbled violet-blue ink drifting, no banding, ~60 fps at 1440p on an M-series Mac; with an EDM track: ink pulses on beats, palette shifts warm/neon, impact splash on the drop; classical: slow ivory/graphite, wide dark passages.
- [ ] **Step 7: Commit** `feat(visuals): renderer, palette, post chain, ink feedback scene, director v1`.

---

### Task 10: ParticleField (GPGPU) and Strands scenes

**Files:**
- Create: `src/visuals/scenes/ParticleField.ts`, `src/visuals/scenes/Strands.ts`, `src/visuals/shaders/particle_pos.frag.glsl`, `src/visuals/shaders/particle_vel.frag.glsl`, `src/visuals/shaders/particle_render.vert.glsl`, `src/visuals/shaders/particle_render.frag.glsl`, `src/visuals/shaders/strands.vert.glsl`, `src/visuals/shaders/strands.frag.glsl`
- Modify: `src/visuals/director.ts` (weights + particle/strand params), `src/main.ts` (addScene)
- Test: `tests/visuals/director.test.ts` (extend)

**Creative direction (binding):**
- **ParticleField** (references 4 and 6: glowing dust that gathers and scatters): `GPUComputationRenderer` 512×512 (262 k points; 768² if `renderer.capabilities.maxTextureSize ≥ 8192` and dpr ≤ 1.5). Velocity shader: `a = curlNoise(pos·0.35 + time·0.08)·uCurl + attractorForce(pos)·uAttract − vel·uDrag + impulse`. Attractors by `uAttractor` int: sphere (toward radius 1.2 shell), plane (toward y = 0 with gentle waves), vortex (tangential around y axis + inward), explode (outward from origin, decays to sphere over 2 s after impact), swarm (toward 3 moving targets on lissajous paths). `impulse = impact·normalize(pos)·3.0 + onset·randomDir·0.4`. Speed `uSpeed = lerp(0.2, 2.2, arousal)`. Position shader: `pos += vel·dt·uSpeed`, wrap radius 3. Render: points with size `lerp(1.2, 3.0, synthetic)·dpr`, additive blending, soft round sprite (`smoothstep(0.5, 0.0, d)`), color from palette gradient sampled by `speed` (fast = light stops) and tinted by accent for 12% of particles (by id hash). Depth-sorted not required (additive). Camera: perspective fov 50 at z = 4.2, slow orbit `θ = time·0.05 + 0.3·sin(time·0.02)`, dolly `z = 4.2 − 0.6·build` (build pulls in), snap-out `+0.8·impact` decaying.
- **Strands** (reference 6: vertical silk): 400 instanced ribbons, each a 64-segment strip; vertex shader displaces along a 3D flow `curl(pos·0.6 + time·0.1)·uBend` plus lateral sway `sin(time·0.7 + id)·0.1`; thickness `uThickness = lerp(0.004, 0.02, sub)`; colors alternate palette stops 2–4 with the accent on every 9th strand; alpha fades at ribbon ends. Camera z = 3, ribbons span y ∈ [−2, 2]. `uBend = lerp(0.2, 1.4, tension)`. Downbeat pulse brightens by +0.3.
- **Director weights** (before normalization): `ink = 0.55`, `particles = arousal·(1 − spoken)·(0.6 + 0.4·synthetic)`, `strands = (1 − arousal)·(0.5 + 0.5·tension)·(1 − spoken)`, `relief` and `breath` stay 0 until Task 11. Motion overrides: `swarm` → attractor swarm and `particles += 0.3`; `bloom` → attractor explode-on-downbeat (reuse explode with small force); `shatter` → `pointSize ×1.6`, `chroma ×2`; `drift` → strands `+0.2`; `pulse` → attractor sphere with radius breathing `1.2 + 0.25·sin(2π·beatPhase)`.
- Blend: `BlendPass` sums `weight_i · texture_i` with screen-blend for particles over ink (`1 − (1 − a)(1 − b)`) and normal add for strands.

- [ ] **Step 1: Extend director tests**: arousal 1, spoken 0 → particles weight > strands; arousal 0.1, tension 0.9 → strands > particles; spoken 1 → particles ≈ 0 and strands ≈ 0; motion 'swarm' → attractor 'swarm'.
- [ ] **Step 2–4: run fail → implement director changes → pass.**
- [ ] **Step 5: Implement scenes + shaders; register in main.**
- [ ] **Step 6: Manual check** (controller screenshots): EDM → particles dominate, explode on drop; slow minor piano → strands dominate, slow bend.
- [ ] **Step 7: Commit** `feat(visuals): gpgpu particle field and silk strands scenes`.

---

### Task 11: Relief and Breath scenes, complete Director blending, safety

**Files:**
- Create: `src/visuals/scenes/Relief.ts`, `src/visuals/scenes/Breath.ts`, `src/visuals/shaders/relief.vert.glsl`, `src/visuals/shaders/relief.frag.glsl`, `src/visuals/shaders/breath.frag.glsl`
- Modify: `src/visuals/director.ts`, `src/main.ts`
- Test: `tests/visuals/director.test.ts` (extend)

**Creative direction (binding):**
- **Relief** (references 2 and 5: monochrome mirrored terrain, charcoal with embers): 512×512 plane, vertex displacement `h = fbm(p·uFreq + time·0.03)·uHeight + bands-driven ridges (band 2–4 magnitude × sin along x)`; fragment: normals from finite differences, single directional light from upper-left, `color = mix(bg, stop4, pow(NdotL, uContrast))` with an ember tint: where `h > 0.6` and `aggression > 0.5` add `accent·(h − 0.6)·2·(0.5 + 0.5·sub)`. Camera looks down at 55°, slow pan. `uHeight = lerp(0.3, 1.2, aggression·0.5 + melancholy·0.5)`, `uContrast = lerp(1.0, 3.0, tension)`. MirrorPass is favored when Relief is dominant (folds ≥ 2 if `relief` weight > 0.5 even without hypnotic).
- **Breath** (speech/podcast): fullscreen shader, near-monochrome (palette with C × 0.2), a horizontal band of soft ridges whose height = current RMS (smoothed τ 0.15 s) and whose horizontal position scrolls slowly; a large gaussian glow breathing with a 6 s period plus RMS; grain 0.05; no bloom over 0.4; no mirror; no chroma. This scene must never flash.
- **Director final weights** (before normalization): `ink 0.55·(1 − spoken)`, `particles` and `strands` as Task 10 × `(1 − spoken)`, `relief = max(melancholy, aggression)·0.8·(1 − spoken)` (+0.3 when genre rock_metal or ambient_drone), `breath = spoken ≥ 0.5 ? spoken : 0`. Normalize to sum 1. Section rules: `build` → `decay += 0.02`, camera dolly in (particles z), `injectGain ×1.3`; `drop_climax` → `bloomStrength ×1.3` for 1 s after impact; `breakdown` → `particleSpeed ×0.5`, `decay −0.03` (ink dissolves). Safety: when `breath > 0.5` force `mirrorFolds 0`, `chroma 0`, `posterize 0`, `bloomStrength ≤ 0.4`.
- Idle: unchanged.

- [ ] **Step 1: Extend director tests**: spoken 1 → breath weight ≥ 0.95, mirrorFolds 0, chroma 0; melancholy 1, spoken 0 → relief > 0.3; genre rock_metal → relief boosted vs pop with same nouls; weights always sum to 1 ± 1e-6.
- [ ] **Step 2–4: run fail → implement → pass.**
- [ ] **Step 5: Implement scenes + shaders; register.**
- [ ] **Step 6: Manual check** (controller screenshots): podcast → Breath, no flashing; metal → charcoal relief with embers and mirror folds.
- [ ] **Step 7: Commit** `feat(visuals): relief and breath scenes, full director blending and safety`.

---

### Task 12: Integration polish, latency trim, browser gating, README, deploy config check

**Files:**
- Modify: `src/main.ts`, `src/ui/hud.ts`, `src/ui/banner.ts`, `README.md`
- Create: `src/app/state.ts` (small typed app-state machine: `idle → loaded → capturing → playing → paused`; file mode `analyzing → playing`)
- Test: `tests/app/state.test.ts`

**Requirements:**
- Latency trim from HUD (`loadTrim/saveTrim`) subtracts from measured `t` when writing detector cues and when reading `tl.at(now + trim)`; default = `estimateCaptureLatency`.
- Browser gating: no `getDisplayMedia` or non-Chromium → banner "Live YouTube analysis needs Chrome or Edge. You can still drop an audio file." Playback still works (visuals stay in idle mood with local RMS-less idle).
- Tab-share ended → toast + return to idle mood (keep last mood for 10 s then fade to IDLE).
- Page hidden → pause Jev calls (already), keep rendering at 15 fps cap.
- Keyboard: Space play/pause, H HUD, F fullscreen (hides UI except controls on hover).
- README: setup, Chrome requirement, how the pipeline works (3 paragraphs), token budget note, deployment steps (`vercel` env var), credits (noisotron taxonomy MIT, theory sources).
- `npm run build` clean; `grep -r TYPESAFE dist/` returns nothing.

- [ ] **Step 1: Failing test** for the state machine transitions (invalid transition throws; `file:drop` from any state → analyzing).
- [ ] **Step 2–4: implement → pass.**
- [ ] **Step 5: Manual full run** across the 7 genre links + a podcast + a local file; controller records screenshots and HUD readings.
- [ ] **Step 6: Commit** `feat: integration polish, latency trim, browser gating, docs`.

---

## Self-review notes

- Spec coverage: sources (T2, T3), analysis (T3–T6), Jev (T7), timeline (T8), visuals (T9–T11), safety/reduced motion (T9, T11), file offline mode (T8, T12), docs (T12). Oval card + feather (T2). Token budget enforced by test (T6, T7).
- Type consistency: `FrameFeatures`, `MoodInput`, `MoodVector`, `Cue`, `RenderParams`, `FastFrame` defined once (T1, T9) and referenced by name elsewhere. `BeatGrid.setMeter` added in T5 note and used by T5 wiring.

# JeVJ v2 — Download-first pipeline, two-pass Jev, TouchDesigner smoke

**Status:** implemented (Tasks 13–18 on `feat/jevj-v1`); the scrolling JSON columns of Task 16 shipped in reduced form with Task 18. See `.superpowers/sdd/task-18-report.md` for the final measurements and `docs/tuning-notes.md` for the real-track pass.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Tasks 13–18 continue the numbering of `2026-09-17-jevj-visualizer.md`, whose modules they reuse.

**Goal:** Paste a YouTube link → a local Node server downloads it with yt-dlp → the browser analyzes the whole track, runs Jev twice (segment moods, then transition/change-point judgments) and builds the complete cue timeline → playback of the downloaded video inside a small, heavily feathered square card, with a dramatic, full-screen, TouchDesigner-grade smoke field, wavy light strands, particles, and two scrolling JSON columns showing exactly what Jev was asked and answered, paced to the track.

**Architecture:** Local app only (`npm run dev` for development, `npm start` for a single Node process serving the built client, `/api/*` and `/media/*`). The server owns yt-dlp jobs, a media cache and the TypeSafe key. The browser decodes the downloaded audio, reuses `analyzeOffline` for the feature timeline, adds new vocal/harshness features, runs pass 1 (segments) and pass 2 (transitions) against `/api/mood` and a new `/api/transition`, then writes an `offline` timeline with exact impact timestamps and anticipation ramps. Live tab capture and the YouTube iframe are removed. File drop stays (same pipeline without the download).

**Tech Stack:** as v1 (Vite 8, TS strict, three 0.186, vitest, `@typesafe-ai/sdk` server-side) plus Node `child_process` for yt-dlp and a tiny hand-rolled HTTP layer (no Express) shared between Vite middleware and `server/index.ts`.

## Global Constraints (v2)

- **Local only.** No Vercel config, no `api/` functions. `TYPESAFE_API_KEY` from `.env`, server-side only. yt-dlp binary is `process.env.YT_DLP ?? 'yt-dlp'`; ffmpeg optional.
- **Jev remains the sole source of mood and of transition judgments.** Local DSP finds candidates and exact timestamps; Jev decides what they are and how hard they hit.
- **Whole-track pre-analysis before playback**, with a plain-text top caption `analyzing track 37%` (download 0–40%, features 40–60%, pass 1 60–85%, pass 2 85–100%), then `ready`. No title text anywhere.
- **Timeline is complete before play**; cue times in track seconds mapped to the audio clock at play/seek (existing `fileFlow` mapping). Impacts keep exact detector timestamps; anticipation ramps start 2 bars before.
- **Palette stays mood-driven** (v1 `paletteFor`), but the smoke's *base* reads as luminous smoke on black: darks stay black (idle p20 < 0.06), highlights bloom.
- **UI states:** `empty` (input bar centered, nothing else), `analyzing` (caption + progress, input hidden), `ready/playing/paused` (square card if video, none if audio file; play/pause button at screen center; input hidden — reload to change track).
- Pure modules (`src/analysis`, `src/timeline`, `src/mood`, `src/visuals/{director,palette,...}`, `server/ytdlp/parse*`) testable in Node. No per-frame allocations. Reduced motion and the < 3 Hz flip cap still hold.
- Every commit body ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Smoke reference (written description for implementers)

Four monochrome frames, black background. Long-exposure smoke or light-painting: large soft volumetric sheets and ribbons of pale blue-grey vapor curling in space; within each sheet, fine parallel striations run along the direction of motion (like combed silk or long-exposure light trails); folds where sheets overlap are brighter, with a soft luminous core that fades through translucent grey into pure black over a long falloff; occasional sharp bright filaments trace the leading edge of a curl; subtle film grain everywhere; nothing is flat, nothing has a hard edge; the forms rotate and fold rather than translate; roughly 60–70% of the frame is black, the rest is gradient. Motion character: slow majestic rolling with sudden fast whips on accents.

---

### Task 13: Local server — yt-dlp jobs, media cache, shared HTTP handlers

**Files:**
- Create: `server/http.ts` (tiny router: `route(method, pathPattern, handler)`, JSON body reading with 64 KB limit, `sendJson`, `sendFile` with `Range` support), `server/ytdlp/job.ts`, `server/ytdlp/parseProgress.ts`, `server/ytdlp/cache.ts`, `server/routes.ts` (mounts `/api/mood`, `/api/transition` (Task 14), `/api/resolve`, `/api/job/:id`, `/media/:file`), `server/index.ts` (`npm start`: serves `dist/` + routes on `PORT ?? 5173`), `server/devApiPlugin.ts` (modify: mount `routes.ts` instead of the single handler)
- Delete: `vercel.json`, `api/mood.ts`
- Test: `tests/server/parseProgress.test.ts`, `tests/server/job.test.ts` (fake spawn), `tests/server/cache.test.ts`, `tests/server/http.test.ts` (Range parsing)

**Interfaces produced:**
```ts
// server/ytdlp/parseProgress.ts
export function parseProgressLine(line: string): { percent: number } | { done: true; path: string } | null; // handles "[download]  37.2% of ..." and "[Merger] Merging formats into "cache/abc.mp4"" / "[download] Destination: ..." / "already been downloaded"
// server/ytdlp/job.ts
export type JobState = { id: string; videoId: string; status: 'queued'|'downloading'|'done'|'error'; percent: number; title?: string; durationSec?: number; mediaPath?: string; error?: string }
export interface Spawner { (cmd: string, args: string[], onLine: (l: string) => void): Promise<number> } // exit code
export class JobRunner { constructor(cacheDir: string, spawn: Spawner, binary?: string); start(videoId: string): JobState; get(id: string): JobState | undefined }
//   args: ['-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4', '--no-playlist', '--newline', '--print-json', '-o', `${cacheDir}/%(id)s.%(ext)s`, `https://www.youtube.com/watch?v=${videoId}`]
//   title/duration parsed from the --print-json line; cache hit (file exists) → done immediately with percent 100
// server/ytdlp/cache.ts
export function cachedMedia(cacheDir: string, videoId: string): string | null; // <id>.mp4 if present
// server/routes.ts
export function createRoutes(deps: { jev: JevLike; jobs: JobRunner; cacheDir: string }): Router
//   POST /api/resolve {url} → 400 invalid url (reuse src/source/urlParse via a server-safe copy in server/urlParse.ts or import the pure module) | 200 {jobId}
//   GET /api/job/:id → JobState (404 unknown)
//   GET /media/:file → file from cacheDir only (path-traversal safe), Range support, Content-Type video/mp4
```
- Client: `src/source/youtubeJob.ts` — `resolveYouTube(url, onProgress): Promise<{ mediaUrl: string; title: string; durationSec: number }>` polling `/api/job/:id` every 500 ms.
- Steps: TDD the pure pieces (progress parser incl. `\r` carriage returns, cache, Range parsing, job state with a fake spawner emitting canned yt-dlp output); implement the router and `index.ts`; wire the dev plugin; manual check `curl -X POST localhost:5173/api/resolve -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'` then poll; commit `feat(server): yt-dlp jobs, media cache, local http layer`.

---

### Task 14: Full-track analysis — vocal/harsh features, pass 1 + pass 2 Jev, transition cues, analysis record

**Files:**
- Create: `src/analysis/vocal.ts`, `src/mood/transitionQuestions.ts`, `src/mood/transitionDecode.ts`, `src/timeline/transitionWriter.ts`, `src/app/trackAnalysis.ts` (orchestrates download → decode → features → pass 1 → pass 2 → timeline; emits progress), `server/transitionHandler.ts` (+ route `/api/transition`)
- Modify: `src/shared/types.ts` (`MoodInput.vocal`, `MoodInput.harsh`; `TransitionInput`, `TransitionVerdict`, `TrackAnalysis`), `src/shared/moodSchema.ts`, `src/analysis/summarizer.ts`, `src/timeline/offlineAnalyzer.ts` (expose candidates), `src/mood/questions.ts` (legend entries)
- Test: per module under `tests/`

**New features (binding):**
- `vocal` 0..1: pitch salience in 100–1000 Hz (harmonic-sum on chroma-free spectrum: ratio of energy at f, 2f, 3f peaks vs total in 100–4000 Hz), × formant-band share (energy 1–3 kHz / 200 Hz–8 kHz), smoothed τ 0.5 s. Test: sung-vowel synth (harmonic series with formant emphasis) → ≥ 0.6; sawtooth pad chord → ≤ 0.35; white noise → ≤ 0.2.
- `harsh` 0..1: `clamp(0.4·brightness + 0.3·flatness + 0.3·loudRel)` when `attack = sharp`, else ×0.6, where `loudRel` is position within the session loudness range. Test: bright loud noise burst train → ≥ 0.7; soft pad → ≤ 0.2.

**Pass 2 — transitions (binding):**
```ts
export interface TransitionInput { at: string /* m:ss */; before: MoodInput /* 4 bars before */; after: MoodInput /* 4 bars after */; jumpDb: number; gapBeforeSec: number; bpmBefore: number; bpmAfter: number; keyChanged: boolean; vocalDelta: number; harshDelta: number; }
export type TransitionKind = 'drop'|'build_start'|'breakdown'|'break_silence'|'vocal_entry'|'scream_peak'|'quiet_fall'|'tempo_change'|'key_change'|'none';
export interface TransitionVerdict { kind: TransitionKind; kindP: Record<TransitionKind, number>; intensity: number /*0..1*/; dramatic: number /*P*/; release: number /* 0 tension-building .. 1 release */; confidence: number }
```
Candidates: novelty peaks ≥ 0.25 (min spacing 4 bars), every detector impact/gap, bpm change > 6%, key tonic change with fit > 0.5, `vocal` crossing 0.5 either way, `harsh` crossing 0.6. Cap at 60 candidates per track (keep highest novelty). One `/api/transition` call per candidate (batched 4 per request by putting four `TransitionInput`s in the state as `t0..t3` with question ids suffixed — see parallel-questions cookbook; the handler splits answers back). Questions (verbatim, structured criteria):
- `kind` Choice: drop `{what:"the payoff: full energy slams in after a build or gap"}`, build_start `{what:"energy begins rising toward something"}`, breakdown `{what:"energy is pulled away after a peak, stripped down"}`, break_silence `{what:"a sudden hole: near-silence or a filter cut"}`, vocal_entry `{what:"a voice enters or becomes the focus"}`, scream_peak `{what:"harsh, screamed or distorted climax"}`, quiet_fall `{what:"gentle fall into a quiet passage"}`, tempo_change `{what:"the pulse speeds up or slows down"}`, key_change `{what:"the harmony moves to a new key"}`, none `{what:"no meaningful change here"}`
- `intensity` Score 5: `["imperceptible","gentle shift","clear change","strong hit","overwhelming slam"]`
- `dramatic` Noul: `"Would a listener feel a jolt (goosebumps, a held breath, a gasp) at this moment?"`
- `release` Score 3: `["tension is being built","neutral","tension is being released"]`

**Cue writing (`transitionWriter.ts`, binding):** drop → impact cue at the exact detector time (or candidate time) with `impact = intensity`, anticipation ramp `build` 0→1 over the 2 bars before, `section: 'drop_climax'`; build_start → `section: 'build'`; breakdown/quiet_fall → `section: 'breakdown'` and a `decay` hint (`mood.arousal` lowered by 0.3 for the next 2 bars); break_silence → `build: 1` at the hole, impact on the return if energy jumps ≥ 6 dB; vocal_entry → `mood.space + 0.2`, a `pulse` marker cue; scream_peak → impact cue with `impact = max(intensity, 0.8)` and `mood.aggression = 1` for 1 bar; tempo_change/key_change → `section` unchanged, `mood.tension + 0.2` for 2 bars; all `dramatic ≥ 0.6` cues also set `flourish = true` (new Cue field) so the Director can fire a one-shot flourish. Pass 1 remains the per-segment `offline` mood cues.

**Analysis record:** `TrackAnalysis { videoId?: string; title: string; durationSec: number; segments: {start,end,input,mood}[]; transitions: {at,input,verdict}[]; cues: Cue[]; log: { t: number; dir: 'req'|'res'; json: string }[] }` — `log` holds every request and response body (compact JSON) with the track time it refers to; it feeds Task 16. Server caches `TrackAnalysis` by videoId under `cache/<id>.analysis.json` (POST `/api/analysis/:id`, GET) so a re-run is instant.

Steps: TDD features and writers with synthesized fixtures (extend `synth.ts`: `sungVowel`, `noiseBurstTrain`, and a 60 s "song" fixture with intro → build → drop → breakdown → scream); handler tests with a fake Jev; smoke run against the live key on the fixture; commit `feat(analysis): vocal/harsh features, transition pass, track analysis record`.

---

### Task 15: UI v2 — centered input, square feathered card, center transport, analyzing caption, states

**Files:**
- Modify: `src/ui/styles.css`, `src/ui/card.ts`, `src/ui/controls.ts`, `src/ui/toast.ts`, `src/app/state.ts`, `src/app/transport.ts`, `src/app/fileFlow.ts` → `src/app/trackFlow.ts` (YouTube and file share one flow), `src/main.ts`
- Delete: `src/source/youtubePlayer.ts`, `src/source/youtube.d.ts`, `src/source/tabCapture.ts` (+ tests), banner usage for tab capture
- Create: `src/ui/caption.ts`, `tests/app/state.test.ts` (update)

**Design (binding):**
- **Empty state:** only the input bar, centered vertically and horizontally (`min(560px, 80vw)`), placeholder `paste a youtube link`, hint `or drop an audio file` beneath. Nothing else on screen but the smoke.
- **Analyzing:** input hides (fade 300 ms); caption at top-center, plain text, no background: `analyzing track 37%` in the UI font 13 px, letter-spacing 0.08em, opacity 0.8, percentage ticking as progress arrives. Cancelling = reload.
- **Ready (video):** square card side `min(30vw, 440px)`, `border-radius: 14%`, centered; the downloaded video (`<video playsinline muted=false>`) inside with `object-fit: cover`; feather: `mask-image: radial-gradient(circle at center, #000 40%, rgba(0,0,0,.55) 62%, rgba(0,0,0,.15) 82%, transparent 100%)` (very soft; no visible rim), plus a halo sibling scaled 1.35 with `backdrop-filter: blur(28px)` masked `radial-gradient(circle, #000 35%, transparent 100%)`. **Ready (audio file):** no card.
- **Transport:** one 64 px glass circle at the exact screen center (over the card when present); auto-hides 2 s after the pointer stops while playing, returns on pointer move; Space toggles.
- **Caption after analysis:** `ready` for 1.5 s then fades out; nothing else at the top. HUD (`H`) unchanged.
- **States** (`src/app/state.ts`): `empty → resolving → analyzing → ready → playing ⇄ paused → ended`; `file:drop` allowed from `empty` and `ready/ended` (starts over); errors → `empty` with a toast. All events legal from all states as no-ops where not listed (no throws in production paths; the machine returns `{next, changed}`).
- Playback drives the analysis-time mapping exactly as `fileFlow` did (`ctx.currentTime − el.currentTime` at play/seek); for video, the `<video>` element is the media element connected to the audio graph (`createMediaElementSource(video)`), analyser + destination.
- Commit `feat(ui): centered input, square feathered card, center transport, analyzing caption, v2 states`.

---

### Task 16: Scrolling JSON columns (request left, response right), paced to the track

**Files:**
- Create: `src/ui/jsonColumns.ts`, `src/app/columnsLink.ts`, `src/ui/columns.css`, `tests/ui/jsonColumns.test.ts`

**Design (binding):**
- Two columns, each `min(34vw, 520px)` wide, full height, 16 px from the screen edges; left column text aligned left, right column aligned right. Monospace 12.5 px, line-height 1.5, color from the palette's light stop at 70% opacity; the entry whose track-time span contains the current playhead is highlighted (100% opacity, accent-colored key names).
- Content: left = every request body from `TrackAnalysis.log` with `dir: 'req'` (segments then transitions in track order), pretty-printed 2-space JSON, separated by a one-line header `#12 · 1:32 · segment` / `#31 · 2:04 · transition`; right = the matching responses (`dir: 'res'`) in the same order.
- Pacing: the left column scrolls **bottom → top**, the right **top → bottom**; total scroll distance = column content height + viewport height; offset = `(t / duration) × distance` so both start off-screen at t = 0 and finish off-screen at the end; seeking jumps; pause holds. Pure `columnOffset(t, duration, contentHeight, viewportHeight, direction)` tested.
- Rendering: content is laid out once (DOM text nodes in a translated container; `transform: translateY` per frame, `will-change: transform`); no per-frame DOM churn.
- Commit `feat(ui): request/response json columns paced to the track`.

---

### Task 17: Smoke v2, wavy strands, flourishes — the TouchDesigner pass

**Files:**
- Modify: `src/visuals/scenes/InkFeedback.ts` → rename to `Smoke.ts` (keep slot name `ink`), shaders `ink_*.glsl` → `smoke_*.glsl`, `src/visuals/scenes/Strands.ts` + shaders, `src/visuals/director.ts`, `src/visuals/post/Composer.ts` (+ `AfterimagePass`), `src/app/visualLink.ts`
- Test: director tests extended; `tests/visuals/smokeMath.test.ts` for pure helpers

**Creative direction (binding):**
1. **Rotation.** The smoke's flow field gains a global rotation about the screen center: angular rate `ω = 0.18·(0.4 + arousal) rad/s` (a full turn every ~35 s at mid arousal), plus a beat kick `+0.9·onset·sign` decaying τ 0.4 s, and a **spin reversal** on every `drop`/`breakdown` transition cue (direction flips over 1.5 s). Uniform `uSpin` (angle) advanced in TS.
2. **Spread.** Injection moves from the center to an **annulus around the card** (inner radius = card half-diagonal in UV, outer = +0.18), so smoke is born at the card's feathered edge and is carried outward by `radial(uv)·uPushOut` (`uPushOut = 0.012 + 0.02·arousal + impact·0.1`) and the spin — the visible area outside the card fills with rolling smoke; the card region stays darker. Audio-file mode (no card): annulus around a virtual center square of the same size.
3. **Striations (the long-exposure look).** In the feedback pass, replace the isotropic 4-tap blur with an **anisotropic blur along the local flow direction**: 5 taps at `uv ± k·normalize(flow)·texel·(1 + 2·turbulence)`, k = 1..2, weights `[.1,.2,.4,.2,.1]`. Add a **striation modulation**: multiply the injected density by `0.75 + 0.25·sin(dot(uv, perp(flow))·uStriate)` with `uStriate = 380 + 220·synthetic` so sheets carry fine parallel streaks.
4. **Sheets and filaments.** Beat injection becomes **filaments**: on each onset, 2–3 thin bright curves (quadratic Bezier in UV, length 0.25–0.5, width 0.004) seeded on the annulus with tangent along the flow; they smear into sheets under the anisotropic blur. Downbeats emit a ring on the annulus (as before, on the annulus). The ambient veined field stays but at half rate.
5. **Cores and falloff.** Color mapping: `luma = 1 − exp(−2.0·d)`; then `luma = pow(luma, 1.35)` for deeper mids; highlight `> 0.85 → stop4·1.25`. Add a **volumetric shading** term: `luma *= 0.85 + 0.3·dot(gradient(d), lightDir)` with `lightDir` rotating with `uSpin` so folds catch light.
6. **Flourishes** (`Cue.flourish`): one-shot events read from the timeline by the Director: `drop` → 0.6 s radial burst (`uPushOut` ×6, exposure +0.35, chroma +0.02, spin reversal), `break_silence` → smoke freezes (flowAmt → 0.05 for the hole) and decays fast (decay 0.9), `scream_peak` → 0.4 s white flare (exposure +0.5 clipped by the strobe limiter, grain ×2, mirror mix 0.6 for 1 s), `vocal_entry` → 1.2 s central bloom swell (bloom ×1.4) and strands brighten, `quiet_fall` → 3 s slow fade (decay 0.985, injectGain ×0.4). All clamped by reduced motion and the breath safety.
7. **Wavy strands.** Ribbon displacement adds traveling waves: `x += A·sin(y·kf + t·ws + phase)` with `A = 0.12 + 0.35·bands[3]`, `kf = 2.5 + 3·tension`, `ws = 1.2 + 4·arousal`, plus a slow horizontal drift `x += 0.05·t·(h−0.5)` wrapped in [−3, 3]; beat-locked **light pulses travel along the ribbons**: brightness `× (1 + 1.5·exp(−((y − yPulse)²)/0.02))` where `yPulse` sweeps −2→2 over one beat from `beatPhase`. Strands must never look static: assert in a test that the displacement function's time derivative is non-zero for all params.
8. **Afterimage.** Add `AfterimagePass` (damp `0.85 + 0.1·hypnotic`, 0.6 on `shatter`) before bloom for motion smear; reduced motion → 0.
9. Idle: slow rotation, sparse filaments on the 60 BPM idle clock, ambient annulus around the (absent) card center.

Tests: pure helpers (spin integration, annulus mapping from card rect, flourish scheduler with cooldowns, strand displacement derivative, columnOffset). Browser: screenshots at idle, build, drop, breakdown on the 60 s song fixture; measured idle luma targets unchanged. Commit `feat(visuals): smoke v2 with rotation, spread, striations, filaments, flourishes; wavy strands; afterimage`.

---

### Task 18: Integration, real-track tuning, docs

- Wire `trackFlow` end to end: URL → `/api/resolve` → progress caption → decode → `trackAnalysis` (pass 1 + 2, progress) → timeline + columns → ready → play. File drop → same from decode. Server-side `TrackAnalysis` cache.
- Remove dead code (iframe, tab capture, Vercel), update README (local run, yt-dlp requirement, personal-use note, how the two Jev passes work, token numbers per track), `.env.example`.
- **Real-track tuning** (controller runs yt-dlp locally): a classical adagio, an EDM track with a known drop, a trap track, a metal track with screams, a jazz trio, an ambient piece, a podcast. Record per track: detected transitions vs. what the ear says, drop timing (frame vs waveform), tokens used, visual notes; adjust Director/smoke knobs only; document in `docs/tuning-notes.md`.
- Final whole-branch review, merge to main.

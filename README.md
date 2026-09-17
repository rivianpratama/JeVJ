# JeVJ

JeVJ is a browser audio visualizer: it listens to what is playing, describes the
music to [TypeSafe](https://typesafe.ai)'s Jev model as a compact typed
snapshot — tempo, key, dynamics, spectral shape, build cues — and turns the
judgment that comes back (valence, arousal, genre, section, whether a drop is
about to land) into three.js visuals that move with the track.

## Run it

```sh
cp .env.example .env   # then put your TypeSafe key in TYPESAFE_API_KEY
npm install
npm run dev            # http://localhost:5173
```

The key is read server-side by the dev middleware and by the Vercel function; it
never reaches the client bundle. The browser only ever calls `POST /api/mood`.

`npm test` runs the unit suite (vitest, Node environment); `npm run build`
type-checks and builds; `npm run smoke` makes one real call per question set and
prints what each costs.

### Chrome or Edge, for a YouTube link

Live analysis of a YouTube video works by sharing this very tab's audio through
`getDisplayMedia`, which only Chromium browsers offer. Elsewhere the page says
so and everything else still works: the video plays, and a local audio file
dropped anywhere on the page is analysed end to end. Paste a link, press play,
and tick **Also share tab audio** in the share picker.

Keys: **space** play/pause, **H** the diagnostics overlay, **F** fullscreen
(the interface fades out and comes back under the pointer).

## How it works

**The fast layer** runs on every display frame, in the browser, and never asks
anyone anything. An `AnalyserNode` hands `src/analysis/**` a 4096-point spectrum;
out of it come the band energies, the onset envelope, a tempo and a beat grid, a
Krumhansl–Kessler key estimate, loudness class and dynamic range, spectral
centroid and flatness, a speech likeness, and the build cues (how much louder the
last four and eight bars got, how much denser). All of it is pure — no DOM, no
Web Audio — so the same code sweeps a dropped file offline before a sample of it
plays. When the page is hidden the analysis moves off display frames onto a 33 ms
timer, because the music does not stop when the user looks away.

**The slow layer** is Jev. Every 2.5–8 seconds — sooner when the music changes,
sooner still just before a phrase boundary — `src/analysis/summarizer.ts` packs
the current state into about 150 tokens of JSON and asks for a judgment: two
handfuls of Score, Noul and Choice questions about valence, arousal, tension,
warmth, how synthetic and how large it sounds, whether it is speech, which genre,
which part of the form, how abstract visuals should move, and, into a build,
whether a drop is coming and how hard it will hit. The answers are decoded into a
`MoodVector` and slewed rather than assigned, so the picture never flinches when
the model speaks.

**The director** (`src/visuals/director.ts`) is the only place that decides
anything about the look. It turns the mood and the current frame into one
`RenderParams`: how the five scenes — ink feedback, particle cloud, silk strands,
relief terrain, breath — are mixed, the palette, and every post-chain number.
Two rules shape all of it. *Slew, don't cut*: every slow scalar moves toward its
target with a 0.8 s time constant, because Jev's answers arrive as steps. *Never
strobe*: exposure may not reverse direction more than three times a second, and
`prefers-reduced-motion` halves the motion and puts the kaleidoscope away.

### How a drop lands on the beat

Jev's prediction is a count of beats, not an instant, so `timeline/jevWriter.ts`
resolves it against the beat grid — the predicted downbeat nearest the count, or
the downbeat that starts the next 16-bar phrase if that is within two bars of it
— and writes an anticipation ramp from now to that target onto the 0.2 s cue
timeline. The local drop detector watches the audio for the transient itself and
re-anchors the impact to the exact frame it arrives on, within one analyser hop.
Everything on the timeline is stamped in analysis time and read back at
`now + latency` (`src/app/cueReader.ts`), so what the visuals do is what the
listener is hearing rather than what the analysis has reached; the HUD's trim
slider is there for whatever the latency estimate misses.

## What a call costs

The payload is 143 estimated tokens for the reference example and 153 in the
worst case, against a 160-token budget a test enforces. The questions are far
more expensive than the payload, so a call only asks what is worth asking: ten
core questions every time, four Nouls on alternate calls, and the four
predictive ones only into a build. Measured against the live model on the same
payload:

| question set | questions | tokens | latency |
| --- | --- | --- | --- |
| everything | 18 | 3380 | 842 ms |
| core + Nouls (every other call) | 14 | 2750 | 308 ms |
| core only (the ordinary call) | 10 | 2456 | 718 ms |

Steady state, away from a build, is therefore about 2.6k tokens a call at one
call every 2.5–8 seconds. A partial answer is not a partial mood: whatever a
call did not ask is filled in from the previous vector, except the predictions,
which are withdrawn rather than carried.

## Deploy

Deploys to Vercel as a Vite app with serverless functions under `api/`:

```sh
vercel link
vercel env add TYPESAFE_API_KEY production   # and preview, if you use it
vercel deploy --prod
```

There is no client-side fallback: without the environment variable the function
answers `mood service is not configured` and the visuals run on their idle mood.
`npm run build` must be clean and `grep -ri typesafe dist/` must return nothing
before a deploy — the key, and the SDK, are server-side only.

## Credits

- **[noisotron](https://github.com/rivianpratama/noisotron)** (MIT) — the
  five-axis mood taxonomy, the adaptive smoothing window and the log-band
  normalization this analysis grew out of.
- **Open Music Theory** — scales, modes and meter.
- **Krumhansl & Kessler** — the key profiles the key estimator correlates
  against.
- **Juslin & Västfjäll** — the feature→affect anchors (tempo, mode, loudness and
  articulation against valence and arousal) behind the mood questions' rubrics.
- **Plomp & Levelt** — critical-band sensory dissonance, which the consonance
  reading is taken from.

`docs/music-theory-notes.md` records which idea became which feature and which
question it feeds.

# JeVJ

JeVJ turns a track into a picture. Paste a YouTube link; the app downloads the
audio, sweeps it with a music-theory-aware DSP pass, asks
[TypeSafe](https://typesafe.ai)'s **Jev** model what each passage *feels* like
and what each seam *is*, writes the answers onto a cue timeline stamped in track
seconds, and only then lets a note of it play. What you watch is luminous smoke
rolling around a small square of video, with the whole transcript of the asking
scrolling past on the walls.

It is a local app. It downloads video with `yt-dlp` and keeps gigabytes of it in
`cache/`, which is a thing that runs on your own machine.

## Run it

You need **Node 22+** (`engines.node` says so) and
**[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on your PATH, at least
**2026.08.19** — older builds fail on current YouTube signatures, measured.
`ffmpeg` is optional for the app itself: without it yt-dlp takes whatever single
stream already has the audio in it, which is fine for everything here. It is
*required* for `scripts/calibrate/probe-features.ts`, which decodes real tracks
off disk.

```sh
cp .env.example .env    # put your TypeSafe key in TYPESAFE_API_KEY
npm install
npm run dev             # http://localhost:5173
```

The dev server mounts the API routes through a Vite plugin whose
`configureServer` runs **once**, when the server starts. Editing anything under
`server/` therefore needs a restart — HMR reloads the client, not the middleware
— and a change that seems to have had no effect is usually this.

yt-dlp moves fast and YouTube moves faster; a build more than a few months old
will fail on some links with nothing more helpful than a signature error. If the
one on your PATH is old, point `YT_DLP` at a current one rather than fighting
your package manager:

```sh
python3 -m venv .ytvenv && .ytvenv/bin/pip install -U yt-dlp
echo 'YT_DLP=.ytvenv/bin/yt-dlp' >> .env     # or an absolute path
```

`npm run build && npm start` serves the built app from the same Node process on
the same port, with the same routes. It binds **loopback only**; set `HOST` in
`.env` (to `0.0.0.0`, say) if you really want it on your network, remembering
that it will download whatever video id anyone hands it. `PORT` moves the port.

`npm test` runs the unit suite (vitest, Node environment, no GPU). The two smoke
scripts talk to the real model and are **dry by default** — they build every
request and print what it would have cost without opening a socket. Add `--live`
to spend the calls:

```sh
npm run smoke                        # one mood call, measured, not sent
npm run smoke -- --live              # actually send it
npm run smoke:transition             # a whole track's two passes, dry
npm run smoke:transition -- --live   # ~10 calls against the song fixture
```

The `TYPESAFE_API_KEY` is read by the server only — the dev middleware and the
Node server both hold it, and the browser only ever calls `POST /api/mood` and
`POST /api/transition`. `grep -ri typesafe dist/` must come back empty.

**Personal use.** Downloading from YouTube is against its Terms of Service
unless the video offers a download or is in the public domain. This is a tool
for looking at music you already have the right to listen to, on your own
machine; nothing here uploads, redistributes or keeps anything but a local
cache. What you point it at is your call and your responsibility.

Keys: **space** play/pause, **H** the diagnostics overlay, **F** fullscreen.

**Dropping a file** works whenever nothing is in flight — from the opening
screen, from `ready`, and from the end of a track — and starts the pipeline
over. Only *pasting a link* needs a reload: the URL bar is gone once a track is
loaded, because there is one media element for the life of the page and the
whole analysis is about the track that is in it.

## How it works

### The whole track, before any of it plays

A link goes to `POST /api/resolve`, which starts a yt-dlp job and streams its
progress; the finished file is served back out of `cache/` and the browser
decodes it. A dropped audio file skips straight to the decode. From there both
paths are one pipeline (`src/app/trackFlow.ts`), and the caption counts it out:
download 0–40%, features 40–60%, pass 1 60–85%, pass 2 85–100%, then `ready`.

**The sweep** (`src/analysis/**`, driven by `src/timeline/offlineAnalyzer.ts`)
is the same pure DSP the live layer used to run, over the decoded samples at
whatever speed the CPU manages. Out of it come band energies, an onset envelope,
a tempo and a beat grid, a Krumhansl–Kessler key estimate, loudness class and
dynamic range, spectral centroid and flatness, a speech likeness, a sung-voice
and a harshness reading, and the build cues. It also cuts the track into
sections and proposes *candidate moments* — the transients, the holes, the
loudness jumps — which is where pass 2 starts.

### Two passes, and what each is for

The difference is the point: **a mood cross-fades and a moment does not.**

**Pass 1 — what does this passage feel like.** One call per section.
`src/analysis/summarizer.ts` packs that section's state into about 150 tokens of
JSON and asks a set of Score, Noul and Choice questions: valence, arousal,
tension, warmth, how synthetic and how large it sounds, whether it is speech,
which genre, which part of the form, how abstract visuals should move. The
answers are decoded into a `MoodVector` and written onto the timeline as a mood
cue at the section's start. The renderer slews toward them, so nothing ever
snaps.

**Pass 2 — what *is* this moment.** The candidates the sweep found, four to a
request, each described by the bars either side of it: how far the loudness
jumped, how long the hole was, whether a voice arrives, whether it turns harsh.
Jev names the kind — `drop`, `breakdown`, `break_silence`, `scream_peak`,
`vocal_entry`, `quiet_fall`, `build_start`, or `none` — and says how hard it
hits. A batch that fails is asked once more after two seconds; a batch that
fails twice is written off, the transcript says so, and the bar still reaches
100%.

### The cue timeline

Everything both passes said goes onto one timeline (`src/timeline/timeline.ts`)
in **track seconds**, at a 0.2 s step, from named sources that can be replaced
independently. A transition cue carries its kind, its exact detector timestamp —
not the model's estimate of it — and an anticipation ramp that starts two bars
early. At play and on every seek the whole thing is mapped onto the audio clock
in one shift (`trackFlow.place`), and the renderer reads it at `now + latency`
so what the picture does is what the listener is *hearing*. The HUD's trim
slider covers whatever the latency estimate misses, a bluetooth speaker mostly.

Because the timeline is complete before playback, a drop lands on the sample it
lands on. Nothing is predicted live and nothing has to be caught up with.

### The director

`src/visuals/director.ts` is the only place that decides anything about the
look. Mood plus this frame's features go in; one `RenderParams` comes out — how
the five scenes (smoke, particle cloud, silk strands, relief terrain, breath)
are mixed, the palette, and every post-chain number. Two rules shape all of it.
*Slew, don't cut*: every slow scalar moves toward its target with a 0.8 s time
constant. *Never strobe*: exposure may not reverse direction more than three
times a second, and `prefers-reduced-motion` halves the motion and puts the
kaleidoscope away.

The smoke itself (`src/visuals/scenes/Smoke.ts` and `shaders/smoke_*.glsl`) is a
feedback loop: advect along a curl field, fade, smear *along the flow*, then
inject this frame's light on an annulus around the card. Its rotation is a
reaction rather than a rate — `0.22·arousal²·beatConf·regular·(1 − spoken)`, plus
a drift of 0.004 rad/s so that a podcast's picture is still alive and is not
spinning.

### The transcript

Every request and every response is kept with the track time it is about
(`TrackAnalysis.log`) and printed down the two sides of the screen: questions on
the left, travelling bottom to top, answers on the right, travelling top to
bottom, both paced so the entry level with your eye is the one about the passage
you are hearing (`src/ui/jsonColumns.ts`). Seeking jumps them; pausing holds
them.

## What a track costs

Measured end to end through the app, with the analysis cache cleared. Pass 1 is
one call per section and pass 2 is one call per four candidate moments, so the
bill scales with how *eventful* a track is rather than with how long it is.

| track | length | calls | input tokens | output tokens | elapsed |
| --- | --- | --- | --- | --- | --- |
| Satie, *Gymnopédie No. 1* | 4:05 | 43 | 167,893 | 24,703 | ~34 s |
| Avicii, *Levels* | 3:18 | 35 | 143,395 | 20,047 | ~25 s |
| Travis Scott, *SICKO MODE* | 5:14 | 50 | 189,136 | 28,586 | ~27 s |
| Slipknot, *Duality* | 3:35 | 34 | 143,001 | 19,778 | ≤ 40 s |
| Brian Eno, *An Ending (Ascent)* | 4:21 | 42 | 165,457 | 24,211 | ≤ 40 s |
| Richard St. John, TED talk | 3:46 | 43 | 168,680 | 24,729 | ≤ 40 s |

Around **4,000 input and 570 output tokens a call**, and **150k–190k input and
20k–29k output for a four-minute track**, download included in the elapsed time.
A second play of the same link is served from `cache/` and costs nothing.

`docs/tuning-notes.md` has the rest of that pass: what each track's transitions
came back as, whether the ear agrees, and what the picture did.

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

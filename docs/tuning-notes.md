# Real-track tuning notes (v2.1)

Six tracks through the finished app — paste, download, analyse, play — on
`feat/jevj-v1`, Chrome, macOS, 1440×900 with the pixel ratio capped at 1.5.
yt-dlp 2026.08.19 from a venv (`YT_DLP` in `.env`). Every run below is a cold
analysis: `cache/*.analysis.json` was absent, so the elapsed time and the token
count are what a *first* play costs. A second play of the same link is served
from the cache and is instant.

"Elapsed" is from pressing enter to the caption saying `ready`, download
included.

## The six

| | track | length | segments | candidates | calls | input tok | output tok | elapsed |
|---|---|---|---|---|---|---|---|---|
| classical | Satie, *Gymnopédie No. 1* ([2WfaotSK3mI](https://www.youtube.com/watch?v=2WfaotSK3mI)) | 4:05 | 28 | 60 | 43 | 167,893 | 24,703 | ~34 s |
| EDM | Avicii, *Levels* ([_ovdm2yX4MA](https://www.youtube.com/watch?v=_ovdm2yX4MA)) | 3:18 | 20 | 58 | 35 | 143,395 | 20,047 | ~25 s |
| trap | Travis Scott, *SICKO MODE* ([d-JBBNg8YKs](https://www.youtube.com/watch?v=d-JBBNg8YKs)) | 5:14 | 35 | 60 | 50 | 189,136 | 28,586 | ~27 s |
| metal | Slipknot, *Duality* ([6fVE8kSM43I](https://www.youtube.com/watch?v=6fVE8kSM43I)) | 3:35 | 19 | 60 | 34 | 143,001 | 19,778 | ≤ 40 s |
| ambient | Brian Eno, *An Ending (Ascent)* ([OlaTeXX3uH8](https://www.youtube.com/watch?v=OlaTeXX3uH8)) | 4:21 | 30 | 60 | 42 | 165,457 | 24,211 | ≤ 40 s |
| speech | Richard St. John, *Secrets of success* ([Y6bbMQXQ180](https://www.youtube.com/watch?v=Y6bbMQXQ180)) | 3:46 | 28 | 60 | 43 | 168,680 | 24,729 | ≤ 40 s |

Calls are one per segment (pass 1) plus one per four candidates (pass 2), so
the bill tracks how *eventful* a track is rather than how long it is. Roughly
**4,000 input and 570 output tokens per call**, or **150k–190k input and
20k–29k output for a four-minute track**. The candidate detector caps at 60, and
five of the six hit that cap.

## Track by track

### Satie — *Gymnopédie No. 1* (classical)

**Found:** 60 of 60 candidates named as something — no `none` at all. 40
`key_change`, 9 `tempo_change`, and eleven moments that fire a flourish:
`build_start` 0:27 (0.77) and 0:38, `breakdown` 1:53 and 2:03, **`drop` 1:59
(0.77)**, three `quiet_fall`, `vocal_entry` 3:37, `break_silence` 3:38, and
**`drop` 3:46 (0.92, confidence 0.80)**.

**Against the ear:** the `key_change` flood is defensible — this is a piece of
continuous modal shifts and the chroma tracker really does move — and the
`tempo_change` calls are the rubato. The two `drop`s are not. There is no drop
in a Gymnopédie. The one at 3:46 is where this upload's audio changes character
entirely (the same segment is labelled genre `rock_metal`, arousal 0.69, after
25 straight segments of `classical`), so pass 1 and pass 2 agree with each
other about something that is a property of the *upload* rather than of the
music; the one at 1:59 has nothing under it in the waveform but a phrase
beginning after a long rest.

**Picture:** the reactive spin does exactly what it is for here. `beatConf`
never gets far off the floor on unmetred solo piano and `arousal` averages 0.51,
so the base rate sits at a few thousandths of a radian and the field is, to the
eye, still — sheets folding in place rather than a frame that turns. Filaments
fire on the left-hand octaves. The two spurious drops each throw the field
outward and reverse it once, over a second and a half; with the new 4 s
reversal cooldown the pair at 1:53/1:59 is one reversal rather than two.

### Avicii — *Levels* (EDM with a known drop)

**Found:** 58 candidates, 7 `none`, 32 `key_change`, and the structure is
legible in the flourishing ones: `drop` 0:00 (0.96) and 0:07 (0.72),
`build_start` 0:23 and 0:54, `breakdown` 1:18 (0.65), `build_start` 1:35,
`breakdown` 1:42, `vocal_entry` 1:48, a cluster of four `build_start` at
2:18–2:23, `vocal_entry` 2:26, then `break_silence` 3:10 and 3:16 with a
`quiet_fall` between them.

**Against the ear:** the build at 2:18–2:23 into the final chorus is right, and
finding it four times in five seconds is the detector proposing four candidates
inside one riser rather than the model being wrong about any of them. The
breakdown at 1:18 and the drop back in are where they belong. The two `drop`s
in the first eight seconds are the track's cold open, which is a slam — the ear
agrees. Nothing named a drop at the famous 1:00 lift, which the ear does hear;
the detector proposed no candidate there, so pass 2 was never asked.

**Picture:** genre `electronic_dance` on 18 of 20 segments, mean arousal 0.69,
mean hypnotic 0.48. This is the track the climax discipline was tuned against —
see the numbers in the task report. The drop frame is a white core with radial
streaks and the blacks survive it; a second later the field is back to a mean
of 0.31 with a fifth of it under 0.05.

### Travis Scott — *SICKO MODE* (trap)

**Found:** 60 candidates, 4 `none`, **8 `drop`**, 21 `tempo_change`, 11
`key_change`, 4 `vocal_entry`, 4 `build_start`, 3 `break_silence`, 3
`quiet_fall`, 2 `breakdown`. The flourishing ones line up with the track's
three-part structure: `drop` 0:00 (0.95), `vocal_entry` 0:28 (0.82) — Drake's
entry — `break_silence` 1:20 and `drop` 1:23 (0.84) at the first beat switch,
`build_start` 1:55, `breakdown` 2:19, `break_silence` 2:40 into `drop` 2:41
(0.66) at the second switch.

**Against the ear:** this is the best agreement of the six. The two beat
switches are the two things a listener would name, and both are found within a
second, each as a hole followed by a slam. 21 `tempo_change` is over-eager —
the three sections really are three tempos, but not twenty-one.

**Picture:** the biggest `pushOut` bursts of the six, and the spin's per-bar
sign alternation on `pulse` motion reads clearly at the switches: the field
rocks rather than winding up. Genre splits pop/electronic_dance, which puts the
dust on the cold accent rather than on embers.

### Slipknot — *Duality* (metal with screams)

**Found:** 60 candidates, 6 `none`, 29 `tempo_change`, 13 `key_change`, and —
**no `scream_peak` at all.** The flourishing moments are `drop` 0:01 (0.97),
`vocal_entry` 0:03, `breakdown` 1:25, `drop` 1:34 (0.75), `build_start` 2:50,
`breakdown` 3:01, and six `break_silence` in eight seconds at 3:26–3:33.

**Against the ear:** the two drops are right — the cold open and the chorus
return. The six `break_silence` at 3:26 are the breakdown's stop-start riff and
the detector proposing a candidate at each stop, which is arguably six holes;
the ear hears one figure. And the missing `scream_peak` is a genuine gap: the
track is continuous screaming, the harshness reading is high throughout, and a
rubric that fires on a *peak* has nothing to peak against. The Task 12 scream
rubric was calibrated on a scream inside a sung passage.

**Picture:** genre came back `electronic_dance` on 9 of 19 segments and `pop` on
6, with `classical` on 3. That is plainly wrong and it costs the relief terrain
its genre bonus, so the frame is smoke and silk where the direction wants rock.
Aggression does still raise the terrain on its own, so it is a weaker picture
rather than a wrong one.

### Brian Eno — *An Ending (Ascent)* (ambient)

**Found:** 60 candidates, 2 `none`, 36 `key_change`, 10 `tempo_change`, and
three `drop`s (0:01 at 0.75, 2:21 at 0.74, 3:48 at 0.50) plus three
`breakdown`s and two `quiet_fall` near the end.

**Against the ear:** there are no drops in this piece and no tempo at all. The
`key_change` flood is the chord pad's slow movement, which is fair; the drops
are swells being read as slams. The two `quiet_fall` at 4:09 and 4:14 (both
confidence ≈ 0.78) are the actual fade, and they are the most useful thing pass
2 found here.

**Picture:** the best demonstration of the new spin drive. `beatConf` is near
zero on a beatless pad, so the base rate is the 0.004 rad/s drift and the
picture is a still field of slowly folding sheets — which is what an ambient
piece should look like and is exactly what the old `0.18·(0.4 + arousal)` could
not do. The three spurious drops are the only motion in four minutes, and the
reversal cooldown holds them to one gesture each.

### Richard St. John — *Secrets of success* (speech)

**Found:** 60 candidates, 0 `none`, **9 `drop`** (several over 0.9), 5
`breakdown`, 4 `break_silence`, 22 `tempo_change`, 19 `key_change`.

**Against the ear:** this is the worst result of the six and the most useful.
There is no drop in a TED talk. What the detector is finding is applause and
laughter — loud, broadband, sudden, after a hole — and pass 2 has no way to say
"that is a room, not a record". Worse, **pass 1 reported a mean `spoken` of
0.13 across 28 segments**, with genres spread over electronic_dance (11),
classical (7) and rock_metal (7). A talk that reads as `spoken: 0.13` never
engages the breath scene, never engages the speech safety, and is drawn as if
it were music.

**Picture:** consequently, a talk gets the full smoke treatment. The one thing
that does work is the spin: `(1 − spoken)` cannot help at 0.13, but `beatConf`
and `regular` are both low on speech, so the base rate still lands near the
drift and the field does not turn under the voice. Without the reversal
cooldown the fourteen drop/breakdown seams would have flipped it every few
seconds; with it, at most one flip per four seconds.

## What moved as a result

1. **A cooldown on the flow reversal** (`REVERSE_COOLDOWN_SEC = 4` in
   `director.ts`). Found by the talk and the Eno: a reversal is the largest
   gesture the picture has, and "one already in flight" is a lock that lets go
   the instant the gesture ends, not a cooldown.
2. **The spin drive** was already reactive by the time these ran, and the
   classical, ambient and speech tracks are the evidence that it is the right
   shape: all three sit at the drift, and the two that have a beat turn.
3. Nothing else was changed *by* the real-track pass. The idle and climax
   knobs were tuned against the measurement harness before it; these six were
   the check that the knobs describe real music and not a synthetic build.

## What these tracks say about the analysis, which is not a knob

Recorded rather than fixed — the brief for this pass allows Director, smoke and
strand knobs only, and every item below is a rubric or a detector.

- **`spoken` is far too low on real speech** (0.13 mean on a TED talk). This is
  the single highest-value fix left: the breath scene and the whole speech
  safety hang off it.
- **`scream_peak` never fires on continuous screaming.** The rubric looks for a
  peak, and a track that is all peak has none.
- **Genre is unreliable outside dance music** — metal read as electronic_dance,
  ambient read as electronic_dance. It feeds the relief bonus and the grain
  colour, so the cost is a weaker picture rather than a wrong one.
- **Pass 2 almost never says `none`** (0–7 out of ~60). Either the candidate
  detector is well aimed or the verdict has no strong "nothing happened" prior;
  the talk's nine drops suggest the latter.
- **The candidate cap of 60 binds on five of six tracks**, so a long track's
  later moments compete with its earlier ones for the same sixty slots.

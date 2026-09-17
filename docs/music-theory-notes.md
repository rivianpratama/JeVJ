# Music theory applied in JeVJ

This file records the theory JeVJ leans on, the feature each idea becomes, and the Jev question or visual rule it feeds. Sources: Open Music Theory (scales, meter), Juslin & Västfjäll / Wikipedia "Music and emotion" feature→affect table, Krumhansl–Kessler key profiles (via rnhart.net), Plomp–Levelt sensory dissonance, Italian tempo markings, syncopation, timbre correlates, musical form.

## 1. Mode and key → valence prior

- Major (Ionian) is heard as bright/happy; minor (Aeolian) as sad/serious. Consistent finding since Hevner (1935).
- Other diatonic modes carry flavor: Dorian = minor but hopeful (raised 6th), Phrygian = dark/tense/Spanish (♭2), Lydian = floating/dreamy (♯4), Mixolydian = major but bluesy/relaxed (♭7), Locrian = unstable (♭5).
- **Feature:** chroma accumulated over ~8 s → Krumhansl–Kessler correlation over 24 keys.
  - Major profile: `6.35 2.23 3.48 2.33 4.38 4.09 2.52 5.19 2.39 3.66 2.29 2.88`
  - Minor profile: `6.33 2.68 3.52 5.38 2.60 3.53 2.54 4.75 3.98 2.69 3.34 3.17`
  - `modeConf` = margin between best-major and best-minor correlations, squashed to 0–1.
  - Modal flavor: compare the 7 strongest pitch classes against mode templates (pitch-class sets from tonic): Ionian `0 2 4 5 7 9 11`, Dorian `0 2 3 5 7 9 10`, Phrygian `0 1 3 5 7 8 10`, Lydian `0 2 4 6 7 9 11`, Mixolydian `0 2 4 5 7 9 10`, Aeolian `0 2 3 5 7 8 10`, Locrian `0 1 3 5 6 8 10`.
- **Jev:** `key`, `mode`, `modeConf`, `modal` fields; the model turns these into `valence`, `melancholy`, `tension`.
- **Visual:** valence → palette saturation & lightness; minor + slow → desaturated cold ramps.

## 2. Tempo and meter → arousal, motion

- Italian markings (BPM): Largo <66, Adagio 66–76, Andante 76–108, Moderato 108–120, Allegro 120–156, Vivace 156–176, Presto >176.
- Genre anchors: hip-hop/trap 70–100 (half-time feel), house 120–130, trance 135–145, dubstep 140 half-time, DnB 160–180, waltz ~90 in 3.
- Fast tempo raises arousal and valence; slow tempo lowers arousal. Duple vs triple meter changes the "sway" (triple reads as circular/lilting).
- **Feature:** onset envelope autocorrelation → `bpm`, `beatConf`; 2× vs 3× period autocorrelation → `meter`.
- **Jev:** `bpm`, `tempo` (marking word), `beatConf`, `meter`.
- **Visual:** beat grid pulses; triple meter uses a 3-lobed orbit for ink injection.

## 3. Dynamics → arousal, form

- pp…ff are relative to the piece. Classical has wide dynamic range; pop/EDM is compressed (small loudness range, high crest-consistency).
- Crescendo (building) precedes climaxes; terraced dynamics (sudden steps) mark section changes; sforzando/accents = onsets.
- **Feature:** `loud` (pp/p/mp/mf/f/ff relative to session running range), `range` (loudness range over window, 0 compressed … 1 wide), `trend` (building/fading/steady), `crest`.
- **Jev:** `arousal`, `section`, `drop_imminent`, `impact`.
- **Visual:** wide range → visuals allowed to go nearly black between phrases; compressed → constant glow floor.

## 4. Consonance / dissonance → tension

- Consonant: unison, octave, P5, P4 (perfect); thirds & sixths (imperfect). Dissonant: m2/M7, M2/m7, tritone. Dissonance = tension demanding resolution.
- Sensory roughness (Plomp–Levelt): partials within a critical band beat at 20–150 Hz → roughness.
- **Feature:** `consonance` from chroma pair energies weighted by interval-class dissonance: ic1 1.0, ic2 0.6, ic3 0.2, ic4 0.15, ic5 0.05, ic6 0.9. `consonance = 1 − Σ c_i c_j w(ic) / Σ c_i c_j` over i<j.
- **Jev:** `tension`, `aggression`.
- **Visual:** tension → mirror fold count, strand bending, feedback turbulence.

## 5. Rhythm: syncopation, regularity → groove, energy

- Syncopation = accents displaced off the strong beats; backbeat (2 & 4) in rock/pop; anticipated bass in Latin; all dance music uses it.
- Regularity (isochronous onsets) reads as mechanical/driving; irregular reads as free/rubato.
- **Feature:** `sync` = onset energy at phases 0.25/0.5/0.75 vs on-beat; `regular` = 1 − normalized variance of inter-onset intervals.
- **Jev:** `motion` (pulse vs flow), `synthetic`, `genre`.

## 6. Timbre → warmth, synthetic, aggression

- Brightness ↔ spectral centroid; noisiness ↔ spectral flatness; roughness ↔ spectral irregularity/transients; fullness ↔ low harmonics.
- Staccato = tense/energetic/surprising; legato = calm/sad/cohesive. Attack sharpness is the correlate.
- **Feature:** `bright`, `noise`, `attack` (sharp/soft/mixed from onset rise slope), `sub` (20–60 Hz share), `bands` (8 log bands 0–9).
- **Jev:** `warmth`, `synthetic`, `aggression`, `space`.
- **Visual:** brightness → bloom threshold; noise → film grain; sub → camera breathing and feedback push.

## 7. Form: build, drop, breakdown

- Sections are perceived from changes in energy, texture, instrumentation, harmony. EDM phrases run 8/16/32 bars; the drop lands on the downbeat of a phrase boundary, usually preceded by a riser (rising centroid), snare roll (onset density doubling), and often a one-beat gap.
- **Feature:** `slope4`, `slope8` (loudness change over last 4/8 bars), `onsetRatio`, `centroidSlope`, `gap`, `barsSinceChange`, `barInPhrase`.
- **Jev:** `section`, `drop_imminent`, `beats_to_change`, `impact`, `pre_drop_style`.
- **Timeline:** predicted cues snap to the beat grid; the local detector confirms the hit within one analyser hop.

## 8. Speech vs music

- Speech has 3–6 Hz syllabic amplitude modulation, weak tempo periodicity, centroid 1–3 kHz, pauses.
- **Feature:** `speech` 0–1 from envelope modulation ratio, low beat confidence, mid centroid, ZCR variance.
- **Jev:** `spoken` Noul; `genre = spoken`.
- **Visual:** Breath scene, no strobing, near-monochrome.

## 9. Emotion model used for the mood vector

Russell's circumplex (valence × arousal) extended with tension, warmth, space, and organic↔synthetic axes, plus discrete Nouls (aggression, melancholy, hypnotic, euphoric peak, spoken). Feature→affect anchors from Juslin: fast/loud/bright/staccato/major → high-arousal positive; slow/soft/dark/legato/minor → low-arousal negative; dissonant/loud/irregular → anger/fear; consonant/soft/slow → tenderness/calm.

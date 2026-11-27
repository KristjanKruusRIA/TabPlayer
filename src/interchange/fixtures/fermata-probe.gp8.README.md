# Guitar Pro 8 fermata probe exports (THE-60)

`fermata-probe-120.gp8.mid` and `fermata-probe-60.gp8.mid` are the Standard MIDI Files that Guitar Pro 8 (an activated copy) exported on 2026-11-12 from two Guitar Pro files authored by `scripts/fermata-probe.mjs` (`write`) in this repository. They are our own synthetic material, not third-party scores. Each is about 1.7 KB.

- Source layout: `fermata-probe.layout.json` beside them, the `probe-layout.json` written with those two `.gp` files: 27 bars of 4/4, 13 fermata cases (Short, Medium and Long; Length 0, 0.5, 1 and 2; on a note, a rest, a half note and an eighth note), each followed by a control bar. Two tracks: a "fermata track" (107 notes) and a "sustain track" (69 notes). The files differ only in tempo, 120 and 60 BPM.
- Guitar Pro 8 exported every note at MIDI key 0, although the probe wrote each pitch three ways (octave and tone, and a MIDI number). The cause is not established. The probe's notes had no string or fret and its staff no tuning, which is one possible cause; the pitched-note form alphaTab writes may be another. The analyser therefore matches these files by track and note count, not by key. The probe has since been changed to write stringed notes on a standard-tuned guitar staff; these two exports were made from the earlier version and were not redone.
- What they show: the notes sit exactly on the written grid with exactly the written lengths, there is one tempo event per file, and the 120 and 60 BPM files are identical in ticks. The MIDI Guitar Pro 8 exported from this probe contains no hold for any fermata type or length tried. It is not established that Guitar Pro read the fermatas: there is no fermata placed by Guitar Pro itself in the same export to compare with.
- Limit: nobody confirmed that the fermata symbols were visible in Guitar Pro when the files were opened, so "no hold in the export" cannot be told apart from "Guitar Pro did not read the fermatas". This says nothing about how Guitar Pro plays a fermata back, only what its MIDI export contains.

Pinned by `src/interchange/gp8-fermata-midi.test.ts`.

## Visible fermatas and a Guitar Pro control, 26 November 2026

On Windows, Guitar Pro 8.0.0 build 18 displayed the short, medium and long fermatas from the current stringed probe. At 120 BPM a medium fermata was also added in Guitar Pro to the first note of the plain lead-in bar. The saved score, `fermata-visible-120.gp8.gp`, contains 14 fermatas. The new one has offset 0/1 and length 0.5. At 60 BPM the generated probe was exported without edits.

`fermata-visible-60.gp8.mid` and `fermata-visible-120.gp8.mid` are the resulting File → Export → MIDI files. Both contain the expected pitches, onsets and releases on both tracks and a single initial tempo. This includes the first note with the hand-authored fermata.

### Soundbank audio from Guitar Pro 8.0.0 build 18

Guitar Pro's WAV renderer stretches the marked beat. To reproduce, run `node scripts/fermata-probe.mjs write-audio`, open the five resulting scores in Guitar Pro 8 and use File → Export → Audio → WAV. Export the whole score. Turn off per-track files, metronome, count-in and normalization. The inputs use the piano soundbank already specified in the saved GP8 file. The original tracks selected MIDI playback, which disabled Audio export. The paired control at each tempo differs from its marked score only by removal of the fourteen fermatas.

| WAV | Stereo PCM frames at 44,100 Hz | Duration |
| --- | ---: | ---: |
| 120 BPM control | 2,381,400 | 54.000000 s |
| 120 BPM with marks | 10,468,774 | 237.387166 s |
| 60 BPM control | 4,762,800 | 108.000000 s |
| 60 BPM with marks | 12,999,549 | 294.774354 s |
| 90 BPM with fourteen new length settings | 10,568,458 | 239.647574 s |

Measured against the following downbeat, a marked quarter at 120 BPM added about 0.26 s for stored length 0, 0.60 s for 0.5, 1.50 s for 1, and 59.50 s for 2. At 60 BPM those delays were approximately 0.52, 1.20, 3.00 and 59.00 s. Short, Medium and Long gave the same timing where tested at equal lengths. The rest delayed the following note. With length 0 the half-note delay was twice the quarter-note delay and the eighth-note delay was half. The hand-entered mark on the first beat matched the other length-0.5 quarter.

An empirical model for the marked interval is `effectiveBpm = max(1, tempoBpm * (0.66 - 0.41 * storedLength))`, applied for the marked written duration. At length 2 a quarter therefore takes 60 seconds total at either test tempo. Before rendering the 90 BPM score, this model predicted **239.647443 s**. The measured render differed by 0.000131 s. All 27 bar starts were identified from the lead piano's C5 attack. Individual marked-bar durations on the 90 BPM render matched within 25 ms using a 50 ms spectral window and 5 ms hop. These probes use fixed tempi and aligned 4/4 bars. Handling simultaneous unequal beat lengths, changes of tempo within a hold, and exact note releases on the sustaining track still needs independent verification. Real-time device playback was not recorded.

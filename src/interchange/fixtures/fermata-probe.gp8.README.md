# Guitar Pro 8 fermata probe exports (THE-60)

`fermata-probe-120.gp8.mid` and `fermata-probe-60.gp8.mid` are the Standard MIDI Files that Guitar Pro 8 (an activated copy) exported on 2026-11-12 from two Guitar Pro files authored by `scripts/fermata-probe.mjs` (`write`) in this repository. They are our own synthetic material, not third-party scores. Each is about 1.7 KB.

- Source layout: `fermata-probe.layout.json` beside them, the `probe-layout.json` written with those two `.gp` files: 27 bars of 4/4, 13 fermata cases (Short, Medium and Long; Length 0, 0.5, 1 and 2; on a note, a rest, a half note and an eighth note), each followed by a control bar. Two tracks: a "fermata track" (107 notes) and a "sustain track" (69 notes). The files differ only in tempo, 120 and 60 BPM.
- Defect in that probe: its notes were bare pitched notes (octave and tone, no string or fret) on a staff with no tuning. Guitar Pro 8 exported every note at MIDI key 0. The analyser therefore matches these files by track and note count, not by key. The probe has since been changed to write stringed notes on a standard-tuned guitar staff; these two exports were made from the earlier version and were not redone.
- What they show: the notes sit exactly on the written grid with exactly the written lengths, there is one tempo event per file, and the 120 and 60 BPM files are identical in ticks. Guitar Pro 8's MIDI export applies no hold for any fermata type or length tried.
- Limit: nobody confirmed that the fermata symbols were visible in Guitar Pro when the files were opened, so "no hold in the export" cannot be told apart from "Guitar Pro did not read the fermatas". This says nothing about how Guitar Pro plays a fermata back, only what its MIDI export contains.

Pinned by `src/interchange/gp8-fermata-midi.test.ts`.

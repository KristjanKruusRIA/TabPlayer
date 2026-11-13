# Guitar Pro 8 acceptance matrix kit (THE-61)

**Nothing has been run in Guitar Pro 8.** The kit was written and tested here only against its own synthetic "returned" files. No Guitar Pro 8 was available or activated. Every statement below about what Guitar Pro will do is a question, not a result.

Tracker rows (`docs/validation/2026-10-15-gp8-parity-progress.md`):

- **F26**: open, export and reopen all authored feature fixtures in the supplied target without data loss. Open: no executed original-GP8 feature matrix.
- **F27**: field-level fixtures for every matrix field. Open: synthetic scores only, no proof of interoperability with original Guitar Pro 8.

## What the kit is

`scripts/gp8-acceptance-kit.mjs`, with two commands.

```powershell
node scripts/gp8-acceptance-kit.mjs write            # into .analysis/gp8-acceptance/ (git-ignored)
node scripts/gp8-acceptance-kit.mjs write C:\gp8kit  # or any folder
node scripts/gp8-acceptance-kit.mjs collect C:\gp8kit
```

`write` makes 13 small `.gp` files, one per feature family, a `checklist.md` generated from the same data, and `kit-manifest.json` (file hashes, expected MIDI note counts and onsets, the elements to compare). Every bar carries a section label `family: case`, so the bar names itself in Guitar Pro.

| File | Family | Cases (one bar each) |
|---|---|---|
| `01-structure` | meter, free time, triplet feel, tempo, key | 3/4, 6/8, common time, cut time, double bar, free time, triplet feel 8th, tempo 90, key 3 sharps, key 2 flats minor |
| `02-repeats` | repeats and jumps | repeat start, end repeat x3 with ending 1, ending 2, segno, coda, D.S. al Coda |
| `03-fermata` | fermatas the kit writes | Short/0, Medium/0, Long/1 |
| `04-fermata-control` | positive control, no fermata written | four plain bars; you add one by hand |
| `05-dynamics` | dynamics, crescendo, fade, text, lyrics | pp, ff, crescendo, fade in, text "Solo", lyric syllables |
| `06-bends` | bends and whammy | bend, bend and release, pre-bend, pre-bend and release, whammy dive, dip |
| `07-links` | ties, hammer-on, slides | tie, hammer-on, shift, legato, slide in from below, slide out down |
| `08-note-marks` | muting, ghost, dead, accents, vibrato, fingering | palm mute, let ring, dead, ghost, staccato, accent normal and heavy, vibrato, left-hand tap, fingering |
| `09-harmonics-ornaments` | harmonics, trill, ornament | natural, artificial, pinch, tap, semi, feedback, trill, turn |
| `10-strokes-gestures` | strokes and gestures | brush down, arpeggio up, pick stroke up and down, tremolo picking 1 and 3 marks, rasgueado, slap, pop, tap, wah, barre, timer |
| `11-rhythm` | dots, tuplets, octave mark | dotted eighth plus sixteenth, triplet, quintuplet, sixteenths, 8va |
| `12-tracks-tuning` | tracks, tuning, capo, mixer | two tracks: "Capo 3" and "Drop D" with colour, volume, pan, program |
| `13-chord-diagram` | chord diagram | chord "C" |

Files are written with alphaTab's public Guitar Pro 7/8 writer, with stringed notes on a standard-tuned guitar staff so Guitar Pro reads pitches (the cause of the earlier all-key-0 export is not established; this is the fix the probe already tried). Fermatas are patched into `score.gpif` by hand, the way `scripts/fermata-probe.mjs` does. The kit does not use TabPlayer's own exporter: it is TypeScript with extensionless imports and plain Node cannot load it (the same limit as the fermata probe).

## Steps for the person with an activated Guitar Pro 8

1. Run `write`. Open `checklist.md`.
2. Before the first export, find any count-in, metronome click or extra-repeat option that affects MIDI export and switch it off. Write down the Guitar Pro version and build and the export options you chose. Use the same options for every file.
3. For each file, in order: open it; note any warning on opening; look at what the checklist names for that file; File, Save as `.gp` under the `.saved.gp` name shown; File, Export, MIDI under the `.mid` name shown; close without saving again. Write down anything missing or different, with the bar number.
4. For `04-fermata-control`, do the separate fermata steps in the checklist: add one fermata by hand to the first beat of bar 2, save, export MIDI, and note the type and length you chose. If the MIDI dialog has an option that changes tempo, repeat or fermata handling, export a second time with the other setting as `04-fermata-control-alt.mid` and note which option.
5. Run `collect <folder>`. It writes `results.md` and `results.json` in the folder.

Do not edit or overwrite the files the kit wrote. A file Guitar Pro will not open is a result: note the exact message and skip that file's save and export.

## What `collect` compares

For each family, the XML of `Content/score.gpif` in the file the kit wrote against the same part of the file Guitar Pro saved. It compares **only the named elements**, as the text of each element (tag, attributes except `id`, text, children), as a set. It reports per element:

- **same**: the same set of elements in both files;
- **ABSENT**: written, none in the Guitar Pro file;
- **CHANGED**: both present but different (the first difference is shown);
- **added**: none written, some in the Guitar Pro file;
- **not in either file**.

The elements compared, by family:

| Family | Elements |
|---|---|
| structure | `MasterBar>Time`, `>Key`, `>DoubleBar`, `>FreeTime`, `>TripletFeel`, `>Section`; `Automation` |
| repeats | `MasterBar>Repeat`, `>AlternateEndings`, `>Section`; `Directions>Target`, `Directions>Jump` |
| fermata, fermata-control | `Fermata`, `Fermata>Type`, `>Length`, `>Offset` |
| dynamics | `Beat>Dynamic`, `Hairpin`, `Fadding`, `FreeText`, `Lyrics>Line` |
| bends | `Property[name=Bended]`, `BendOriginValue`, `BendOriginOffset`, `BendMiddleValue`, `BendMiddleOffset1`, `BendMiddleOffset2`, `BendDestinationValue`, `BendDestinationOffset`; `Whammy` |
| links | `Tie`, `Property[HopoOrigin]`, `Property[HopoDestination]`, `Property[Slide]` |
| note-marks | `Property[PalmMuted]`, `Property[Muted]`, `Property[LeftHandTapped]`, `LetRing`, `AntiAccent`, `Accent`, `Vibrato`, `LeftFingering`, `RightFingering` |
| harmonics-ornaments | `Property[HarmonicType]`, `Property[HarmonicFret]`, `Trill`, `Ornament` |
| strokes-gestures | `Property[Brush]`, `Arpeggio`, `XProperty`, `Property[PickStroke]`, `Tremolo`, `Property[Rasgueado]`, `Property[Slapped]`, `Property[Popped]`, `Property[Tapped]`, `Wah`, `Property[BarreFret]`, `Property[BarreString]`, `Timer` |
| rhythm | `Rhythm`, `Rhythm>NoteValue`, `>AugmentationDot`, `>PrimaryTuplet`; `Ottavia` |
| tracks-tuning | `Track>Name`, `>ShortName`, `>Color`; `Property[CapoFret]`, `Property[Tuning]`, `Program`, `ChannelStrip>Parameters` |
| chord-diagram | `Item`, `Diagram`, `Chord` |

For MIDI it reports the note count against the kit's expected count, the distinct note-on times against the expected beat starts (within 0.02 quarter), the last note end, the first tempo and tempo-event count, and whether every note is at key 0. It does not compare pitch.

### What it cannot say

- A **same** result means the element text matched. It does not mean Guitar Pro displays or plays it as written.
- An **ABSENT** or **CHANGED** result may be Guitar Pro writing the same thing under a different element name or in another file inside the archive. The comparison cannot tell a lost feature from a renamed one. Your notes from looking at the score in Guitar Pro are what settle it.
- Several things are not compared: the common and cut time symbol (not an element in `score.gpif`), staff display flags such as slash and numbered staves (no matching element appeared in the written file), slurs (the writer wrote none that the comparison could see, so that case was left out), `Content/score.gpss` and other archive members, and anything the kit does not author: TabPlayer's private `TabPlayerCurves` property, partial capo, harmony carriers, backing audio, custom bar widths and password locks. The five fields F27 lists as kept in `TabPlayerCurves` therefore remain untested against Guitar Pro 8 by this kit.
- MIDI timing is **not judged** for the repeat and fermata families: Guitar Pro expands repeats in a MIDI export, and a fermata may lengthen playback. Trills, tremolo picking, brushes and grace notes can add or move note starts in the other families without being faults.
- For the fermata control, `collect` prints how Guitar Pro wrote the fermata, the seconds the last note ends after nominal, tempo events, and the per-bar start shift. It draws no conclusion. One fermata of one type and length answers only that case.
- It reads a returned `.gp` only if it is a zip archive with `Content/score.gpif` (at most 64 MB archive, 48 MB for the XML, XML nesting at most 256, at most 2 million elements). A `.gpx` is not read. MIDI files over 8 MiB are not read. Unreadable files are reported and the rest are still compared.

## How results get recorded

1. Keep the folder (it is git-ignored; do not commit Guitar Pro output or any file you did not author).
2. Write `docs/validation/YYYY-MM-DD-gp8-acceptance-run.md` with: Guitar Pro version and build, the machine, the export options you chose, the date, and who ran it. Paste the per-family tables from `results.md`, your own notes per file (what you saw in Guitar Pro, bar by bar), and for the fermata control the numbers and the type and length you added.
3. State plainly which families were run, which were not, and every case where your notes and `results.md` disagree.
4. Do not change tracker rows F26 or F27 from this document. They change only after a reviewer reads the recorded run. Even a full run covers only what the 13 files author; F27's "every matrix field" and F26's "all authored feature fixtures" need the gaps listed above closed or accounted for.

## Related evidence

- `docs/validation/2026-10-31-gp8-field-matrix.md` and `2026-10-31-gp8-kept-fields.md`: the synthetic field matrix and the fields kept in `TabPlayerCurves`.
- `docs/validation/2026-11-12-gp8-export-losses.md`: known losses and the warning text.
- `docs/validation/2026-11-12-gp8-golpe-sound-fermata-probe.md` and `scripts/fermata-probe.mjs`: the fermata hold probe. The fermata control here is the step that note says would settle the open caveats.

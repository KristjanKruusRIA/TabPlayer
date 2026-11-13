# Guitar Pro 8 acceptance matrix kit (THE-61)

**Nothing has been run in Guitar Pro 8.** The kit was written and tested here only against its own synthetic "returned" files. No Guitar Pro 8 was available or activated. Every statement below about what Guitar Pro will do is a question, not a result.

Tracker rows (`docs/validation/2026-10-15-gp8-parity-progress.md`):

- **F26**: open, export and reopen all authored feature fixtures in the supplied target without data loss. Open: no executed original-GP8 feature matrix.
- **F27**: field-level fixtures for every matrix field. Open: synthetic scores only, no proof of interoperability with original Guitar Pro 8.

## What the kit is

The files are written by **TabPlayer's own exporter** (`exportGpInterchange`), so each carries what that exporter adds to alphaTab's output: fermatas, beam direction, chord diagrams, lyrics, percussion references, channel-strip automations, tempo units, the common/cut stylesheet flag, the private `TabPlayerCurves` property and the partial capo. A plain Node script cannot load that TypeScript, so the builder lives in `src/interchange/gp8-acceptance-families.ts` and runs under Vitest.

```powershell
node scripts/gp8-acceptance-kit.mjs write            # into .analysis/gp8-acceptance/ (git-ignored)
node scripts/gp8-acceptance-kit.mjs write C:\gp8kit  # or any folder
node scripts/gp8-acceptance-kit.mjs collect C:\gp8kit
```

`write` runs `vitest run src/interchange/gp8-acceptance-kit-write.test.ts` with `GP8_KIT_OUT` set. That test is skipped unless the variable is set, so the normal suite writes nothing. It writes the `.gp` files and `kit-manifest.json` (hashes, expected MIDI note counts and onsets, the elements to compare, TabPlayer's export warning for each file). The script then writes `checklist.md` from the manifest. Every bar carries a section label `family: case`.

The regular test (`src/interchange/gp8-acceptance-kit.test.ts`) builds every file in memory and checks that each contains the elements the checklist names, by reading its `score.gpif`.

| File | Family | Cases (one bar each) | Compared after Guitar Pro saves |
|---|---|---|---|
| `01-structure` | meter, free time, triplet feel, tempo, key | 3/4, 6/8, 2/2, double bar, free time, triplet feel 8th, tempo 90, key 3 sharps, key 2 flats minor | `MasterBar>Time`, `>Key`, `>DoubleBar`, `>FreeTime`, `>TripletFeel`, `>Section`; `Automation` |
| `02-repeats` | repeats and jumps | repeat start, end repeat x3 with ending 1, ending 2, segno, coda, D.S. al Coda | `MasterBar>Repeat`, `>AlternateEndings`, `>Section`; `Directions>Target`, `Directions>Jump` |
| `03-fermata` | fermatas through the app's writer | Short/0, Medium/0, Long/1 | `Fermata`, `Fermata>Type`, `>Length`, `>Offset` |
| `04-fermata-control` | positive control, no fermata written | four plain bars; you add one by hand | the same four, expected absent in the written file |
| `05-dynamics` | dynamics, crescendo, fade, text | pp, ff, crescendo, fade in, text "Solo" | `Beat>Dynamic`, `Hairpin`, `Fadding`, `FreeText` |
| `06-bends` | bends and whammy | bend, bend and release, pre-bend, pre-bend and release, dive, dip | `Property[Bended]`, `BendOriginValue`, `BendOriginOffset`, `BendMiddleValue`, `BendMiddleOffset1`, `BendMiddleOffset2`, `BendDestinationValue`, `BendDestinationOffset`; `Whammy` |
| `07-links` | ties, hammer-on, slides | tie, hammer-on, shift, legato, slide in from below, slide out down | `Tie`, `Property[HopoOrigin]`, `Property[HopoDestination]`, `Property[Slide]` |
| `08-note-marks` | muting, ghost, dead, accents, vibrato, fingering | palm mute, let ring, dead, ghost, staccato, accent normal and heavy, vibrato, left-hand tap, fingering | `Property[PalmMuted]`, `Property[Muted]`, `Property[LeftHandTapped]`, `LetRing`, `AntiAccent`, `Accent`, `Vibrato`, `LeftFingering`, `RightFingering` |
| `09-harmonics-ornaments` | harmonics, trill, ornament | natural, artificial, pinch, tap, semi, feedback, trill, turn | `Property[HarmonicType]`, `Property[HarmonicFret]`, `Trill`, `Ornament` |
| `10-strokes-gestures` | strokes and gestures | brush down, arpeggio up, pick stroke up and down, tremolo picking 1 and 3 marks, rasgueado, slap, pop, tap, wah, barre, timer | `Property[Brush]`, `Arpeggio`, `XProperty`, `Property[PickStroke]`, `Tremolo`, `Property[Rasgueado]`, `Property[Slapped]`, `Property[Popped]`, `Property[Tapped]`, `Wah`, `Property[BarreFret]`, `Property[BarreString]`, `Timer` |
| `11-rhythm` | dots, tuplets, octave mark, beam direction | dotted eighth plus sixteenth, triplet, quintuplet, sixteenths, 8va, beam direction inverted | `Rhythm`, `Rhythm>NoteValue`, `>AugmentationDot`, `>PrimaryTuplet`; `Ottavia`; `XProperty` |
| `12-tracks-tuning` | tracks, tuning, capo, mixer | "Capo 3" and "Drop D" with colour, volume, pan, program | `Track>Name`, `>ShortName`, `>Color`; `Property[CapoFret]`, `Property[Tuning]`, `Program`, `ChannelStrip>Parameters` |
| `13-chord-diagram` | chord diagrams with theory and fingering data | C/E from a theory recipe, F barre with fingering, Am with the name hidden | `Item`, `Diagram`, `Diagram>Fret`, `Fingering`, `Diagram>Property`, `Chord` |
| `14-lyrics-verses` | lyrics, three verses | verses starting in bars 1, 1 and 3 | `Lyrics>Line`, `Line>Text`, `Line>Offset` |
| `15-percussion` | percussion track | guitar plus a drum track, four drum pieces per bar | `Articulations>Articulation`, `Note>InstrumentArticulation`, `Track>Name` |
| `16-mix-automation` | volume and pan automation | volume change in bar 2, pan change in bar 3 | `ChannelStrip>Automations` |
| `17-tempo-unit` | tempo in a non-quarter note | 120 quarter, 80 dotted quarter, 60 half | `Automation` |
| `18-common-cut-uniform` | common and cut display, every bar the same | 4/4 and 2/2, all set to the symbol | archive members `Content/BinaryStylesheet` and `Content/Stylesheets/score.gpss` (byte for byte); `MasterBar>Time` |
| `19-common-cut-mixed` | common and cut display, mixed | symbol, numbers, symbol, numbers | the same three |
| `20-curves-private` | content only `TabPlayerCurves` holds | six-point bend, quick-style bend, gradual whammy dive, slur, buzz-roll tremolo, half-length note and hidden note | `Property[TabPlayerCurves]`, `Property[Bended]`, `Whammy`, `Tremolo` |
| `21-golpe` | golpe | thumb, finger | `Golpe` |
| `22-partial-capo` | partial capo | fret 2 on strings 1 to 3 | `Property[PartialCapoFret]`, `Property[PartialCapoStringFlags]` |

Selectors: `Tag`, `Parent>Tag` (direct parent), `Property[name]` (a `Property` element with that name attribute), and `@Archive/Member` for a whole archive member.

### What the export warning said

The checklist prints, for each file, the lines TabPlayer's own Guitar Pro export warning (`gpLosses`) gives for that score. In the run that wrote this document:

- `19-common-cut-mixed`: "2 bars set to the common/cut symbol will show numbers, because the Guitar Pro file holds one choice for the whole score (first at bar 1)". `18-common-cut-uniform` has no such line.
- `20-curves-private`: lines for the slur, the bend or whammy bar with more than four points, bends and whammy bars with a style, and the sounding length, each "written only for TabPlayer".
- `07-links`: "1 hammer-on or pull-off will not be linked to the same notes when this file is opened again (first at track 1, bar 2, beat 1)". I did not investigate why this hammer-on case triggers the warning; the warning is the app's own, and it is printed in the checklist as it is.

## Steps for the person with an activated Guitar Pro 8

1. Run `write`. Open `checklist.md`.
2. Before the first export, find any count-in, metronome click or extra-repeat option that affects MIDI export and switch it off. Write down the Guitar Pro version and build and the export options you chose. Use the same options for every file.
3. For each file, in order: open it; note any warning on opening; look at what the checklist names for that file; File, Save as `.gp` under the `.saved.gp` name shown; File, Export, MIDI under the `.mid` name shown; close without saving again. Write down anything missing or different, with the bar number.
4. For `04-fermata-control`, do the separate fermata steps in the checklist: add one fermata by hand to the first beat of bar 2, save, export MIDI, and note the type and length you chose. If the MIDI dialog has an option that changes tempo, repeat or fermata handling, export a second time with the other setting as `04-fermata-control-alt.mid` and note which option.
5. For `20-curves-private`, record how Guitar Pro shows each bar (the property is not expected to be read) and whether it keeps `TabPlayerCurves` when it saves.
6. Run `collect <folder>`. It writes `results.md` and `results.json` in the folder.

Do not edit or overwrite the files the kit wrote. A file Guitar Pro will not open is a result: note the exact message and skip that file's save and export.

## What `collect` compares

For each family, the XML of `Content/score.gpif` in the file the kit wrote against the same part of the file Guitar Pro saved, and the named archive members byte for byte. It compares **only the named elements**, as the text of each element (tag, attributes except `id`, text, children), as a set. It reports per element:

- **same**: the same set of elements in both files;
- **ABSENT**: written, none in the Guitar Pro file;
- **CHANGED**: both present but different (the first difference is shown);
- **added**: none written, some in the Guitar Pro file (this is how a member such as `Content/Stylesheets/score.gpss` shows where Guitar Pro keeps the common/cut flag);
- **not in either file**.

For MIDI it reports the note count against the kit's expected count, the distinct note-on times against the expected beat starts (within 0.02 quarter), the last note end, the first tempo and tempo-event count, and whether every note is at key 0. It does not compare pitch.

### What it cannot say

- A **same** result means the element text matched. It does not mean Guitar Pro displays or plays it as written.
- An **ABSENT** or **CHANGED** result may be Guitar Pro writing the same thing under a different element name or in another file inside the archive. The comparison cannot tell a lost feature from a renamed one. Your notes from looking at the score in Guitar Pro are what settle it.
- For common and cut time, TabPlayer writes the flag into `Content/BinaryStylesheet`; `Content/Stylesheets/score.gpss` is written only when the source file already had one, so these files do not have it. Whether Guitar Pro 8 reads the legacy member, and what it shows in each bar, is what the two common/cut files ask.
- Not covered: scale diagrams, backing audio, bar widths, password locks, staff display flags (slash and numbered staves), the Fine and Da Capo variants, anything in other archive members, and anything not listed above.
- MIDI timing is **not judged** for the repeat, fermata and control families: Guitar Pro expands repeats in a MIDI export, and a fermata may lengthen playback. Trills, tremolo picking, brushes and grace notes can add or move note starts in other families without being faults.
- For the fermata control, `collect` prints how Guitar Pro wrote the fermata, the seconds the last note ends after nominal, tempo events, and the per-bar start shift. It draws no conclusion. One fermata of one type and length answers only that case.
- It reads a returned `.gp` only if it is a zip archive with `Content/score.gpif` (at most 64 MB archive, 48 MB for the XML, XML nesting at most 256, at most 2 million elements; stylesheet members at most 2 MB). A `.gpx` is not read. MIDI files over 8 MiB are not read. Unreadable files are reported and the rest are still compared.

## How results get recorded

1. Keep the folder (it is git-ignored; do not commit Guitar Pro output or any file you did not author).
2. Write `docs/validation/YYYY-MM-DD-gp8-acceptance-run.md` with: Guitar Pro version and build, the machine, the export options you chose, the date, and who ran it. Paste the per-family tables from `results.md`, your own notes per file (what you saw in Guitar Pro, bar by bar), and for the fermata control the numbers and the type and length you added.
3. State plainly which families were run, which were not, and every case where your notes and `results.md` disagree.
4. Do not change tracker rows F26 or F27 from this document. They change only after a reviewer reads the recorded run. Even a full run covers only what the 22 files author.

## Related evidence

- `docs/validation/2026-10-31-gp8-field-matrix.md` and `2026-10-31-gp8-kept-fields.md`: the synthetic field matrix and the fields kept in `TabPlayerCurves`.
- `docs/validation/2026-11-12-gp8-export-losses.md`: known losses and the warning text.
- `docs/validation/2026-11-12-gp8-golpe-sound-fermata-probe.md` and `scripts/fermata-probe.mjs`: the fermata hold probe. The fermata control here is the step that note says would settle the open caveats.

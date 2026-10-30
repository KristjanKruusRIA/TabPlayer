# GP8 parity: Guitar Pro 5 export (F10)

## Brief

Row F10, "GP5 and GP6/GPX export". alphaTab 1.8 ships a Guitar Pro 7 exporter (`Gp7Exporter`) and no writer for Guitar Pro 3-5 (`.gp3`-`.gp5`) or Guitar Pro 6 (`.gpx`). The product already exports `.gp` (Guitar Pro 7 and later). This slice adds Guitar Pro 5 export with a writer of our own, and reports everything the older format cannot hold before the file is saved.

**Delivered:** Guitar Pro 5.10 (`.gp5`). **Not delivered:** Guitar Pro 6 (`.gpx`). A `.gpx` file is a BCFZ/BCFS container of a compressed GPIF filesystem with its own compression and block layout; a writer is out of proportion to this slice and a file we could not open in real Guitar Pro would be worse than none. The row therefore stays partial, and the export dialog and help say plainly that `.gpx` export is not available.

## Behaviour

- Export score has a new format, "Guitar Pro 5", beside "Guitar Pro". It uses the shared track and measure selection and the shared file-name field (saved as `.gp5`).
- The writer is `src/export/gp5.ts`. Its layout is taken from alphaTab's own GP3-5 reader (`Gp3To5Importer`) and checked against a real Guitar Pro 5.10 file in the compatibility corpus: that file reads into a score and writes back byte for byte, apart from the unused tail of the 30-byte version field.
- **Held:** title, artist and the other header fields (UTF-8), notices, lyrics (one track, five lines), tempo and tempo changes on a beat of the first track, key and time signatures, repeats, alternate endings, sections, directions (coda, segno, D.C./D.S. and so on, once each), triplet feel, tracks with name, colour, tuning (up to 7 strings), capo, instrument, volume, balance, bank, mute and solo, percussion tracks, two voices per measure, rests, dotted notes, tuplets 3, 5, 6, 7, 9-13, ties, dead and ghost notes, accents, dynamics, bends, whammy bar, slides, hammer-ons and pull-offs, harmonics, trills, tremolo picking, let ring, palm mute, staccato, vibrato, strokes, slaps and pops, fingering, note length, grace notes, chord diagrams, beat text, mixer changes, octave marks and beam directions. Simile (%) measures are written out as the notes they repeat.
- **Refused before any save dialog** (a `Gp5Refusal`, shown in the dialog and thrown from the coordinator): music whose notes or rhythm the format cannot hold. That is more than 1000 measures, more than 28 pitched or 4 percussion tracks, a track with no strings that is not percussion (for example keys), more than 7 strings, a partial capo, a transposing instrument, a double-dotted note, a tuplet the format lacks, a note value outside whole to 64th, a fret above 127, or no music at all.
- **Reported, not silently dropped:** what the format can only approximate or lose is listed in plain words, one line per kind with a count (backing audio, staves after the first, voices after the second, slurs, fermatas, tenuto, ornaments, hairpins, wah, gradual tempo changes becoming sudden, free-time measures, text longer than a field allows, and the rest). The dialog shows the list for the current selection as soon as the format is chosen. When the user presses Export, the existing confirmation (`confirmExport`) repeats the list and also says that page layout, styling, sound settings and backing audio are never stored in a Guitar Pro 5 file. Declining stops the export before the save dialog.
- A banjo drone staff is written as a plain 5-string staff with the same sounding pitches, and says so.
- The native side (`export_gp5`) refuses bytes that are not a Guitar Pro 5 header before asking for a destination, then writes with the same revision check and job guards as the other byte exports. A zip (Guitar Pro 7) is refused.
- Existing exports are unchanged. `confirmExport` takes an optional detail so the Guitar Pro 5 question can name what it loses; the existing call sites pass nothing.

## Acceptance

- Unit tests: header and read-back through alphaTab's reader with every byte consumed; rhythm (start, length, tuplets, dots) and pitches equal to the source for every file of the compatibility corpus that reads (`.gp3`-`.gp8`, `.gpx`, `.gp`); each technique above; refusals and the loss list; selection of tracks and measures; coordinator order (refuse, then confirm, then save); native header check.
- Desktop driver `tests/desktop/parity-gp5-export.mjs` (written, run by the controller): the fixture's nine-string guitar is refused with the save disabled and nothing written; with Bass6 and Drums chosen the `.gp5` is written and read back through alphaTab with the fixture's start ticks and pitches.

## Limits to record

- Verified against alphaTab's reader only. It has not been opened in real Guitar Pro, which cannot be tested here.
- Guitar Pro 6 (`.gpx`) export is not delivered.
- A file that reads back with the same rhythm and pitches is the bar, not identical layout: stylesheets, page setup (written as Guitar Pro's defaults), sound settings and backing audio do not survive.

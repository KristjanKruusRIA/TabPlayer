# F02: MIDI import with quantization and options

Date: 2026-10-24. Status: design. Row F02 ("MIDI import with quantization/options") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8 opens a MIDI file through an import dialog: the file's tracks become score tracks, and quantization options decide how its loose timing becomes written notes. TabPlayer exports MIDI but cannot read it, and alphaTab does not read Standard MIDI Files, so the importer is owned code. It follows the precedent of ASCII tab import (`File → Import ASCII tab…`): the web layer converts the file to a Guitar Pro score, writes it with `exportGpInterchange`, and the existing `import_converted` command opens it as a new untitled document. No Rust, protocol or edit command changes.

## Reading the file (`src/interchange/midi-smf.ts`)

- Works from bytes only and returns a `MidiSong`: ticks per quarter, the first track's name as title, merged tempo, time signature and key signature events, and the tracks that hold notes.
- Reads format 0 and format 1, running status, meta and system exclusive events, and note-on with velocity 0 as note-off. Overlapping notes of one key and channel close in the order they opened. A note left open ends with its track.
- Refuses, with a message and no partial result: files over 8 MB, RIFF-wrapped files, a bad header, format 2 ("independent sequences"), SMPTE timing, a zero division, a format 0 file without exactly one track, missing or cut-off tracks, an event cut off by its chunk, a data byte above 127, running status with no status byte, a time longer than four bytes, a system real-time byte, a wrong-sized tempo event, and a file with no notes. Unknown chunks are skipped. The event count is capped.
- The importer is a pure function from bytes to a new score. A refused file never reaches the workspace, so the open score and its history are unchanged.

## Turning it into a score (`src/interchange/midi-import.ts`)

- **Tracks.** Each (MIDI track, channel) pair with notes is one score track. Its name is the MIDI track name, or the program name when the name is empty or the track has several channels (then "Name (Program)"). Channel 10 is a percussion track. The program is the last program change at or before the first note, else the first change. Later program changes are counted and reported, not imported. At most 32 parts.
- **Bars.** Time signatures from the file set the bars. A signature that starts inside a bar takes effect at the next bar line, and the summary says so. Signatures outside 1–32 over 1–32 are skipped. At most 3000 bars.
- **Tempo.** Tempo events become bar-level tempo automations at their position in the bar, rounded to whole BPM. Until the first event the tempo is 120 BPM, as in MIDI.
- **Key signatures** carry on from the bar they start in.
- **Quantization.** The option is the shortest note value: 1/4, 1/8, 1/16 (default), 1/32 or 1/64. Starts and stops snap to that grid. A note that would have no length gets one grid step.
- **Tuplets.** Option: none, triplets (default), or triplets and quintuplets. Each quarter-note span of a bar chooses between the straight grid and a tuplet grid (3:2 from 1/8, 5:4 from 1/16) by comparing how far its note starts and stops sit from each grid. A tuplet grid must beat the straight grid by a margin, so straight playing never turns into tuplets. A span is written as a tuplet only if some note starts or stops off the straight grid. Notes in a tuplet span are written as 3:2 or 5:4 beats of the grid value.
- **Voices.** Option: 1 to 4 voices per track (default 2). Notes that start together and stop together form a chord. Other overlapping notes go to the lowest free voice. When every voice is busy a note starting with a chord joins it, otherwise the voice that frees soonest is cut short; both are reported. A voice that is silent in a bar is an empty voice there. Drums use one voice, and a hit lasts until the next hit or the end of its quarter note.
- **Rhythm.** Gaps become rests. Lengths are split into the longest straight values (dotted where that fits) or tuplet slot values, and a note that continues across a bar line, a tuplet span or a value limit becomes tied notes.
- **Instruments.** Programs 24–31 (guitar) and 32–39 (bass) become tablature staves, in standard 6-string and 4-string tuning, when the option is on. Fretting picks the lowest frets near the previous chord, one note per string, and avoids strings still sounding in another voice. If a chord cannot be fingered anywhere in the part, that part is imported as notation only and the summary says so. Other programs are notation on a treble or bass clef chosen by the median pitch. Drum keys 35–81 map to the standard articulations; other keys are skipped and counted.
- **Not imported:** velocities, controllers (volume, pan, pitch bend), lyrics, markers, aftertouch, and later program changes.

## The dialog (`src/workspace/MidiImportDialog.tsx`)

- `File → Import MIDI…` opens a modal dialog like the ASCII one: focus trap, Escape and Cancel close it, busy state disables Import.
- **Choose MIDI file…** reads a `.mid`/`.midi` file with a file input (8 MB limit). The options are **Quantization**, **Tuplets**, **Voices per track** and **Guitar and bass as tablature**. A summary line ("Format 1, 3 parts, 12 measures at 100 BPM."), a list of parts and the import notes update live as options change.
- A file that cannot be read shows its reason in the status line and keeps Import disabled. Import writes the GP bytes and calls `onImportConverted(name, bytes)`; a refused open keeps the dialog and file. The score is named after the file with a `.gp` extension and opens in a new tab, untitled, so it cannot overwrite the MIDI file.
- Wiring in `src/App.tsx` is one button, one state flag and one render line. The help topic gains one sentence.
- **Native file filters.** The native Open dialog (`read_document`), the library index and the drop path list score extensions only and are left unchanged on purpose: MIDI needs the options dialog, and passing a raw `.mid` to the GP reader would fail. MIDI is therefore imported only through the dialog, whose file input is the WebView's own picker.

## Acceptance

- **Unit tests** (`midi-import.test.ts`, `MidiImportDialog.test.tsx`):
  - parsing of format 0 and 1, running status, tempo, meter, key and names, and every refusal above, plus truncation and corruption sweeps that must either parse or throw an `Error`;
  - quantization to the chosen grid; ties across bar lines; time signature changes; tempo positions;
  - triplets, quintuplets, sixteenth triplets, held notes in tuplets, no false tuplets in straight playing, tuplets off;
  - voices (separate, cut short, empty in silent bars), chords, programs per channel, tablature fingering and its fallback, drums, key signatures, the part limit;
  - random unquantized playing under every option fills every bar exactly and survives a Guitar Pro round trip; ties, tuplets, tempo, programs, second voices and drum sounds survive it;
  - the dialog: options and summary, import name and bytes, refusal with no import, oversized file, failed open, focus trap and Escape.
- **Desktop** (`tests/desktop/parity-midi-import.mjs`, not yet run): a cut-off file and a text file are refused and change nothing; a format 1 file with tempo, 3/4, a guitar triplet, two bass voices and drums opens as an untitled tab with the right tempo, meter, programs, tuplets, tuning, voices and drum sounds, and accepts an edit; the same file with other options opens in another tab without tuplets, tablature or the second voice.

## Scope

- No SMPTE, format 2 or RIFF files; no multi-file import; no remembered options.
- No import of dynamics, controllers or later program changes.
- No swing detection, and no tuplets other than triplets and quintuplets.
- Overlapping notes that need more voices than the option allows are shortened rather than split into more staves.

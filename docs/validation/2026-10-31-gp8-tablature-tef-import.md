# GP8 parity F07: TablEdit (.tef) import

Date: 2026-10-31. Status: **experimental and partial; verified only against synthetic fixtures. Not tested on any real TablEdit file.** This replaces the rejected attempt on `feat/slice-f07` (commit 6788db7), whose parser invented the format; none of its code is reused.

## Behavior

- **Entry.** `.tef` is in the Open dialog filter (`src-tauri/src/lib.rs`). Rust intake stages the original bytes as a `file` base document. `intake.rs` caps content at 16 MiB by signature (`ptab` at byte 0, or `tbed` at 0x38) whatever the extension. The window-side check (`archive-gate.ts`) skips the alphaTab probe for TablEdit bytes, keyed on content, so Open, drop and project restore all reach the importer. `engine.ts` converts in `buildDocument` before the document is committed, so a failed import raises an error with no state change.
- **Shared code.** `src/import/import-support.ts` holds the bounds-checked `ByteReader`, the 16 MiB limit and the `ImportReport` (merged dropped counts and a bounded warning list that counts overflow instead of discarding it). The Power Tab reader now extends the same `ByteReader` and uses the same label formatter.
- **Imported:** title, subtitle, copyright; tempo; per-measure time and key signatures; pickup measures (anacrusis flag); one track per instrument that has notes (name, MIDI program, tuning, capo, bass clef for low tunings); notes, chords, rests, dotted, double-dotted and triplet lengths, 64th notes; ties; grace notes (as a grace beat of the stored grace fret); a second voice; simple repeats from the reading list.
- **Strings.** String 1 is the highest-pitched string (top tab line). Pitch is `96 - stored value`, stored lowest string first. Not inverted; a test pins E4 on string 1 and E2 on string 6. Bends are not imported at all (nothing is read, so nothing is halved).
- **Dropped, reported in the notice with counts:** text markers and texts, comment/notes/link fields, fingerings, grace-note effects, events of unrecognised kind, events after the last measure or on undefined strings, notes that overflow their measure, duplicate notes, ties with no earlier note, unsupported time signatures, key signatures or lengths, capo values out of range, reading-list jumps and endings, repeats that overlap or exceed the expansion limit, instruments with no notes, instruments beyond 15 playback channels. The notice says the import is experimental. "Nothing dropped" means "nothing recognised was dropped".
- **Limits against hostile input.** 16 MiB file; 4000 measures; 32 instruments; 12 strings each; 100 000 events (counted while reading, before building); 2000 reading-list entries; 12 000 bars (tracks x measures) and 150 000 beats built. Every table count is checked against the bytes that remain before use. No recursion. **Repeats:** only runs of one identical range in order become repeats, never nested or overlapping, count capped at 16, expansion capped at 100 000 bars, so a tiny file cannot make MIDI generation explode (the 494-byte nested-repeat case). Every failure is a `TablEditError` with a readable message.

## Layout facts and provenance

Sources: **M** = MuseScore `importexport/tabledit` reader (`importtef.h`, `importtef.cpp`, `measurehandler.cpp`, `tuplethandler.cpp`, branch `deprecated_master`, GPL). It was read, through fetched text summaries, for layout facts only; no code, tables or structure were copied, and this importer is written independently. No published TablEdit specification was found (web search found only user help pages). Because M is a single source, "confirmed" means "stated by M", not verified against real files.

| Fact | Status |
|---|---|
| No magic at byte 0; u32 `tbed` (0x64656274, little-endian bytes `tbed`) at 0x38; a byte-reversed `tbed` occurs in some files | confirmed (M); the reversed layout is refused |
| Fixed header: tempo u16 at 6 (quarter-note BPM), security code u32 at 16 (non-zero = refuse) | confirmed (M) |
| Pointer table (u32 absolute offsets): contents 0x3C, title 0x40, subtitle 0x44, comment 0x48, notes 0x4C, texts 0x54, measures 0x5C, instruments 0x60, reading list 0x80, link 0x84, copyright 0x8C; zero = absent | confirmed (M) |
| u16 at 0xCA = 4 and high byte of u16 at 0xCC = 10 (TablEdit 3.x) | confirmed (M); other values refused |
| Text: u16 size including terminator, `size-1` bytes, terminator | confirmed (M); size 0 treated as empty |
| Measures table: u16 structSize, u16 count, u32; 8-byte records: flag (0x08 = pickup), unused, i8 key, size, denominator, numerator, u16 margins | confirmed (M) for offsets; denominator is the literal value (4 = quarter): **guessed** (M does not say, a log encoding would break it) |
| Instruments table: u16 structSize, u16 count; 68-byte records: u16 strings (1..12), u8 MIDI voice at +8, u16 capo at +12, 12 x u8 tuning at +20, 36-byte name at +32 | confirmed (M); stride is `max(68, structSize)`: **guessed** |
| Tuning value `v` means MIDI `96 - v` | confirmed (M) |
| Strings numbered globally across instruments; within an instrument the tuning entry is `strings - i - 1` | stated by M; **the reading that string 1 is the top line, i.e. last stored value, is inferred** (TablEdit's convention plus M's index arithmetic). If a real file shows otherwise, the fix is one line in `tabledit.ts` |
| Reading list: u16 structSize, u16 count, entries u16 first, u16 last + label | confirmed (M); that measure numbers are 1-based and inclusive, and that identical consecutive entries mean a repeat, are **guessed** |
| Contents: entries of a u32 word plus 8 bytes, ending at `0xFFFFFFFF`; word >> 3 = slot, position = slot / totalStrings (64ths of a whole note), string = slot % totalStrings | confirmed (M) |
| Entry bytes: b1 low 6 bits marker (1..0x32 note with fret = marker-1, 0x33 rest, 0x39 text marker), 0x40 grace flag; b2 low 5 bits duration code, `b2 >> 5 == 7` tie; b3 bits 0x30 voice (2 upper, 3 lower); b4 grace effect (>>5) and grace fret (low 5); b7 fingering | confirmed (M) |
| Duration codes: 0..18 cycle plain, dotted, triplet over whole..64th; 19, 22, 25, 28 double dotted half..16th | confirmed (M) |
| Triplets: a triplet beat is a 3:2 tuplet of its base value; **positions around triplet groups, and the stored position step, are guessed**. M notes TablEdit stores a triplet with a different nominal length than its true one, which this importer cannot resolve without a real file, so it ignores position gaps inside a triplet group and fits each bar to its time signature |
| Voice mapping (default and upper to voice 1, lower to voice 2) | guessed |
| Pickup measure: leading gap removed, no trailing rest padding | M describes the gaps; the rendering is guessed |

## Evidence

- `src/import/tabledit.test.ts` (21 tests, passing): parsing, content-keyed detection, refusals (wrong marker, reversed, protected, old version, 0/13 strings, no measures, missing sentinel, pointer outside file), truncation at every byte offset, 1500 corruption rounds that never touch the `tbed` marker and are asserted to get past the signature (more than 300 parse fully) plus 300 random-garbage rounds with a valid marker, huge declared counts, event and bar/beat caps, string orientation and pitch, instruments, rhythm, bar filling, dotted/triplet lengths, grace/voices/64ths and dropped-content counts, reading-list repeats and jumps, a 27 KB file with nested and 600-fold repeats whose generated MIDI bar count is asserted to stay at most 16 x measures, pickups, merged bounded notices, the empty file, `buildDocument` integration, a bad file raising an error, and the archive-gate skip (no Worker created).
- `src/import/powertab.test.ts` (25) still passes after sharing the reader.
- `npx tsc --noEmit` passes. `vitest run src/import src/interchange/archive-gate.test.ts --testTimeout=40000 --maxWorkers=2`: 62 passed. A wider run over `src/interchange` and `src/engine` showed only `ENOENT` failures for `.analysis/compatibility` fixtures that are absent in this worktree (GP and MusicXML suites); those suites were not exercised against real files.
- `cargo test --locked --lib intake` passes (12 tests, including the new TablEdit cap), with empty stand-in `resources/audio` and `resources/library` directories created for the build and removed afterwards.
- No `.tef` exists under `E:\git\TabPlayer\.analysis\compatibility` (Glob found none).

## Review

No independent review has been run on this slice. Treat it as unreviewed.

## Limits

- **No real TablEdit file was tested.** Fixtures come from `tabledit-fixture.ts`, which encodes the same assumptions as the parser; tests prove self-consistency, not agreement with TablEdit. Every "guessed" row above can make a real file fail with an error or import wrongly (string orientation, triplets and voices are the likeliest). A first real-file test is required before claiming support.
- The layout comes from one third-party reader, learned through summaries of its text, not from a specification.
- Zip-compressed `.tef`, TablEdit 2 files, big-endian files, protected files, `.tbt`/`.ptb`-style sibling formats are out of scope.
- Texts, chord diagrams, effects (bends, slides, harmonics, etc.), dynamics, repeats beyond simple ones, endings and page layout are not imported; the native project keeps the original bytes.
- **Licensing.** The MuseScore reader is GPL. Only facts about the file layout were taken from it; no code or structure is copied. The format is not covered by that licence, but re-check before bundling real TablEdit samples.
- Not verified: macOS and Linux, the desktop open dialog and drop with `.tef`, restore of a saved TablEdit project in the real app, playback of an imported score through the native audio plan, library index or batch converter (they do not list `.tef`).

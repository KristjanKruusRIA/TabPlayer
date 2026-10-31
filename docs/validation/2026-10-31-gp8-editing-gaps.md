# GP8 parity E15 (partial) and E18 (implemented): bar repair and section navigation (2026-10-31)

Branch `feat/slice-editing`, based on `develop`.

## Pick
I read the score-editing rows (E and S ids) of the [progress overlay](2026-10-15-gp8-parity-progress.md) that were partial and looked for the smallest software-only gap that a person writing tablature meets daily.

- **E15 Bar arranger and bar-duration checker.** The overlay still carried the 2026-10-15 baseline text ("no underfull report"), but the Score errors list (L05) already reports short and long voices. What was left was the repair, and the editor had no way to fix a short measure except by inserting rests by hand, beat by beat. A short or overfull bar is the most common thing to fix while typing in a song, so this was the most useful small gap. After review it is **not closed**: see Limits. E15 stays partial.
- **E18 Find/go to section or musical position.** Section labels can be authored and are exported, but nothing used them: moving to the chorus meant knowing its bar number. A list of the named sections needs no edit type and no engine change, so it is the smallest gap on the list.
- **Passed over:** S19 (pitch-preserving re-fingering on retune) and S24 (sustain toggle) change what the Rust audio and retune paths compute and sit close to the approved tone; E19 (direct symbol editing) needs click targets inside the alphaTab-rendered score; S08 and S06 need a grand-staff creation flow; E05 needs rhythm entry on the rendered score; E02, E08, E09, E11 and E21 are bounded by clipboard slicing that is a larger rewrite; S13 needs a data catalog.

## Behavior
- **Inspector, Score errors (n):** every entry now has a second button next to the jump button.
  - A short voice offers **Fill with rests**. The missing time is added at the end of the voice as the fewest standard rests, longest first, and each may be dotted or double dotted. Existing notes and their order do not change.
  - A voice that runs past the barline offers **Trim to fit**. The button says what it will remove before it is pressed, for example "removes 2 beats and 3 notes". The beat that crosses the barline and everything after it go; a tuplet that crosses goes whole (the beats of its group before the cut are removed too), and grace notes in front of a removed beat go with it. Whatever time is then missing is filled with rests as above. Notes on removed beats are removed with their ties.
  - Fill with rests is refused when the last sounding note is tied into the next measure, because the rests would sit inside the tie; the message says to remove the tie first.
  - After a repair, focus moves to the repair button now in that row's place, or to the section heading when none is left.
  - One click is one edit, `fitVoice {track, staff, bar, voice}`, so it is one Undo step and is replayed from the project history. A voice that is already complete, an unused voice, a free-time measure or a missing measure or voice is refused and records nothing.
  - A remainder that standard rests cannot write exactly, such as a tuplet fraction under a 64th, is refused with a message.
  - The button keeps `aria-disabled` while the editor is busy and never gets `disabled`, so keyboard focus stays on it. It is absent when the document is locked.
- **Inspector, Sections (n):** lists each measure whose Section label is not blank, as "Measure 9 · Verse", in score order.
  - Clicking an entry selects the first beat of that measure on the current track, staff and voice. While playback is running the transport also seeks to that measure.
  - The entry for the section the cursor is in is marked (`aria-current="location"`).
  - Previous section and Next section step between section starts. At either end the button keeps focus and does nothing.
  - With no sections the panel says how to name one.
  - Positions that are not sections are still reached with the existing Measure and Beat selectors.
- **Compatibility:** `fitVoice` is a new edit type. No existing type changed, so older `.tabplayer` projects and edit logs replay as before; a project that contains `fitVoice` needs this version or later, like any new edit type. The Rust `EditCommand` has a matching variant with the same four unsigned fields, and `tests/protocol.json` now holds 79 shared examples.

## Evidence
Run in the worktree on Windows. Nothing here was run against a packaged desktop build or compared with GP8.

- `src/editor/fit-voice.test.ts` (11 tests, written first and failing with "Unknown edit command"):
  - fills a three-quarter gap with one dotted half rest, records exactly one edit and gives the same score after a JSON round trip of the project;
  - keeps existing notes when it fills;
  - a remainder that needs several rests (a half and a dotted eighth) fills exactly;
  - refuses a complete voice, a missing bar and a missing voice;
  - an imported GP file with an overfull bar becomes complete after `fitVoice` while the beats that fit are unchanged;
  - a crossing triplet group is removed whole and no fraction of it is kept; the grace note in front of a removed beat is removed; the error list reports the beats and notes a trim removes; Fill with rests is refused after a note tied into the next measure;
  - the command takes exactly its four fields and rejects extra, missing and negative values.
- `src/editor/ScoreErrorsPanel.test.tsx` (5 added): one repair button per error with the right label and argument, none without `onFit`, busy refuses the click without `disabled` and keeps focus, Trim to fit shows what it removes, and focus lands on the next row, then the heading.
- `src/editor/sections.test.ts` and `src/editor/SectionsPanel.test.tsx` (7 tests): listing, blank labels, the section a bar is in, previous and next at both ends, the current-section marker, the focus-keeping end buttons and the empty message.
- `cargo test --locked --test protocol`: 9 passed with the new variant and the example count at 79. `cargo fmt -- --check` is clean. The Rust variant needs `src-tauri/resources/audio` and `library` to build, which the worktree borrowed through temporary junctions that were removed before the commit.
- `tsc --noEmit` is clean. After the review fixes, `vitest run` over `src/editor`, `src/App.test.tsx` and the parity-, range- and harmony-command tests (`--testTimeout=40000 --maxWorkers=2`) passed: 74 files, 1071 tests. `cargo test --locked --test protocol` passed again. The full suite and the other Rust suites were not run.

## Review
Self-review only; no independent reviewer ran, and this report is not a hot-path review.

- One gesture is one edit: both repairs are a single command, and the engine applies it as one history entry.
- Choosing the current value records nothing: a complete voice throws before any change is made.
- Replay: the command is applied by the same `apply` path that replays history, and a test re-opens the project from JSON and compares scores.
- A destructive trim is undoable and only removes beats at the end of the voice that already overran the barline. The panel names it Trim to fit, not Fix.
- No `disabled` was added for busy anywhere; the new Previous and Next buttons use the `unavailable` guard.
- `src-tauri/src/audio/tone.rs` is untouched. TablEdit import, password lock and localization files are untouched.

## Limits
- **E15 stays partial.** The acceptance asks for repair "with rests/ties correctly". Rests are covered. Ties are not: a beat that crosses the barline is removed, not split into a tied part inside the bar, and a note tied into the next measure blocks Fill with rests instead of being handled. Rebalancing across measures is not offered. The repair is per voice from the list; there is no "fix all" and no check that runs while typing. Pickup and free-time measures are not reported or repaired, as in L05. A tuplet is chunked by its count of beats, so a mixed-duration tuplet may be cut at a slightly different place than its musical group.
- E18: sections come only from Section labels. There is no timeline strip, no search-by-text across lyrics or chords, no keyboard shortcut and no section drag-reorder. The playback seek on a jump uses the transport's measure seek and was exercised only through the App wiring, not against a running native player.
- Not run: the desktop test app, macOS, Linux, and a comparison with GP8. The pinned baseline files are unchanged.

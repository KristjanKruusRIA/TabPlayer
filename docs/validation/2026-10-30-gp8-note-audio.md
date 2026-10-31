# GP8 parity A30: per-note audio (2026-10-30)

GP8 lets one note sound longer, shorter, earlier, later, louder or softer without changing how it is written. This slice adds that, following `docs/superpowers/specs/2026-10-24-gp8-note-audio-design.md`. The row is partial: see Limits.

## Behavior
- **Settings:** the inspector has Sounding length, Start offset and Velocity change for the selected note. A value commits on Enter or blur, never while typing.
- **Storage:** each change is one `setNoteTechniques` edit, undoable and refused on a finalized score. Reset clears all three.
- **Heard everywhere:** playback, audio export and MIDI export use the settings. Written rhythm is unchanged.
- **Ranges:** an out-of-range value is refused with a message. The last group keeps half its length when shifted, and a refused edit is forgotten.

## Evidence
- **Rust:** 852 tests passed on the merged branch.
- **Frontend:** `tsc` was clean, `src/App.test.tsx` passed 143 of 143, and the rest of the suite passed 4,000 with 1 skipped; `src/editor/corpus.test.ts` is excluded from that run.
- **Desktop:** `tests/desktop/parity-note-audio.mjs` passed on a Windows desktop-test build at cefb9c8. Length 50, offset 240 and velocity 20 were three undoable edits. MIDI export carried them exactly with the other notes untouched, audio export started the note later by the offset, and the exported Guitar Pro score equalled the baseline byte for byte. Undo and redo restored them, reset returned the MIDI export to the baseline, and a finalized document disabled the fields.

## Review
- **Source:** rejected twice, then approved at 68a2efb. One Low is left: the spec should mention the clamp at range start.
- **Desktop run:** every failure was in the driver, none in the app: a MIDI parser overshooting its track, wrong string numbering, a missing GP test destination, no string selected, and a word search that matched ordinary GP text. The last check is now a stronger byte comparison.

## Limits
- **Why partial:** Guitar Pro 7 and 8 have no known field for these, so the settings stay in the project and are lost in a GP file. A GP8-written sample would be needed to learn its properties.
- **Audio:** not judged by ear.

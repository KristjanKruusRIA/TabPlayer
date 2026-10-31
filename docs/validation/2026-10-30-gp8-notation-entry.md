# GP8 parity E05: enter pitches on a notation staff (2026-10-30)

GP8 lets you enter notes on staff lines and spaces. TabPlayer's score only selected existing notes. This slice adds an entry staff in the inspector. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-notation-entry-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build. The row is partial: see Limits.

## Behavior
- **Entry staff:** a small staff in the selected bar's clef. Clicking a line or space enters a note, and a click on an existing pitch removes it.
- **Keyboard:** A to G enter a note, `#` or `+`, `-`, `N` and `K` choose an accidental, Page Up and Page Down change octave, and Up, Down, Enter and Space move and use a cursor.
- **Accidentals:** the default follows the key signature, and a choice lasts for one entry.
- **Pitched staves:** the written pitch is sent as `addPitchedNote`.
- **Fretted staves:** the note goes on the lowest fret of a free string, as in the instrument view's keyboard.
- **Pitch rule:** written pitch follows alphaTab's own drawing rule, so transposition, display transposition and clef and beat octaves all land where clicked.
- **Disabled:** locked, busy, no beat, and percussion staves.
- **No format change:** the slice adds no edit command.

## Evidence
- **Rust:** 815 tests passed across the merged branch, none failed.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout, and the rest of the suite passed 3,742 of 3,743 with 1 skipped; the one failure, `src/editor/corpus.test.ts`, was a timeout under load, and it passed alone. Regression tests compare results against alphaTab's own `displayValue`.
- **Desktop:** `tests/desktop/parity-notation-entry.mjs` passed on a Windows desktop-test build of the merged source. The run:
  - added, flat-spelled and removed fretted notes by clicking, each undoable;
  - entered pitched notes by mouse and keyboard with accidentals, octave keys and the cursor;
  - entered on a bass clef staff, and a blank-project guitar at the pitch its staff displays;
  - saw percussion staves refuse pitch entry;
  - exported GP and read back every note's display value and spelling.

## Review
- **Code review:** an Opus review ran worked cases against alphaTab.
- **Findings and fixes:**
  - **High, fixed:** a fixed +12 was wrong on a blank-project guitar, where E4 showed as E3, and on octave clefs and banjo.
  - **High, fixed:** pitched staves ignored transposition.
  - **High, fixed:** naturals rendered as E#, B# or Cb in keys that prefer those spellings.
  - **Medium, fixed:** existing notes were drawn from pitch class, held keys flooded edits, and keys were dropped silently during an entry.
  - **Low, fixed:** controls changed state while disabled, the staff was mouse-only, and a missing note still said "Entered".
- **Desktop run:** the driver passed on its first run after the fixes.

## Limits
- **Why partial:** entry is on an inspector staff, not on the rendered score, because alphaTab gives no click positions there.
- **Undo:** a flat or off-key sharp costs two undo steps.
- **Rhythm:** no automatic advance and no rhythm entry.
- **Accidentals:** no double accidentals.
- **Toggle:** it compares pitch, so Flat+D on a C# removes it rather than respelling it.

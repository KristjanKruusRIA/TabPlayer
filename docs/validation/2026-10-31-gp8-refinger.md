# Validation Report: Keep Pitch on Retuning and Capo Change (S19)

## Behavior

- **Option to Keep Sounding Pitch (`keepPitch`):** Added optional `keepPitch?: boolean` to `SetTuning` (`{ type: 'setTuning', track: number, tuning: number[], tuningName?: string, keepPitch?: boolean }`) and to `StaffSettings` (`{ tuning: number[], capo: number, ..., keepPitch?: boolean }`).
- **Default Preserved:** When `keepPitch` is `false` or omitted, frets are kept and sounding pitches change, behaving exactly as before. Old projects replay 100% unchanged.
- **Sounding Pitch Calculation:** When `keepPitch` is `true`, notes are refretted to match their exact sounding pitch:
  $$\text{pitch} = \text{tuning}[\text{tuning.length} - s] + \text{fret} + \text{stringCapo}(s) + \text{droneShift}(s, \text{fret}) - \text{transposition}$$
- **Unreachable Notes Reported:** If any note cannot be placed within the playable fret range ($0 \le \text{fret} \le \max(24, \text{oldFret})$) on any candidate string, all unreachable measure and beat locations are accumulated and reported to the user (e.g. `Notes cannot be reached in the new tuning or capo: bar 1, beat 1.`). No note is dropped silently, and no partial edits are committed to the score.
- **Chords:** Bipartite matching (`placeBeat`) guarantees that every note in a chord receives a distinct string; a chord never ends up with two notes on one string.
- **Note Links and Ties:** Linked notes (ties, hammer-ons, pull-offs, slides) verify that the next-note relationship on the string is maintained (`holds(...)`). Tied notes on retuned strings (e.g. string 1 in Drop D) move to their new fret while preserving the tie.
- **UI Controls:**
  - `TrackSettingsPanel.tsx`: Added "Keep pitch" checkbox next to tuning controls.
  - `StructurePanel.tsx`: Added "Keep pitch" checkbox for staff settings.
  - Localization: Added translations for `en`, `et`, and `de` (`'track_settings.keep_pitch'`, `'editor.keep_pitch'`).
- **Replay & Undo Safety:** The change constitutes one single undoable edit command. Undoing the command cleanly restores the original frets and tuning, and redoing restores the refingered frets.

## Evidence

- **Unit Test Suite (`src/editor/refinger.test.ts`):** 7 comprehensive tests passing:
  - `drop tuning keeps sounding pitch by moving string 1 notes up 2 frets`
  - `capo up moves notes down in frets while keeping pitch`
  - `capo down moves notes up in frets while keeping pitch`
  - `lists unreachable notes for the user and drops nothing silently`
  - `chords never place two notes on the same string`
  - `ties are preserved on their string across refingering`
  - `undo and redo replay cleanly and restore original/refingered states`
- **UI and Regression Test Suites:**
  - `src/editor/panels.test.tsx`: 46 passing tests (including `StructurePanel keep pitch checkbox passes keepPitch: true to setStaffSettings`).
  - `src/workstation/TrackSettingsPanel.test.tsx`: 18 passing tests (including `keep pitch checkbox adds keepPitch: true to setTuning edit`).
  - `src/editor/structure.test.ts`: 5 passing tests.
  - `src/engine.test.ts`: 42 passing tests.
- **Static Type Check:** `npx tsc --noEmit` runs clean with zero diagnostics.
- **Protocol Parity:** Rust `edit_types.rs` updated with `keep_pitch: Option<bool>` on `SetTuning` and `StaffSettings` with exact deserialization, validated against `cargo test protocol`.

## Review

- **One Place for Refingering:** `src/editor/refinger.ts` provides `planStaffRefinger`, `validateNoteLinks`, `refingerStaff`, and `refingerTrack`, reusing `placeBeat` and `holds` from `structure.ts`.
- **Preflight Validation:** Both `setTuning` in `engine.ts` and `setStaffSettings` in `structure.ts` validate all staves before mutating note structures. If any note is unreachable or breaks a link, the edit is aborted before any state changes occur.
- **Backward Compatibility:** Because `keepPitch` is optional and defaults to `false`, serialized edits and existing project files without `keepPitch` follow the exact pre-existing code path.

## Limits

- **Relocation Ceiling:** Maximum relocated fret is 24 semitones above the open string (or the note's original fret if it was already higher than 24).
- **Dead Notes:** Dead notes have no musical pitch and preserve their written fret.
- **Physical Drone String:** Banjo short drone string (string 1) only has open string (fret 0) and frets greater than the drone fret ($> \text{droneFret}$); frets $1 \le f \le \text{droneFret}$ do not physically exist and are excluded from valid candidate placements.

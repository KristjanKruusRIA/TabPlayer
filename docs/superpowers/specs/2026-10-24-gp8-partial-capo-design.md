# S18: partial capo by string

Date: 2026-10-24. Status: design. Row S18 ("Partial capo by string") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8 lets a staff carry a capo over the whole neck and a partial capo: a bar at one fret that holds down only some strings. TabPlayer keeps one integer `capo` per staff, and alphaTab, which models the score, has no per-string capo: it reads neither GP property and always writes an empty one. This slice adds the partial capo and makes every place that turns a string and fret into a pitch honour it. It adds no edit command and no dependency; a staff's settings carry it.

## Behaviour

- **Meaning.** A partial capo is a fret (1-127) and a set of strings. Strings count from 1 for the lowest-pitched string, as notes do.
  - On a covered string the capo that acts is the higher of the staff capo and the partial capo; on any other string it is the staff capo alone. A partial capo at or below the staff capo changes nothing, and the controls say so.
  - Fret numbers on a covered string count from the capo that acts on it, as they already do for the staff capo.
  - A string's sounding key is therefore `tuning + capo on that string + fret - sounding transposition`.
- **One place for pitch.** Every pitch alphaTab derives from a string and fret goes through `Note.stringTuning`. `src/editor/partial-capo.ts` replaces that getter once, so the playback plan, MIDI export, notation, trills, harmony and fingering code, clipboard conversion and the range edits all follow, with no per-feature copy of the rule. The few places that do their own arithmetic call `openStringKey` instead: the edit audition, the instrument view's readout and string titles, entry targets, the setNote and setTuning range checks, and the move-to-adjacent-string edit.
- **Storage.** A partial capo lives in a side table keyed by staff. The score-to-JSON conversion that every clone goes through carries it in an extra field (`tabplayerpartialcapo`, written only when a staff has one), and the JSON-to-score conversion attaches it before alphaTab finishes the score, so the pitch caches alphaTab builds there are right. A score without a partial capo serializes exactly as before.
- **Setting it.** `setStaffSettings` and `addStaff` take an optional `partialCapo: {fret, strings}` in their settings.
  - Omitted keeps the staff's own. `{fret: 0, strings: []}` clears it. Fret 0 exactly when no string is covered, strings ascending without repeats and within the staff's string count; otherwise the command is refused. Rust and TypeScript apply the same rules.
  - The settings are checked against the notes already on the staff, per string, so a partial capo can never push a note out of the MIDI range.
  - Changing the string count keeps the partial capo: the strings it covers are renumbered with the kept strings (strings that no longer exist drop out), and notes keep their sounding pitch under the capo each string has before and after.
- **Controls.** The Staff panel gains "Partial capo": a fret field and one checkbox per string, named with its pitch under the staff capo ("String 3 (G3)"). The fret commits on blur or Enter, the strings at once; "Apply staff settings" sends the command. A staff the user has not touched sends no `partialCapo`, and tabbing through the fret field changes nothing. A draft that is not valid (a fret outside 1-127, a fret with no strings, strings with no fret) keeps the last valid value, shows an alert and disables Apply staff settings and Add staff. The controls reset when the selection moves. The panel is disabled for percussion and unstringed staves, and Apply is disabled when the document is finalized, as for the other staff settings.
- **Readouts.** The instrument view's detail line adds "Partial capo 5 on strings 1, 2, 3 · fret numbers on those strings relative to it", and its open-string pitches and string titles include the capo that acts on each string. The ASCII tab heading adds ", partial capo 5 on strings 1, 2, 3".
- **GP file.** `PartialCapoFret` and `PartialCapoStringFlags` are written from the model and read back. The flags are one 0 or 1 per string in the order of the staff's `Pitches`, lowest string first, which is the order notes number strings. A malformed value (a fret that is not an integer, flags that are not 0 and 1 or do not match the string count, a fret out of range) is skipped with a console warning and never refuses the file. A trill is stored by GP as an absolute pitch counted from the staff capo alone. Loading adds the string's partial-capo lift so the trill keeps its fret offset, and export takes it off again, so repeated export and reopen does not drift. Changing a staff's partial capo rebases the trills it covers by the same lift; a change of the whole-neck capo moves stored trill pitches as it always has. After loading, each beat's lowest and highest note and its pitch lookup are recomputed.
- **Saved logs and the marker.** An edit log written before this feature replayed on a score that had no partial capo, and many pitch-dependent edits (move string, refinger, transpose, paste, theory chords, string count) are checked against pitch, so reading the file's partial capo into such a log could make the project refuse to open. The guarantee is therefore:
  - A partial capo a GP file holds applies to a project only if the project carries the marker `partialCapo: true` (a top-level project field, written only when true), or has no edits at all. A project with a log and no marker replays with the file's partial capo ignored, exactly as before, and a console warning says so; there is no existing place in the UI for such a notice.
  - The marker is set by the first edit of a project read from a file whose staves hold a partial capo (`document_mark_partial_capo`, not an edit, no undo step, not an unsaved change), before that edit is applied. It is never set on a project that already has a log, never cleared, and absent from every project whose base has no partial capo, so those serialize byte-identically to before. A project therefore never changes meaning between saves once it has edits; one with no edits and no marker reads the file's partial capo, and is marked at its first edit.
  - A staff-settings edit that carries `partialCapo` is a new-feature edit and replays in any project, marked or not.
  - An older build refuses a marked project (the strict project schema rejects the unknown field) rather than reading it wrongly. Chord-diagram paste still compares only the staff capo.
  - Not guaranteed: a project edited on this build after an in-app `setStaffSettings` partial capo, replayed on a build without this feature, is not readable at all, for the same reason.

## Acceptance

- **Unit tests** (`partial-capo.test.ts`, `partial-capo-view.test.tsx`, `edit_types.rs`):
  - validation of the value, in TypeScript and in Rust, including the same invalid cases;
  - capo 2 with a partial capo at 5 over strings 1-3 sounds 48 53 58 | 60 64 69 for fret 3, compared with worked-out keys per string, and a lower partial capo leaves every string at the capo;
  - keep, change and clear through `setStaffSettings`; pitch-range checks per string; the string-count refusal;
  - the same pitches after a JSON clone, a library `jsonToScore`, and a full replay; the pitch caches of a clone include the partial capo;
  - the same pitches in the playback plan, the edit audition and a MIDI export read by an independent decoder;
  - the GP file: the three capo properties written, read back with the same pitches, stable on a second trip, skipped with a warning when malformed;
  - the instrument view's readout, string titles and entry target names; the Staff panel's initial state, commit rules, omission when untouched, and lock.
- **Desktop** (`tests/desktop/parity-partial-capo.mjs`, one run by the controller): open a GP file holding capo 2 and a partial capo of fret 5 over strings 1-3; the plan sounds each string by its own rule; change the partial capo to fret 7 over strings 4-5 in the staff settings, as one undoable edit that moves only those strings; undo and redo restore the sound; a note entered from the view uses its string's capo; the exported GP holds capo 2, partial capo fret 7 and flags `000110`.

## Scope

- No new edit command: `tests/protocol.json` gains a partial capo on an existing `setStaffSettings` example and its count is unchanged.
- One partial capo per staff. GP8 also allows one on a staff with a whole-neck capo, which is covered; several partial capos on one staff are not.
- Not carried: the harmony library's saved-chord context compares only the staff capo, so a chord saved on a partially capoed staff is offered on any staff with the same capo, tuning and transposition; and the open-string tuning audition plays the tuning, which no capo changes.
- The flag order is taken from the order GP uses for tuning pitches. It has not been confirmed against a file written by GP8 itself; a file with the opposite order would read as the mirrored strings.

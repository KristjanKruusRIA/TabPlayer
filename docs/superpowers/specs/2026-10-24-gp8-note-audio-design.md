# A30: per-note audio duration, offset and relative velocity

Date: 2026-10-24. Status: design. Row A30 ("Per-note audio duration/offset/relative velocity") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8 lets a note sound differently from how it is written (manual: Audio, Note settings): a note can last longer or shorter, start a little early or late, and be louder or softer, without its written rhythm or dynamic changing. TabPlayer has only the written enums: a note's rhythm comes from its beat, its loudness from `dynamics`, `accent` and `ghost`. The row asks that one note's onset, length and level can be adjusted without changing the written position, and that the settings reach exports. This slice adds three settings to a note, edits them from the inspector, and applies them in the playback plan, the audio export and the MIDI export.

## What the formats already hold

- **alphaTab 1.8.4 (the model).** `Note.durationPercent` exists and clones, and the JSON converter carries it, but nothing in the MIDI generator reads it. The Guitar Pro 3-5 reader fills it from a note flag, so older files can carry values other than 1 that have never sounded. There is no field for an offset or a velocity change.
- **Guitar Pro 7 and 8 (GPIF).** alphaTab's GPIF reader and writer have no note-level property for any of the three, and no GP8-written file with such a setting was available to learn the property names from. The manual does not give the storage.
- **Decision.** Do not reuse `durationPercent` (a GP5 file would change how it sounds), and do not invent GPIF property names that cannot be checked. The settings live in the TabPlayer project and in every export TabPlayer renders (plan, audio, MIDI). A Guitar Pro export plays as the unedited score; this is recorded as a limit. If a GP8 file with the settings turns up, the property names can be added to the reader and writer without changing anything else here.

## Behaviour

- **The settings.** One value per note, `NoteAudio`:
  - `length`: percent of the note's planned sounding length, 10 to 400, whole numbers (100 is as planned);
  - `offset`: ticks (960 to a quarter note) added to the start, -480 to 480;
  - `velocity`: added to the velocity the note's dynamics give it, -64 to 64.
  The plain values (100, 0, 0) are the same as no setting: they are stored as none. Whole numbers only, so nothing needs rounding and the TypeScript and Rust rules are identical.
- **Where it is stored.** alphaTab has no place, so `src/editor/note-audio.ts` keeps a `WeakMap` from `Note`, as the partial capo does for `Staff`. Every clone goes through the score-to-JSON conversion, so a hook there writes an extra field on the note's own JSON object (`tabplayernoteaudio`, only for a note that has settings) and the JSON-to-score hook attaches it before the score is finished. A score without settings serializes exactly as before, and a score that never had a setting is never scanned. A malformed value in that field is skipped, not refused. `src/model-clone.ts` imports the module so the hooks exist wherever a score is converted, including the plan worker.
- **The edit.** `NoteTechniques` (the patch of `setNoteTechniques` and `setNoteTechniquesByIndex`) gains an optional `audio: {length, offset, velocity} | null`. `null` and the plain values clear it. No new edit command is added, so `tests/protocol.json` keeps its count (one existing example gains the field) and no edit-list position changes. Old logs have no `audio` key and replay exactly as before; the project has no new persisted field, so `Project`, the TypeScript reader and `file_library/metadata_input.rs` are unchanged. Rust accepts the field with the same limits (`NoteAudio::validate`); a log written with it is not readable by an older build, which refuses the unknown patch field.
- **Refusals** (at edit time, so nothing unreadable is ever saved):
  - a tied note that continues an earlier one: it makes no attack of its own, so the settings belong on the first note of the tie;
  - a changed `length` or `offset` on a note with bend, whammy, slide or vibrato, or tied on to one that has: alphaTab writes those as pitch-wheel events that are not attached to the note, so moving or stretching the note would leave them behind. Its velocity can still change, and a note that already has a length and offset keeps them when re-leveled. If a bend is added later, the plan ignores the start and length for that note and the inspector says so.
- **Playback plan** (`src/audio/note-audio-plan.ts`, called once from `plan.ts` after the plan's other adjustments): for each attack of a note with settings, in this order:
  1. **Offset.** The note's attacks (a trill's, a tremolo's, a rasgueado's) move together by the offset, so their spacing holds. The shift is held inside the room the voice leaves it: at most half the gap, less one tick, toward the nearest note before or after in the same staff and voice, and never before tick zero. Two neighbours that both move toward each other therefore keep their order, and a legato or hammer-on keeps its origin strictly before its destination. The written position and the performed-beat map do not move.
  2. **Length.** Each attack's own length is scaled, never below one tick and not past the end of the plan. A tied note's single attack covers the whole tie, so the tie scales as one sustained note; let ring scales the same way; a grace note and its main note have separate settings.
  3. **Velocity.** Added and kept from 1 to 127.
  The note's pitch curve is moved and stretched with it, and the plan's `noteOn`/`noteOff` events come from the same attacks, so notes and events agree. A note with no setting plans byte-identically (the new code is skipped), the `plan.performance` goldens pass unchanged, and the plan is checked by `validatePlaybackPlan` as before.
- **Audio export** builds its plan from the score's JSON, so it hears the settings through the same code. **MIDI export** generates its own attacks, so `noteAudioMidiAdjustments` runs the plan build once, only for a score that has settings, and returns the start shift, length and velocity of each attack by the same per-track attack ordinals the dead-note correction uses; `exportMidi` applies them to the note pairs. The MIDI file and the plan agree to the tick.
- **Interplay with the track interpretation slice (S22, S23, `interpretation.ts`, unmerged).** That slice adds a pass over the plan notes after the main loop. This slice's pass runs later, after it and before the plan's note events are written, so a note's own setting overrides the track's style. The change to `plan.ts` is an import, one array, one line in the build loop and one call just above the note-event loop, plus one exported function, and it adds no parameter to `buildWithIdentities` (the build's result goes out through a module-level sink while the export asks for it), so the two slices do not edit the same lines.
- **Controls.** The inspector's "Notes & techniques" gains a "Note audio" group of three number fields: "Sounding length (%)", "Start offset (ticks, 960 = quarter note)" and "Velocity change", and a "Reset note audio" button. A value is applied when the field loses focus or Enter is pressed, never while typing; a value out of range keeps the last good one and shows a message. Each applied field is one undoable edit that sends the other two unchanged. The group follows the panel's `busy` state, which includes a finalized document. It explains a tie destination and a bent, whammy, sliding or vibrato note.
- **Other places the settings travel.** Duplicate track, copy voice and paste bars copy the notes through JSON, so they keep the settings. Edits that keep a note object (change fret, transpose, move) keep them; deleting a note removes them.

## Acceptance

- **Unit tests** (`note-audio.test.ts` in `src/editor` and `src/audio`, `NoteAudioControls.test.tsx`, `edit_types.rs`):
  - the value rules, in TypeScript and in Rust, including the same invalid cases and the shared wire example;
  - a note without settings plans byte-identically, and the JSON gains no field;
  - the plan's start, end, velocity, pitch curve and `noteOn`/`noteOff` events for one note, the others untouched, and `validatePlaybackPlan` passing;
  - velocity within 1 to 127, an early offset held at tick zero, a minimum length of one tick, a long note kept inside the plan, neighbours moving toward each other keeping their order, a short note after a long one;
  - a tie scaled as one note, a tie destination ignored, let ring scaled, a tremolo's and a trill's attacks moving together, a grace note and its main note, a bent note keeping its start and length;
  - the same plan from the score and from its JSON (the plan worker and the audio export path);
  - a MIDI export read by an independent decoder, agreeing with the plan;
  - the edit: set, replace, clear, other fields in the same patch, history length, undo, redo, save and reopen by replay, an old log replaying to the same plan, refusals, a keyboard note by index, duplicate track, copy voice and paste, a Guitar Pro export reading back as the unedited score;
  - the inspector's initial state, commit rules, messages, reset, and its disabled states.
- **Desktop** (`tests/desktop/parity-note-audio.mjs`, one run by the controller): open a one-bar guitar file; export MIDI, WAV and GP as the baseline; set the three fields on the first note from the inspector, each one `setNoteTechniques` edit; a refused value is not an edit; a MIDI export shows the start, length and velocity exactly and the other notes unchanged; a WAV export starts the note later by the offset; a GP export has the same notes and rhythm and no trace of the settings; undo and redo restore the project; Reset clears the settings and the MIDI export returns to the baseline; a finalized document disables the fields.

## Scope

- Three settings on a note. No curves, no per-beat or per-range setting (a range can be done a note at a time), and no way to see the offset on the score.
- Not stored in Guitar Pro files (see above) or MusicXML.
- A note on a bent, whammy, sliding or vibrato line keeps its start and length (velocity only).
- The room a voice leaves an offset is computed within one staff and voice; notes in other voices may cross.
- A quarter note is 960 ticks whatever the tempo, so an offset is a musical fraction, not a time; a tempo change changes its duration.

# GP8 parity E05/W19: enter notes on the rendered score (THE-65)

Date: 2026-11-06. Branch `feature/e05-score-entry` from `develop`.

## Problem

Standard-notation entry happens on a small staff in the inspector (`NotationEntryPanel`), not on the score. It has no rhythm entry and no automatic advance. A flat or off-key sharp costs two undo steps, and auto-duration writes cost two as well, which breaks "one gesture is one undoable edit".

## What GP8 does (manual, note-input and shortcuts pages)

- **Clicking:** clicking the score places the cursor.
- **Durations:**
  - `+` makes the beat shorter and `-` makes it longer;
  - `.` dots it, Ctrl+`.` double-dots it, and `/` makes it a triplet;
  - `R` writes a rest.
- **Moving a note:** Ctrl+Alt+Up/Down moves it a staff step, and Alt+Shift+Up/Down a semitone.
- **Not documented:** letter keys for pitch, and automatic advance outside MIDI capture.

TabPlayer's E05 acceptance asks for entry on staff lines and spaces with accidentals and octave keys, so this design keeps letter entry from the inspector staff and brings it onto the score.

## Design

### 1. One gesture, one edit: `sequence`

- **New command:** `{type:'sequence', commands:[...]}`.
  - It holds 2 to 8 entry commands: `setNote`, `removeNote`, `setRest`, `setDuration`, `insertBeat`, `addPitchedNote`, `setPitchedNote`, `removeNoteByIndex` or `setNoteSpelling`.
  - No sequence can nest inside another.
- **TypeScript:** `projectCommands` flattens sequences, so every replay loop applies the sub-commands in order. A sequence is still one history entry and one undo.
- **Native:**
  - `EditCommand::Sequence` validates each sub-command and the allowed set and length, and refuses nesting.
  - Old projects and edit logs have no sequences, so they replay unchanged.
- **Users of `sequence`:**
  - the auto-duration pair (`setDuration` + `setNote`);
  - the inspector staff's pitch + spelling follow-up;
  - the new advance-with-insert below.

### 2. Clicking the rendered score

- **Entry mode:** a toggle, the **Note entry** button at the start of the main toolbar or the `N` key with the score focused. While it is on, a click on the standard-notation staff writes a note.
- **Hit test:** a pure `scoreEntryHit` turns a source-space point into a beat and a staff step.
  - It finds the clicked bar's `score` renderer through alphaTab 1.8.4's layout. alphaTab is pinned, and a real-render test guards this internal API.
  - It matches that renderer to its `BarBounds`, whose rectangle is exactly the five lines.
  - It picks the beat by x within that bar, preferring the current edit voice.
  - It converts y with `step = round((y - top + t/2) / (space/2))`, measured from the top line and extended by four half-spaces of ledger room above and below. The result is mapped to the entry staff's bottom-line step.
- **Pitch rules:** the same as the inspector staff (`stepPitch`, `enterPitch`, key-signature accidentals, the one-shot accidental), so the two always agree.
- **Ghost note:** while entry mode is on, the pointer shows a translucent notehead and the pitch name on the line or space it would write.
- **When it does nothing:** tab-only staves, slash or hidden notation, percussion, grace beats, a locked or busy document, and places with no score renderer. A click off the notation staff, on tablature, or where no staff position can be read keeps the old selection behaviour. On a staff that cannot take a note (tab-only, percussion, grace beat), a letter or click says why in the entry notice, as does a locked or busy document.

### 3. Keyboard on the score (entry mode on, score focused)

- **Notes:**
  - A to G write that letter on the selected beat, in the octave nearest the previous entered note, which starts at the octave the inspector staff shows.
  - Accidentals and octaves come from GP8's moves rather than the inspector staff's keys, since `+` and `-` mean shorter and longer on the score: Alt+Shift+Up/Down moves the note a semitone (spelled sharp going up and flat going down), and Ctrl+Shift+Up/Down an octave. The inspector staff keeps its accidental and octave keys.
- **Durations:** `+`/`-`, `.`, Ctrl+`.` and `/` change the selected beat's rhythm, with GP8's meaning of `+` and `-`. On a rest they set the entry duration used by the next note.
- **Rest:** `R` makes the selected beat a rest.
- **Moving the selected note:** Ctrl+Alt+Up/Down moves it a staff step, Alt+Shift+Up/Down a semitone, Ctrl+Shift+Up/Down an octave. A pitched note changes pitch in place (`setPitchedNote`) and a fretted note takes a new fret on its own string (`setNote`), so techniques and ties stay; only a fretted note its string cannot reach is removed and written again on the best free string. The spelling joins the same edit.

### 4. Automatic advance (new preference, on by default)

- **Setting:** **Advance after entering a note** joins *Score input* in the View menu.
- **When it acts:** after a note is written by letter or click.
- **Where the cursor goes:**
  - to the next beat in the voice;
  - at the voice's last beat, if the bar still has room, to a new rest beat of the entry duration, inserted in the same edit as the note (`sequence`);
  - otherwise to the first beat of the next bar, if there is one.
- **Chords:** with Shift held, the note is added and the cursor stays.

## Out of scope

- MIDI input.
- Double accidentals, which stay as before.
- Nested tuplets.
- Clicking tablature to write frets: the fret keys already do that.

## Tests

- **Native:** serde and validation tests for `sequence` (allowed set, length, nesting, unknown fields), and replay of an old project.
- **Pure:**
  - `sequence` flattening, undo as one entry, and refusal of a bad sub-command;
  - `scoreEntryHit` against a real alphaTab render, inverting existing noteheads to their steps for treble, bass and a transposed guitar;
  - the advance and duration-key rules.
- **App:** a click writes one edit and undo removes it; letters with advance produce one edit each; an off-key flat is one undo step.
- **Desktop driver** `tests/desktop/parity-score-entry.mjs`:
  - click lines and spaces on the rendered score, and check the notes and the one-step undo;
  - type a melody with advance into an empty bar;
  - change durations with the keys;
  - check that a flat is one undo step.

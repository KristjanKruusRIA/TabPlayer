# U12: enter and delete notes from the instrument view

Date: 2026-10-24. Status: design. Row U12 ("Instrument view click-to-enter/delete notes") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8 lets you write notes by clicking the fretboard, keyboard or drum kit, and delete them the same way. TabPlayer's instrument view (`src/instruments/`) only shows notes: its SVGs are `role="img"` and nothing in them is clickable. This slice makes the view an entry surface for the selected beat. It uses the existing edit commands only, so every click is one undoable native edit, and the protocol does not change.

## Edit mode

- `LiveInstrumentView` gains a checkbox, **"Click to edit notes"**. It is off by default, so the view stays a read-only display unless asked.
- When it is on:
  - The view shows the **selected beat's written notes, read from the score**, not from the playback plan, so marks update as soon as an edit lands. The "Show" select is disabled while edit mode is on, and its value is kept.
  - Click targets appear: one per string and fret, one per key, and one per drum piece. Each is an SVG element with `role="button"`, an accessible name and a pointer cursor.
  - The SVG's role becomes `group`, keeping its label, so its buttons are exposed to assistive technology.
- **Disabled targets:** the targets are disabled, with a one-line hint, when:
  - no beat is selected, or the selected beat is the empty placeholder of an empty bar ("Select a beat in the score to edit it");
  - the controls are busy;
  - the view cannot edit this kind of staff, such as the keyboard on a staff with neither strings nor pitched notes.
- Edit mode does not change while playback runs. The edits themselves follow the usual rules of `edit()`.
- The setting is kept per window in `localStorage`, like the left-handed setting.

## Click rules

All rules act on the selected beat (`target`). Every click sends **at most one** command through `App.tsx` `edit()`, so history, refusal alerts and the edit audition behave exactly as for keyboard entry.

- **Fretboard** (fretted staves): string *s*, fret *f*, with frets 0–24 (or the highest note's fret if higher), relative to the capo as the view already draws them.
  - If the beat has a note on *s* at fret *f*, the click deletes it: `removeNote{string:s}`.
  - Otherwise the click writes the note: `setNote{string:s, fret:f}`. A note already on that string changes fret, as keyboard entry does.
  - Names look like "String 6, fret 3 (G2)", with the sounding pitch. When the note is present, the name is "Remove string 6, fret 3 (G2)".
- **Keyboard:**
  - **Pitched staff** (no strings): sounding key *k*, written pitch *p = k + transpositionPitch*.
    - If a note with written pitch *p* exists, the click removes it with `removeNoteByIndex`.
    - Otherwise it adds the note with `addPitchedNote{pitch:p}`.
  - **Fretted staff:**
    - If a note in the beat sounds *k*, the click removes it with `removeNote` on that note's string.
    - Otherwise it writes `setNote` on the free string that gives the lowest fret from 0 to 24. When no free string can play *k*, the key is disabled and its name says why ("No free string can play C2").
  - Key range: the view's current range, widened to include the selected beat's notes, and at least two octaves around middle C when the beat is empty.
- **Drum kit** (percussion staves):
  - If the beat has a note whose articulation's output key belongs to the piece, the click removes the first such note with `removeNoteByIndex`.
  - Otherwise it adds `addPercussionNote` with the piece's default articulation. That is searched in the track's own articulation table first, then in the standard one. Each table is searched in the piece's key order, which lists its plain hit first, such as 38 for the snare rather than the side stick. When the track has no articulation for a piece, the piece is disabled.
  - Notes on keys outside the kit stay shown as pads. Clicking such a pad removes its note.
- **No-op guard:** a click never sends a command that would change nothing, such as `removeNote` for an absent note.

## Selection after a click

- The beat stays selected.
- On the fretboard, the clicked string becomes the selected string, and its fret the entry fret, so keyboard entry continues from there.
- For pitched and percussion notes, the selected note index follows the added note, or is cleared when the note is removed.

## Acceptance

- **Unit tests:**
  - **Fretboard:** every rule above, including capo, left-handed mirroring of the targets, removing the present fret and changing an occupied string.
  - **Keyboard:** pitched-staff transposition; on a fretted staff, choosing the lowest fret, skipping occupied strings, and disabling an unplayable key.
  - **Drum kit:** custom and standard articulation tables, the default articulation, removal, and a pad outside the kit.
  - **Disabled states**, and that read-only mode is unchanged.
- **App tests:**
  - a click sends one edit, and undo and redo restore it;
  - a refusal shows the alert and adds no history;
  - the edit audition plays for an added note and stays silent for a removal.
- **Desktop:** on a Windows desktop-test build:
  - with edit mode on, enter and delete a fretted note, a pitched note on a keyboard track, and a drum note through the view;
  - each is one native edit, and undo and redo restore the project exactly;
  - an exported GP file reads back the notes;
  - with edit mode off, the view stays read-only.

## Scope

- No new edit command, no chord-shape stamping, and no duration change from the view.
- No dragging to move notes.
- No MIDI input (U16 is a separate row).

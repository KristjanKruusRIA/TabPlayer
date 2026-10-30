# E05: standard notation mouse/keyboard pitch entry

Date: 2026-10-24. Status: design. Row E05 ("Standard notation mouse/keyboard pitch entry") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8 lets you write a note by clicking a line or space of the staff, or by typing its letter, with accidental and octave keys. TabPlayer's score is drawn by alphaTab, which gives no staff-position hit testing, so clicking the score only selects existing notes. This slice adds an **entry staff** to the inspector: a small interactive staff in the selected track's clef that writes pitches into the selected beat. It uses the existing edit commands only, so every entry is one undoable native edit (plus one more when the spelling has to change) and the protocol does not change.

## Behaviour

The panel **Standard notation entry** sits in the inspector's Edit tools.

- **Staff:** the selected bar's clef (G2 treble, F4 bass, C3 alto, C4 tenor; any other clef shows treble), five lines with dashed ledger positions, from six steps below the bottom line to six above the top line (21 targets). Each target is an SVG element with `role="button"` named with its pitch, such as "G4". A note already on the beat is named "Remove G4" and drawn on the staff.
- **Accidental:** four buttons, **Key signature** (default), **Natural**, **Sharp** and **Flat**.
  - Key signature gives the letter the alteration of the bar's key signature, as clicking a staff does in notation software.
  - A choice lasts for one entry, then returns to Key signature.
- **Octave:** buttons and an octave number (0 to 9, starting at 4). Clicking a staff target sets the octave to that note's octave, so the keyboard continues from it.
- **Keyboard,** with the staff focused:
  - A to G enters that letter in the current octave with the chosen accidental;
  - `#` or `+` chooses sharp, `-` flat, `N` natural, `K` key signature;
  - Up and Down move a cursor along the staff (the staff announces it with `aria-activedescendant`), and Enter or Space writes at the cursor. Letters and clicks move the cursor too.
  - Page Up and Page Down change the octave.
  - Held keys do not repeat an entry; a key that arrives while an entry is still being made is reported in the status line.
  - Keys with Ctrl, Cmd or Alt are ignored, and so is every key while the staff is disabled. Because the keys go to the focused staff, they never reach the score's own shortcuts.
- **Status line:** says what was entered or removed, or why nothing happened ("No free string can play E8"). It also carries the disabled hints.

## Pitch rules

All rules act on the selected beat and send at most one command, then at most one spelling command.

- **What the staff draws:** alphaTab draws a note at `real + ottava(beat) + ottava(clef) - displayTranspositionPitch`, where `real` is the sounding key (`fret + string tuning + capo - transposition`, or `octave * 12 + tone - transposition` for a pitched note) and an ottava adds -24, -12, +12 or +24 for 15ma, 8va, 8vb and 15mb. The entry staff inverts this, so a clicked position is stored so that the score shows it at that position: `sounding = written - ottava(beat) - ottava(clef) + displayTranspositionPitch`. A blank-project guitar has display transposition 0 and draws sounding pitch; imported guitars usually have -12 and draw an octave above it. Tests check the result against alphaTab's own `displayValue`.
- **Pitched staff** (no strings): the stored pitch is the sounding key plus the staff transposition, sent as `addPitchedNote{pitch}`. If the beat already has a note at that pitch, the entry removes it with `removeNoteByIndex`.
- **Fretted staff:** the sounding key is entered exactly as the instrument view's keyboard does (`keyTarget`): `setNote` on the free string giving the lowest fret from 0 to 24, `removeNote` when a note of that sounding pitch is present, and a refusal naming the pitch when no free string can play it. The string and fret become the entry string and fret, so digit entry continues from there.
- **Percussion staves** refuse entry with a hint pointing to the drum kit in the instrument view.
- **Spelling:** a pitch has one value, but `C#4` and `Db4` differ on the page. After a note lands, the panel sets its enharmonic spelling with the existing `setNoteSpelling` only when the note's current mode differs from what its letter needs:
  - Default when alphaTab's automatic spelling already reads the entered letter. Automatic spelling prefers the key signature, then a sharp or a flat by the key's kind;
  - ForceNatural, ForceSharp or ForceFlat otherwise: a flat in the key of C, E sharp, C flat, and a natural the key would respell (F in F sharp major reads E sharp, C in C sharp major B sharp, B in G flat major C flat, E in C flat major F flat).
  - Notes already on the beat are drawn at the letter their own spelling mode gives.
  - The spelling edit is made after the first edit has been accepted, and is therefore its own undo step. If it fails, the status says the note was entered with its spelling unchanged.
- **Audition:** the existing edit audition plays the entered note; a removal is silent.

## Disabled states

The staff, accidentals and octave buttons are disabled, with the hint in the status line, when:

- the controls are busy, or the document is finalized (`locked`);
- no beat is selected, or the selected beat is the empty placeholder of an empty bar ("Select a beat in the score to enter notes");
- the staff is percussion.

Selecting and viewing stay usable. A refused edit (`edit()` returns false) says so in the status line, points to the alert, and leaves the accidental and octave as they were. An entry whose note cannot be found afterwards is not reported as entered.

## Acceptance

- **Unit tests:**
  - Staff geometry for every clef, key-signature alterations, and pitch naming.
  - Pitched entry and removal, staff transposition, fretted entry at the sounding pitch, lowest free fret, removal, and the unplayable pitch.
  - Spelling decisions, including flat keys.
  - Panel: click and keyboard entry, one-shot accidentals, octave keys, the spelling follow-up, locked and busy states, percussion, and a refused edit.
- **App test:** a click sends one edit; undo and redo restore it; a finalized document refuses a click and a key.
- **Desktop** (`tests/desktop/parity-notation-entry.mjs`, on a Windows desktop-test build): enter and remove fretted notes by clicking the staff, including a sharp, and a flat that sets its spelling; enter pitched notes by clicking and by keyboard letters with accidental and octave keys; each entry is native edits with exact undo and redo; percussion refuses entry; an exported GP file reads back the notes.

## Scope

- No new edit command and no protocol change.
- No rhythm entry, tie or rest entry, and no automatic advance to the next beat; duration stays in the inspector.
- No drag to move a note, no double sharps or flats, and no note-name entry for percussion.
- No entry from the rendered score itself: alphaTab gives no staff-position hit testing.
- The spelling edit is a second undo step; a single combined command would need a new protocol command.

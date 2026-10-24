# GP8 parity U12: enter and delete notes from the instrument view (2026-10-24)

GP8 lets you write notes by clicking the fretboard, keyboard or drum kit, and delete them the same way. TabPlayer's instrument view only showed notes. This slice makes it an entry surface for the selected beat. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-instrument-entry-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build.

## Behavior
- **Edit mode:** the instrument view has a "Click to edit notes" checkbox. It is off by default and remembered per window.
  - When it is on, the view shows the selected beat's written notes, read from the score, so marks follow every edit, undo and redo at once. The "Show" select is disabled meanwhile, keeping its value.
  - Every string and fret, key and drum piece becomes a button with a spoken name.
  - When it is off, the view is the same read-only picture as before.
- **One click, one edit:** every click sends at most one existing edit command through the normal edit path. Each is one undoable step, with the usual refusal alerts and edit audition. A click never sends a command that would change nothing.
- **Fretboard:**
  - Clicking a string at a fret writes the note there, or moves that string's note to the clicked fret.
  - Clicking the fret a note already sits on removes it.
  - Names give the sounding pitch, such as "String 5, fret 3 (C3)" or "Remove string 9, fret 0 (E4)".
  - Frets are counted from the capo, as the view draws them. Left-handed necks mirror the targets with the picture.
- **Keyboard:**
  - **Pitched track:** clicking a key adds that note, written with the staff's transposition, or removes it if present.
  - **Fretted track:** clicking a key removes the note that sounds it, or writes it on the free string with the lowest fret from 0 to 24. A key no free string can play is disabled and says so ("No free string can play C2").
- **Drum kit:**
  - Clicking a piece removes the beat's note for that piece, or adds the piece's default articulation. The default comes from the track's own articulation table first. Otherwise it is the standard plain hit, such as the snare hit rather than its side stick or rim shot, and the ride's middle rather than its edge.
  - Notes on keys outside the kit appear as pads, and clicking a pad removes its note.
- **Disabled targets:** targets are disabled, with a short hint, when no beat is selected, the selected bar is an empty placeholder, the controls are busy, or the view cannot write to this staff. The keyboard cannot write to a percussion staff, and the drum kit cannot write to a pitched or fretted one.
- **Selection:** the beat stays selected. A fretboard click makes its string and fret the entry string and fret for keyboard entry. A pitched or percussion click selects the added note, or clears the note selection on removal.
- **Keyboard access:** each instrument is one tab stop. The arrow keys, Home and End move between its targets, following the picture on a left-handed neck, and Enter or Space clicks.

## Evidence
- **Unit tests:** `src/instruments/instrument-entry.test.tsx` has 21 tests:
  - **Fretboard:** writing, refretting and removing; names with sounding pitch; capo; left-handed targets and arrows; frets beyond 24.
  - **Keyboard:** pitched transposition on add and remove; two octaves around middle C on an empty beat; the lowest free string and fret on a fretted track; the disabled unplayable key.
  - **Drum kit:** the standard plain hits (kick, hi-hat, ride, snare); a custom table taking precedence; removal; out-of-kit pads; no pad removal on a fretted staff.
  - **Disabled states:** no beat, empty placeholder, busy, and the wrong staff kind.
  - **Other:** read-only mode keeps its images and has no targets; roving focus, Enter and Space.
- **App tests:** `src/App.test.tsx` checks that:
  - a click sends one edit, and Undo and Redo restore it;
  - a refused click shows the alert and adds no history;
  - the edit audition plays for an added note and stays silent for a removal.
- **Type check:** `tsc` was clean.
- **Full test run:** the full `vitest` run passed, apart from timeouts in heavy UI files while a build ran alongside. Those files passed when rerun on their own.
- **Desktop:** `tests/desktop/parity-instrument-entry.mjs` passed on a Windows desktop-test build of the final source. It used the four-track instrument fixture: a 9-string guitar, a 6-string bass, drums and keys. The run:
  - found the view read-only by default, with no targets. Turning edit mode on changed nothing in the project;
  - **fretboard**, on the guitar's first beat:
    - wrote string 5 at fret 3, then moved it to fret 5;
    - removed the open E4 on string 9;
  - **keyboard**, on the keys track's C4 E4 G4 beat: added D4 and removed E4;
  - **drums**, on the kick and crash beat: added the snare through the track's own articulation 2, and removed the kick.

  Each click was exactly one native edit with the expected command. Undo restored the project as it was before, and Redo restored it as it was after.

  At the end of the run:
  - the exported GP file read back the guitar's beat as strings 1, 5 and 8 at frets 0, 5 and 1; the keys as C4 D4 G4; and the drums as snare and crash. The export did not change the project;
  - turning edit mode off restored the read-only view with no targets.

  There were no page errors or IPC fallbacks.

## Review
- **Code review:** an Opus review found no High findings. It confirmed:
  - the string numbering and the capo and transposition arithmetic, which match the edit engine and the edit audition;
  - the choice of a free string and fret for keyboard keys;
  - removal indices;
  - one command per click, and no no-op or predictably refused commands;
  - marks that follow edits, undo, redo and track changes;
  - the selection follow-up, the unchanged read-only mode, the roving focus, the mirroring, and guarded storage.
- **Findings and fixes:**
  - **Medium, fixed:** the Ride piece entered the standard ride's edge, which the catalog lists first, instead of its middle. Standard defaults now prefer the plain hit whose id is the piece's key. The snare lists its hit before its side stick.
  - **Medium, fixed:** on a fretted or pitched staff shown as a drum kit, an out-of-kit pad could delete a guitar or keyboard note. Pads now act only on percussion staves.
  - **Low, fixed:**
    - the kick entered its secondary hit;
    - the keyboard's percussion hint showed in guitar and bass modes;
    - fretboard targets overlapped on 6- and 7-string necks, so a click near one string could reach its neighbour.
- **Second round:** the reviewer checked the fixes and approved them.
  - **Low, kept as a limit:** a track's own articulation table is searched in its file order, so a table that lists a ride's edge before its middle gives the edge.

## Limits
- **Selected beat only:** clicks edit the selected beat. They do not insert a beat, change a duration, or move to the next beat after entry.
- **Empty bars:** a bar's empty placeholder beat cannot be written from the view. Select a written beat, or add one first.
- **One note per click:** chord shapes cannot be stamped in one click, and notes cannot be dragged.
- **Default drum hit:** a piece adds one default articulation. Other articulations of the piece, such as a rim shot, are entered from the editor panel. On a track with its own articulation table, the default is the first entry for the piece's key in that table's order, which may be a variant such as a ride's edge.
- **No MIDI input:** entry from a MIDI device is U16, a separate row.

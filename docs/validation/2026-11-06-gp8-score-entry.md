# GP8 parity E05 and W19: enter notes on the rendered score (2026-11-06)

Before this slice, standard notation entry happened on an inspector staff, with no rhythm entry and no automatic advance, and an off-key note cost two undo steps. This slice brings entry onto the score itself. It follows `docs/superpowers/specs/2026-11-06-gp8-score-entry-design.md` (Linear THE-65). E05 stays partial and W19 stays partial: see Limits.

## Behavior
- **Note entry mode:**
  - It is turned on and off by the **Note entry** button at the start of the main toolbar or the `N` key, with the score focused.
  - Turning it on from the button puts focus on the score.
  - While it is on, the score shows a crosshair, and a hint line lists the keys.
- **Clicking the score:**
  - A click on a line or space of the standard notation staff writes that pitch on the clicked beat.
  - The pitch follows the bar's clef and key signature, with three ledger lines of room above and below.
  - Pointing first shows a translucent notehead with the pitch name. Over a pitch the beat already has, it says "Remove …", and a click removes that pitch.
  - Shift+click adds to a chord and keeps the cursor on the beat.
  - Clicks on tablature or away from the notation staff still select as before.
- **Keyboard on the score:**
  - A to G write the letter in the key signature, in the octave nearest the previous entered note. Shift+letter builds a chord.
  - `+` and `-` make the selected beat shorter and longer, as in Guitar Pro.
  - `.` dots the beat, Ctrl+`.` double-dots it, `/` toggles a triplet, and `R` makes a rest.
- **Moving the selected note:**
  - Ctrl+Alt+Up/Down moves it a staff step, Alt+Shift+Up/Down a semitone (spelled sharp going up and flat going down), and Ctrl+Shift+Up/Down an octave.
  - A pitched note changes pitch in place, and a fretted note takes a new fret on its own string, so techniques and ties stay with it.
  - A fretted note is removed and written again on the best free string only when its own string cannot reach the new pitch.
- **Automatic advance (new input preference, on by default):**
  - After a letter or click, the cursor moves to the next beat.
  - At the last beat of a bar that still has room, the same edit inserts a rest of the entry duration to write into next.
  - Otherwise the cursor moves to the first beat of the next bar.
  - The preference is **Advance after entering a note**, under *Score input* in the View menu.
- **One gesture, one undo:** each gesture is recorded as one history entry, using a new `sequence` edit (below). This covers:
  - an auto-duration rhythm, the note, its spelling and the advance rest;
  - a note move and its spelling;
  - the inspector staff's off-key notes, which used to cost two undo steps.
- **Refusals keep the work:** a pitch no string can play, a locked or busy document, a staff that cannot take a note, and an edit the engine refuses all leave the selection where it was and say why in the entry notice.

## Format change: the `sequence` edit
- **Shape:** `{type:'sequence', commands:[…]}` holds 2 to 8 note-entry steps, from these types: `setNote`, `removeNote`, `setRest`, `setDuration`, `insertBeat`, `addPitchedNote`, `setPitchedNote`, `removeNoteByIndex` and `setNoteSpelling`.
- **No nesting:** a sequence never holds another sequence.
- **Validation:**
  - Rust (`EditCommand::Sequence`) and TypeScript (`validateParityCommand`) refuse the same shapes: count, step types, nesting, unknown fields and each step's own rules.
  - Stored edits are validated before replay flattens them, so a crafted project cannot get around the inner checks.
- **History:** a sequence is one history entry, and one undo removes all of its steps.
- **Replay:** replay applies the steps in order. An added track's identity counts each step, consistently on every replay path.
- **Compatibility:**
  - Old `.tabplayer` projects and edit logs replay unchanged, because nothing that already exists changed meaning.
  - A project that contains a sequence does not open in older TabPlayer builds.
- **Fixture:** `tests/protocol.json` gains a sequence example, and the protocol count is 84.

## Evidence
- **Rust:**
  - `cargo test --lib --test protocol --test project_history`: 449, 5 and 12 passed, none failed.
  - The new protocol test checks that a sequence holds 2 to 8 note-entry edits and never nests.
  - `cargo fmt --check` was clean.
- **Frontend:**
  - `tsc` was clean.
  - The new and changed unit tests pass:
    - `src/sequence-command.test.ts`: replay equivalence, one history entry, refusals, a failing step failing the whole sequence, and the one-time preview reuse;
    - `src/editor/score-entry.test.ts`: keys, durations, the letter octave, advance and inserted rests, removal, refusals, and moves that keep techniques and ties or change string;
    - `src/engraving/score-entry-hit.render.test.ts`: real alphaTab renders at scales 1 and 1.5;
    - the new App and inspector-staff tests.
  - **Hit test:** every notehead within three ledger lines inverts to its own beat and staff step (9 of 13 in the fixture; the other 4 lie further out). Tablature and the space past the ledger room return nothing.
  - **Full suite:** in one run, 48 of 5,343 tests failed.
    - 36 failures read `.analysis/compatibility` fixtures, which a worktree does not have.
    - The other 12 were 5-second timeouts while a reviewer ran its own tests on the same machine.
    - Rerun with less load, the timed-out files passed alone. Two of the slowest App tests take the same time on this branch as on `develop` (3 tests in 15.1 s against 15.7 s, and 1.83 s against 1.88 s).
- **Desktop:** `tests/desktop/parity-score-entry.mjs` passed on a Windows desktop-test build. The run:
  - turned note entry on from the toolbar and read the hint;
  - hovered six lines and spaces from C4 to A5 and read the ghost labels;
  - clicked the G line: one `setNote` edit, the cursor moved on, and one undo removed it;
  - typed c, d, e, f and g: five edits running on across the barline into bar 2;
  - pressed `+` and `.`: one edit each;
  - moved the G down a semitone: one edit, the fret on the same string plus a flat spelling, which one undo took back;
  - turned entry off with `N` and saw letters write nothing;
  - saw no page errors.
  - Screenshots `score-entry-ghost.png` and `score-entry-after.png` were checked by eye. They are generated output and are not committed.

## Review
- **First review:** a fresh-context Opus review covered the `sequence` schema, replay and the planner.
  - **Clean:** TypeScript and Rust agree on what a sequence may hold. Inner validation can't be bypassed. Lock checks, undo and redo, settings replay, library metadata and recovery all handle it.
  - **High, fixed:** a note move was a remove plus an add, which dropped the note's techniques and broke its ties. Moves now change the note in place.
  - **Medium, fixed:** each entry built the whole document twice, once to plan and once to record. The controller now reuses the planned build once, when it records exactly that edit on the same project.
  - **Medium, fixed in the spec:** the spec promised the inspector staff's accidental keys on the score. Those keys clash with GP8's `+` and `-` for duration, so accidentals and octaves come from GP8's semitone and octave moves, and the spec now says so.
  - **Low, fixed:**
    - the hover preview re-rendered on every mouse move;
    - the toolbar toggle kept focus;
    - two comments were stale or misplaced;
    - an unused message was removed.
- **Second review:** a fresh-context Opus review checked the preview reuse and the new note move. It found nothing serious, and three low-severity items, all fixed:
  - the controller's own build stayed kept after it became live state; it is now dropped;
  - a move re-spelled only the selected note of a tie chain; the tied notes now get the same spelling in the same edit;
  - a fretted move did not check tied beats for the new pitch; it is now refused when one already holds it.
- **After the fixes:** the editor, engraving, engine, controller, App and workspace tests passed (1,853 passed, 1 skipped) at a 20-second timeout, and the desktop driver passed again on a rebuilt app.
- **Desktop:** the desktop run also caught the toggle's label spilling out of its 34-pixel toolbar button. The button is now an icon with a screen-reader name, like its neighbours.

## Limits
- **Why E05 stays partial:**
  - There are no double accidentals.
  - On the score, an off-key note takes a letter plus a semitone move, rather than an accidental key.
  - Fast typing can still drop a key while the previous entry is being recorded: the busy notice says so, as fret entry already does.
- **alphaTab internals:** the hit test reads alphaTab 1.8.4's internal layout (`getRendererForBar`, `getScoreY`). The version is pinned, and the render test guards the API.
- **Advance:** the rest that automatic advance inserts takes the entry duration, and only when the bar still has room. Otherwise the cursor moves to the next bar, and on the last bar it stays.
- **Not done:** MIDI input, nested tuplets, and clicking tablature to write frets (the fret keys already do that).
- **Why W19 stays partial:** the complete documented GP8 keyboard workflow is still incomplete. This slice adds note-entry keys and the advance preference.

# GP8 parity W22: expression text and searchable action list (2026-10-23)

GP8's command palette accepts expression text, such as dynamics, time and key signatures, clefs, directions and chord names, typed without a command, and lists the available actions with their shortcuts. This slice adds expression text and shortcut labels to TabPlayer's command palette (W18). It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Expressions:** Ctrl/Cmd+Shift+P opens the palette. Text typed without a command is read as an expression and run with Enter. It is the first option, except after commands whose title holds every typed word, so `p` still offers Play or pause first and `f` Set fret. Each expression is a single undoable edit at the edit target:
  - **Dynamics:** `ppp` to `fff`, `sfz`, `fp` and the other alphaTab dynamics set the dynamic of the note at the edit target's string, or of the beat's only note. Notes keep their own dynamics, as in the inspector.
  - **Time signature:** `3/4`, `6 / 8` and similar set the target measure's time signature, keeping its pickup, repeats, endings, section, section marker and tempo changes. Up to 32 beats of 1, 2, 4, 8, 16, 32 or 64.
  - **Section:** `[Chorus]` names the section that starts at the target measure. Common time (C) stays when the time is unchanged.
  - Time and section expressions are refused on a measure with a tempo change between beats or with a text label, which the measure edit cannot rebuild exactly.
  - **Key:** `Eb major`, `F# minor` and similar set the key of the target measure on the current staff. Keys beyond seven sharps or flats are refused, with the enharmonic key to use instead. Percussion tracks refuse keys.
  - **Clef:** `treble`, `bass`, `alto`, `tenor`, `neutral` or `percussion` set the target measure's clef on the current staff.
  - **Directions:** `Segno`, `Coda`, `Fine`, `D.C.`, `D.S. al Coda`, `To Coda` and the other repeat directions are added to the target measure. They are matched without dots or case, so `ds al coda`, `D.C.al Fine` and GP's `Da Coda` also work. A measure takes one jump: a second jump is refused.
  - **Chord names:** `Am7`, `G/B`, `C#m7b5`, `Bbsus4`, and spellings such as `CM7`, `Cmin`, `C-7`, `C+`, `C°` and `am7`, put a chord on the target beat.
    - It gets the most playable diagram within 12 frets that has the root, or the written bass, as its lowest note. When no such shape exists, it uses the most playable inversion; when no shape fits at all, only the name is shown.
    - Percussion tracks and empty placeholder beats refuse chords.
- **Validation:** an expression that cannot apply is shown with the reason and cannot run. Examples:
  - a time signature the measure's music would overfill;
  - a value that is already set;
  - a dynamic on a rest;
  - an empty section name.
- **Action list:**
  - An empty palette lists every command.
  - Commands that have a keyboard shortcut show it beside their name: Undo, Redo, Play or pause, New score, Open score, Save, Save As and Help topics. It shows Cmd on macOS and Ctrl elsewhere.
  - Typing narrows the list by word prefixes, as before.
  - The placeholder and the no-match message give expression examples.

## Evidence
- **Expressions** (`src/editor/expressions.test.ts`):
  - command ranking for `p`, `f` and `a`, chord spellings and root-position diagrams, `Da Coda`, `D.C.al Fine`, `sfz` and `EB major`;
  - refusals for tempo changes between beats or with labels, a second jump, percussion chords and keys, and empty beats;
  - common time and the section marker kept through a section edit; a chord-note dynamic kept through a JSON rebuild while the other note keeps its own;
  - every kind of expression builds the expected edit, and is offered before commands; ordinary commands still match;
  - refusals for bad and overfilling time signatures, values already set, out-of-range keys, an empty section, a dynamic on a rest and a repeated direction; a new direction keeps the existing ones;
  - fret, dynamic, time, key, clef, direction, section and chord expressions applied in turn through `previewEdit` on a real document, with the built score checked;
  - shortcut labels on the commands that have them.
- **Palette UI** (`src/editor/CommandPalette.test.tsx`): a shortcut appears in the option text; a typed `ff` is the first option and Enter runs its edit; the no-match message.
- **Measure settings:** `MeasurePanel` now reads its values through the shared `readMeasureSettings`, and its existing tests pass.
- **Desktop:** `tests/desktop/parity-expressions.mjs` on a Windows desktop-test build:
  - `save` shows Save with Ctrl+S;
  - `3/4` on a full 4/4 measure is explained and Enter does nothing;
  - `ff`, `[Verse]`, `D.S. al Coda`, `bass`, `G major` and `Am` run as six undoable edits with the expected values;
  - the chord name and section are engraved;
  - Ctrl+Z removes the chord again;
  - no page errors.
  - `parity-command-palette.mjs` still passes.
- **Verification:**
  - full `vitest`: 3,421 tests. The load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files pass when run alone;
  - `tsc`.

- **Review:** an adversarial review found these problems, fixed as described:
  - the expression hid commands such as Play (`p`) and Set fret (`f`);
  - chords were placed in inversions, such as `Am7` with E in the bass;
  - common spellings like `CM7`, `Cmin`, `C+` and `am7`, other dynamics, `Da Coda` and `D.C.al Fine` were not read;
  - section and time expressions could move or refuse tempo changes between beats, and dropped common time and section markers;
  - a second jump could be added to a measure, percussion tracks took chords and keys, empty beats took invisible chords, and `EB major` was misread;
  - the shortcut ran into the option's spoken name; it is now spaced and exposed with `aria-keyshortcuts`;
  - titles now say that keys and clefs apply to one measure of the current staff.

  The review also asked for a beat-wide dynamic. It was not made: existing tests require notes to keep their own dynamics, and adding a beat-level edit needs a native protocol change. The fixes were checked by the tests above, not by a second review.

## Limits
- W22 is partial:
  - a key or clef applies to the target measure of the current staff only, not to every track or the following measures;
  - a time signature applies to the target measure only;
  - a dynamic applies to one note, not to every note of a chord, and alphaTab engraves the beat's dynamic, so a single changed note in a chord may not show a new mark;
  - no tempo, text, lyric, articulation or effect expressions;
  - chord names cover the standard formulas only, with no added alterations, omissions or extensions beyond 13;
  - the action list holds the palette's commands, not every menu item;
  - no original-GP8 comparison.

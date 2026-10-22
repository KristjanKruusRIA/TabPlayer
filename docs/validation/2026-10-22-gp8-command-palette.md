# GP8 parity W18: command palette with typed commands (2026-10-22)

GP8's command palette finds a command by typing and runs it with its value. This slice adds a palette for TabPlayer's most common editing, navigation and file commands. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Opening:**
  - Ctrl/Cmd+Shift+P from the workspace opens the palette. It also opens from the "Open command palette" button in Help, which lists the shortcut.
  - The shortcut is ignored while another dialog or the export, harmony or scale tools are open.
- **Finding a command:**
  - Words match command titles and aliases by prefix, in any order, so "meas app" finds Append measure.
  - Commands whose title holds the typed words come first.
  - One trailing number or fraction is the command's value; "1 / 8" is read as "1/8".
- **Commands:**
  - Go to measure n.
  - Go to track n, which keeps the current measure.
  - Set fret n on the selected string.
  - Set duration (1–64, or 1/n).
  - Set initial tempo (1–999 BPM, decimals allowed).
  - Insert beat, Delete beat and Make rest.
  - Append measure and Remove measure.
  - Undo and Redo.
  - Play or pause.
  - New, Open, Save, Save As and Export.
- **Validation:**
  - Each match shows either its example or why it cannot run, such as a measure out of range, a fret on a drum track, a fret above MIDI pitch 127, no selected beat, nothing to undo, or two separate numbers.
  - Matches that cannot run are marked unavailable, and Enter or a click does nothing.
  - While another operation runs, nothing can be run and the palette says so.
- **Running:**
  - Edits go through the same undoable edit path as the inspector.
  - Moves clear any range selection, as clicking does.
  - The palette closes and returns focus to where it was opened, or to the score.
- **Keyboard:**
  - The arrow keys move through matches, wrap around, and scroll the active match into view.
  - Enter runs the active match, except during IME composition.
  - Escape closes the palette.
  - Tab and clicks keep focus in the command field.

## Evidence
- **Frontend:**
  - `src/editor/command-palette.test.ts`:
    - the full command list, prefix narrowing, and title-before-alias ranking;
    - edits and moves built from typed values, including decimal tempo, a spaced fraction, and track moves that keep the measure;
    - errors for missing, out-of-range, negative and repeated values, for frets above MIDI 127 on each string, for drum tracks and empty beats, and for an empty redo;
    - a round trip in which every palette edit is applied in turn through the engine's `previewEdit` on a real blank document.
  - `src/editor/CommandPalette.test.tsx`:
    - focus on open;
    - Enter runs the match and closes first;
    - arrow navigation with `aria-activedescendant`;
    - unavailable matches do nothing on Enter or click;
    - the list is hidden when nothing matches;
    - Tab keeps focus;
    - the busy state blocks running.
  - RED log: `.analysis/parity/command-palette-red.log`.
- **Desktop:** `tests/desktop/parity-command-palette.mjs` on a Windows desktop-test build:
  - from the score, Ctrl+Shift+P focuses the command field;
  - "fret 7", "duration 8" (tuplet 1/1 accepted natively), "go to measure 3" and "tempo 90" run as edits or moves;
  - "measure 9" is explained and keeps the palette open;
  - Escape returns focus to the score;
  - "undo" removes the tempo edit;
  - audio stays ready with no page errors.
- **Verification:**
  - full `vitest`: 3385 tests. The load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files pass when run alone;
  - `tsc`.
- **Review:** an adversarial review found eleven problems, all fixed:
  - duration commands sent alphaTab's -1 tuplet values, which the engine refuses; the round-trip test covers this;
  - focus went back to the opener after a command's own dialog took it;
  - the time-signature command rebuilt measure settings from rendered data, which could drop tempo markers. It was removed;
  - "remove" ranked Delete beat above Remove measure;
  - separate numbers were merged, and negative values were not explained;
  - Tab and clicks could leave the modal;
  - Go to track jumped to measure 1;
  - moves kept an old range selection;
  - the shortcut opened over the export, harmony and scale tools;
  - the active match did not scroll into view;
  - smaller issues: integer-only tempo, frets above MIDI 127, the tempo command's name, Enter during IME composition, and an empty listbox.

## Limits
- W18 is partial:
  - the palette has a fixed set of commands, not GP8's full command list;
  - there are no time-signature, key, dynamics, articulation or effect commands;
  - commands take one value, with no multi-step parameters;
  - the tempo command sets the initial tempo, not a tempo marker at the cursor;
  - no recently-used ordering;
  - no original-GP8 comparison.

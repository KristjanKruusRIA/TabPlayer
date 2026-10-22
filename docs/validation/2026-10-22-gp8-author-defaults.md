# GP8 parity L06: author defaults for new scores (2026-10-22)

GP8's My info preferences fill a new score with the user's author details. This slice adds the same for scores created with New. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Inspector → Presentation → New score defaults:**
  - Fields: Default artist, Default lyrics author, Default music author, Default transcriber, and Default copyright, each up to 1000 characters.
  - "Save defaults" stores them for later sessions.
  - "Use this score’s details" copies the open score's details into the form. It shortens long ones without splitting a character and says so.
  - Saving never changes the open score.
  - If storage refuses the write, the defaults still apply until TabPlayer closes, and the panel says so.
- **New:**
  - Every score created with New (or Ctrl+N) starts with the defaults. The artist goes into the blank score itself; the other details go into one baseline metadata edit.
  - The new score has no undo step, is not marked unsaved, and keeps the title "Untitled".
  - The details survive save, reopen and GP export.
  - Opened files and library templates keep their own details.
- **Native contract:** `new_document` takes `defaults {artist, words, music, tab, copyright}` with no other fields allowed. Each value is limited to 1000 UTF-16 units, and a call without defaults still makes a plain blank score.
- **Discard on close:** a never-saved new score whose only baseline is this metadata is still dropped from recovery, exactly like a plain blank score.

## Evidence
- **Frontend:**
  - `src/workspace/author-defaults.test.ts`:
    - the preference round-trips;
    - damaged or oversized storage is cleaned on read;
    - unavailable storage is handled;
    - the session fallback applies after a refused write;
    - no half character is ever stored.
  - `src/editor/AuthorDefaultsPanel.test.tsx`:
    - saving sends all five fields and leaves the score alone;
    - copying from the score works;
    - a failed save is reported;
    - copying shortens long details at a character boundary and announces it;
    - every field is described by the help text.
  - `src/workspace/bridge.test.ts`: New sends the defaults.
  - RED log: `.analysis/parity/author-defaults-red.log`.
- **Rust:**
  - `tests/new_score_defaults.rs`:
    - defaults fill the blank base and one baseline metadata edit, with no undo step;
    - empty defaults equal the plain blank score, and an artist alone needs no edit;
    - the limit is counted in UTF-16 units and the shape is strict.
  - `session_runtime_tests.rs`: a discarded new score that carries defaults is dropped on close.
- **Desktop:** `tests/desktop/parity-author-defaults.mjs` on a Windows desktop-test build:
  - the opened GP file keeps "Fixture Artist" and "Fixture Tab" after defaults are saved;
  - New fills Artist, Lyrics author, Music author, Copyright and Transcriber, with no edits, one `setScoreMetadata` baseline, and Undo disabled;
  - GP export reopens with all five details.
- **Verification:** these all pass:
  - full `vitest`: 3365 tests. The load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files pass when run alone;
  - `tsc`;
  - full `cargo test`;
  - rustfmt on the changed files.
- **Review:** an adversarial review found no blocking defects and six smaller issues, all fixed:
  - the panel text over-promised for the startup tab;
  - cutting a long value could split a character and make every New fail;
  - discarded new scores with defaults came back after restart;
  - storage was read on every render;
  - copied details were shortened silently;
  - the help text was not linked to the fields.

## Limits
- L06 is partial:
  - the score shown at startup, and the blank tab left after closing the last one, are created natively and do not use the defaults;
  - the defaults live in WebView storage, not native preferences;
  - no default title, album or notices;
  - no original-GP8 comparison.

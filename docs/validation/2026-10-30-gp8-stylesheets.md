# GP8 parity D13: save and reuse personal engraving styles (2026-10-30)

GP8 can save a stylesheet and apply it to other scores. TabPlayer's engraving settings belonged to one document. This slice adds a personal style library. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-stylesheets-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build.

## Behavior
- **What a style holds:** a document's stylesheet, notation settings and system spacing. It leaves out staff profiles, which name one score's tracks.
- **Saved styles:** a disclosure in the Engraving panel saves, updates, deletes and applies styles. They live in `style-library.json` in the app data folder, and work in every document.
- **Applying:** one existing `setEngraving` edit, so it is one undoable step that changes no music and keeps the document's own staff profiles. Nothing is sent when the result would match the current style.
- **Force default style:** applies the factory style the same way.
- **Unapplied changes:** Apply and Force default are disabled, with a hint, while the form has unapplied changes. Save stores the style applied to the document, not the form.
- **Library safety:** writes are atomic and strictly validated. A damaged file is reported and never rewritten. The library is read only when the disclosure is first opened, so opening a score creates no file.

## Evidence
- **Rust:** 804 tests passed across the merged branch, none failed, including 5 `style_library` tests.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 136 of 136 alone at a 60-second timeout, and the engraving, harmony, MIDI import and score view files passed 587 of 587.
- **Desktop:** `tests/desktop/parity-stylesheets.mjs` passed on a Windows desktop-test build of the merged source, with app data in a test folder. The run:
  - saved a style from one document without editing it, and the style held no staff profiles;
  - restarted and opened a different document with its own staff profile;
  - applied the style as exactly one more edit. The profile stayed, the exported score matched in everything but its stylesheet, and the drawn score changed;
  - undid and redid it exactly, then did the same for Force default style;
  - damaged the library file: the panel reported it, a save failed with its own alert, and the file stayed byte for byte.

## Review
- **Code review:** an Opus review found no High findings. It confirmed atomic writes, strict ids, name handling that agrees between Rust and TypeScript, one edit per apply, and that a style holds no track reference that could be refused on another document.
- **Findings and fixes:**
  - **Medium, fixed:** "Applied" appeared before the edit was known to succeed. `edit()` in `App.tsx` now returns whether it was accepted.
  - **Medium, fixed:** the driver proved staff profiles and music only weakly. It now uses two documents and compares whole scores.
  - **Medium, fixed:** applying a style silently lost unapplied form edits.
  - **Low, fixed:** controls left enabled during library work, a misleading message on a damaged library, and a no-op compare that sent an edit.
- **Re-review:** found a save error hidden behind the read error, and a post-edit failure reported as a refusal. Both were fixed.
- **Desktop run:** the first runs failed in the driver, not the feature. It waited for a closed disclosure, matched a wrapped select by label, and hashed only the first SVG tile. All three were fixed.

## Limits
- **Not in a style:** page layout and headers and footers, which are a separate `setPageLayout` edit.
- **No file exchange:** no style import or export, and no automatic style for new documents.
- **"Force defaults" reading:** the row is met by a Force default style action, not an automatic default.
- **While finalized:** the whole Presentation section is disabled, so saved styles cannot be saved or deleted from a finalized document either.
- **Schema:** a new `EngravingOverrides` field needs a library version bump, or existing libraries read as damaged.

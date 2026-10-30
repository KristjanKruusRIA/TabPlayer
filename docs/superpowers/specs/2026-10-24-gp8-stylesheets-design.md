# D13: save, load and reuse a stylesheet, and force defaults

Date: 2026-10-24. Status: design. Row D13 ("Save/load/reuse stylesheet and force defaults") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8 keeps a stylesheet per score and lets you save it, load it into another score, and reset a score to the defaults. TabPlayer's Engraving panel (`src/engraving/EngravingPanel.tsx`) edits one document's stylesheet, notation and system-spacing overrides, but nothing outlives the document. This slice adds a **personal style library** in the app data folder, so a style authored in one score can be applied to any other, and a **Force default style** action.

The row's acceptance is "Save personal style and apply across documents without changing music". Applying a style is one existing `setEngraving` edit, so it is one undo step, and the protocol does not change.

## What a style is

A style is the `EngravingOverrides` of a document **without its `profiles`**: the stylesheet choices (dynamics, brackets, track names, bar numbers, multiple rests, empty staves, and so on), the notation choices (tab rhythm, fingering, bend options) and the system spacing. Staff profiles name tracks of one score, so they are never stored in a style and never replaced by applying one.

Page layout and header and footer are not part of a style. They are separate edits (`setPageLayout`), so folding them in would turn an apply into two undo steps or need a new edit command, which the slice avoids.

## Storage

- One file, `style-library.json`, in the app data folder, next to `tuning-library.json`. Native module `src-tauri/src/style_library.rs`, modelled on `tuning_library.rs`:
  - Envelope `{format:"tabplayer-style-library", version:1, entries:[{id,name,engraving}]}`.
  - Entries are validated on every read and write: UUID identity (case-insensitive and distinct), a name that equals its trim, 1 to 80 characters of XML text, and an `engraving` that deserializes strictly (`deny_unknown_fields`, closed enums) and passes `EngravingOverrides::validate` with no profiles.
  - Writes are serialized and atomic through `files::write_bytes`. A missing file reads as empty and is not created by reading. A damaged file is an error everywhere, and is never rewritten: reads, puts and removes leave its bytes alone.
- Commands `style_library_read`, `style_library_put`, `style_library_remove`. They use the tuning library's folder rule, so a desktop-test build with `TABPLAYER_DESKTOP_TEST=1` requires an absolute `TABPLAYER_TEST_APP_DATA_DIR` and never touches the user's real folder.
- `src/engraving/style-library.ts` mirrors `src/tuning/library.ts`: strict client-side validation, one serialized queue, success-only subscriber notification, structured clones in and out. It reuses the tuning library's XML text check.

## Behaviour

A **Saved styles** disclosure inside the Engraving panel (`StylePresetsPanel.tsx`):

- It reads the library the first time it is opened, so opening a score never reads or creates the file. A read failure shows "Could not read saved styles: …" and the rest of the panel keeps working.
- **Save current style** stores the document's *applied* engraving (not unapplied edits in the form) under the typed name, as a new entry with a new UUID. The name is trimmed; an invalid name disables the button and says why.
- **Update saved style** replaces the selected entry's style with the document's current one, and renames it when a name is typed.
- **Delete saved style** removes the selected entry. A style already applied to a document is a snapshot and is not affected.
- **Apply saved style** sends one `setEngraving` with the saved style and the document's own profiles (only those of its live tracks). It sends nothing when the result equals the current engraving, and says so. The edit goes through `edit()`, so history, the busy rule and refusal alerts behave as for the Apply engraving button. It changes no score content, track, mix, sound, page layout or other setting.
- **Force default style** applies the factory style (every choice "Source/default", spacing blank) the same way, keeping the document's profiles. The existing "Reset to source/default" button still also clears profiles.
- Library actions are disabled while the panel is busy and while one is running.

## Acceptance

- **Unit tests:**
  - **Native:** empty and missing store, save, replace by case-insensitive identity, rename, delete, invalid names, ids, spacing and profiles refused without changing the file, a table of damaged files that stay byte for byte, and neighbouring files untouched.
  - **Client library:** exact commands and payloads, validation before any native call, damaged replies rejected, queue and subscriber behaviour.
  - **Panel:** lazy read, save without profiles, apply as one edit keeping the target's profiles, score JSON unchanged and every other setting unchanged by `applySettingsEdit`, no-op guard, force default, update and delete, refused write, and the panel's presence and busy state in the Engraving panel.
- **Desktop** (`tests/desktop/parity-stylesheets.mjs`, written but run by the controller): on a Windows desktop-test build with isolated app data:
  - author a style in one document and save it; the file holds the entry and the document is not edited;
  - after a restart, open another document and apply it: one `setEngraving` edit equal to the stored style, undo and redo restore the project exactly, and exported GP notes are unchanged at every step;
  - Force default style is one undoable edit;
  - a damaged library is reported and its bytes are unchanged after a failed save;
  - the real user library is untouched.

## Scope

- No new edit command and no change to `tests/protocol.json`.
- No page layout or header and footer in styles, no export or import of style files, no automatic application to new documents, and no per-track styles.

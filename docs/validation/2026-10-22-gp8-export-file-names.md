# GP8 parity D20 slice 1: export file-name tokens (2026-10-22)

GP8 (manual pp.229–232, PDF and PNG export pages) names graphical exports with a "File name" field. Its tokens are %T score title, %t track name, %n track number, %N track count, %d date and %h time, and a preview shows the result. TabPlayer now has this field for every file export. This slice was implemented on branch `feat/gp8-parity`.

## Behavior
- **Export dialog:**
  - Every format except Print has a File name field, defaulting to `%T` (the score title). A hint lists the tokens.
  - A live preview shows the name that will be saved. The extension is appended only when the name doesn't already end with it.
  - SVG and PNG note that several pages get `-1`, `-2` and so on before the extension.
  - The preview time refreshes while the dialog is open.
  - Options carry `fileName` only when it differs from the default.
- **Tokens (`src/export/file-name.ts`):**
  - `%%` gives a literal `%`, and unknown tokens stay literal.
  - Track tokens describe the first selected track. `%N` counts every track in the score.
  - The date is local `YYYY-MM-DD` and the time `HH-MM`. An empty title becomes `Untitled`, and an empty track name becomes `Track n`.
- **Safety:**
  - Path, control and invisible direction or format characters become `-`, including U+202E, which could otherwise disguise `Report\u202efdp.wav` as a PDF.
  - Leading and trailing spaces and dots are removed, and Windows device names (including COM¹–³ and LPT¹–³) get a `_` prefix.
  - Names are cut at whole characters to 200 UTF-8 bytes, which leaves room for an extension and page number within the 255-byte limit.
  - An empty result becomes `TabPlayer-export`.
- **Export:**
  - The coordinator expands the template at run time from the frozen score copy and the selection.
  - It passes the name to every native file export (GP, PDF, SVG, PNG, MIDI, MusicXML, mixed WAV and stems).
- **Native:**
  - `suggested_name` re-validates the name with the same rules, and any invalid name falls back to the previous default. The result pre-fills the OS save dialog, where the user can still change the name and folder.
  - A desktop-test-only `TABPLAYER_TEST_EXPORT_DIR` (compiled under the `desktop-test` feature) places the file under that name with the production extension rule.

## Evidence
- **Frontend:**
  - Token, sanitizing, byte-limit, invisible-character, reserved-name and extension tests are in `file-name.test.ts`.
  - The dialog test covers the field, the preview with fake time, omitting the default, no field for Print, and the stems preview.
  - The coordinator matrix asserts the expanded name for every format. A run-time expansion test checks the frozen copy and selection.
  - Bridge payloads are tested for every command, including GP with and without a name.
  - `tsc` is clean, and the export, workspace, App, interchange and controller suites pass (1167).
- **Native:** `cargo test --lib` passes, 265 tests. The `suggested_name` and `gp_dialog_name` tests cover covers safe names, a dotted name, the byte limit, path and control characters, invisible marks, reserved names and the fallback, plus a GP name that already ends in `.gp`.
- **Desktop (Windows desktop-test build):** `tests/desktop/exports.mjs` passes all 10 cases. The new named case fills `%T - %t. (%n of %N) %d` and reads the preview. It then asserts that the only file in a fresh folder has exactly that name, and that the output is a PDF with the document unchanged.
- **Review:** an Opus adversarial review took 2 rounds and approved. Round 1 found the following, all fixed:
  - names could exceed the 255-byte limit on Linux and macOS;
  - the preview did not match the saved name when the name ended in the extension, or for numbered pages;
  - the test hook replaced the extension instead of appending it;
  - the two sides disagreed on reserved names;
  - invisible direction marks could disguise a file type;
  - the preview time went stale;
  - test gaps.

  Round 2 found the GP save dialog appending `.gp` twice. That was fixed with a tested `gp_dialog_name`, after the desktop run, which doesn't exercise the GP dialog.

## Limits
- One file per track is not done yet. Track tokens use the first selected track, so a multi-track export is still one file per format (slice 2).
- GP8's separate destination-folder field and "open folder" option are not reproduced; the OS save dialog chooses the folder.
- GP naming through the dialog is covered by unit and bridge tests only. The desktop GP path uses the separate test I/O hook.
- The time in the preview can differ from the saved name by up to 15 seconds.

# GP8 parity D20 slice 2: one file per track (2026-10-22)

GP8 (manual pp.229–232) can export each track of a score as its own graphical file. The file is named from the File name template, where %t and %n describe that track. TabPlayer now offers this for PDF, SVG and PNG. This slice builds on slice 1 (file-name tokens) and was implemented on branch `feat/gp8-parity`.

## Behavior
- **Dialog:**
  - PDF, SVG and PNG show a "One file per track" checkbox. When ticked, a note explains that each selected track is saved as its own file in a chosen folder.
  - Ticking it changes the default name `%T` to `%T - %t`, so every file says which track it holds. Unticking it restores `%T`, and an edited name is kept.
  - The options carry `perTrack: true` only when the box is ticked.
- **Coordinator (`useExportCoordinator.ts`):**
  - Each selected track is rendered alone, in track order, with the measure range and engraving settings, and keeps its own staff selection only when it has a partial one.
  - All names share one timestamp. A name whose saved files would repeat gets the track number, ` (3)`, then ` (3-2)` and so on, until every final file name is unique ignoring case and Unicode form. "Final" includes the extension and SVG/PNG page numbers (`savedFileNames`, which mirrors the native `page_paths`).
  - It yields and checks Cancel before each track. SVG and PNG get the white page background unless Transparent background is chosen.
  - The PNG pixel budget is checked across all tracks before the folder dialog.
- **Native (`export_track_files`, `export/tracks.rs`):**
  - A folder is picked once. The command accepts:
    - 1–64 tracks with 1–2000 pages in total;
    - names that the native rules leave unchanged;
    - only PDF, SVG or PNG (PNG needs a resolution).
  - It checks the PNG budget across all tracks and converts every file before writing any. Multi-page SVG/PNG are numbered `-1`, `-2` and so on, and two tracks that would produce the same path are refused.
- **Writing (`export_document_files` with `new_only`, and any multi-file export):**
  - Every file is first created with `create_new`, so the file system itself refuses an existing file, a dangling link, or a name it treats as the same (case, Unicode form or a short-name alias).
  - Contents are written and synced only after every file was created. On any failure, only the files this export created are removed.
  - A single file confirmed in a save dialog still uses the atomic replace.
- **Test hook:** `TABPLAYER_TEST_EXPORT_DIR` stands in for the folder picker. It exists only in desktop-test builds.

## Evidence
- **Frontend:**
  - Dialog test: the checkbox for PDF, SVG and PNG only, the note, the option sent only when ticked, the default-name switch that keeps edited names, and leaving the page formats turns per-track off.
  - Coordinator tests:
    - each track rendered alone with its range and staves;
    - a partial staff selection kept only for its own track (validated with `validateSelection`);
    - names deduplicated against final files (`A (3)`/`A`/`A`, `Lead`/`Lead.svg`, a two-page `Song` vs `Song-1`, and two PDF `Guitar` tracks with different page counts);
    - the PNG background and resolution, PDF pages untouched with no PDF job;
    - the PNG budget across tracks;
    - Cancel between tracks, with nothing saved.
  - Unit tests: `savedFileNames`/`fileKey`, plus a bridge test for `export_track_files`. Each new coordinator test failed when its fix was reverted.
  - `tsc` is clean. The export, workspace, App, tuning, interchange and controller suites pass (1202 tests).
- **Native:** `cargo test --lib` passes (269 tests, 4 ignored).
  - `tracks.rs`: names, page numbering, PDF/SVG/PNG bytes, the refused names (path, reserved, trailing dot, U+202E), formats, counts, the cross-track PNG budget and case-insensitive path collisions.
  - `lib.rs`:
    - an existing file is refused even for one output in a picked folder;
    - a failed later write removes the earlier files;
    - on Windows, `lead.pdf` and `LEAD.pdf` in one export are refused by the file system with nothing left behind.
- **Desktop (Windows desktop-test build):**
  - `tests/desktop/exports-per-track.mjs` opens a four-track fixture and exports PNG (72 dpi, transparent) and PDF with the name `%n %t` into fresh folders.
  - It asserts exactly `1 Guitar9`, `2 Bass6`, `3 Drums` and `4 Keys` (numbered only for extra pages) with valid signatures, RGBA PNGs whose top-left pixel is transparent, and the document unchanged.
  - `tests/desktop/exports.mjs` still passes all 10 cases.
- **Review:** an Opus adversarial review. Round 1 found the following, all fixed:
  - a crash when only some tracks had a partial staff selection;
  - check-then-replace writes that could overwrite an existing or aliased file;
  - name deduplication that ignored extensions and page numbers;
  - no cancel between tracks;
  - a vacuous transparency check;
  - an uninformative default name.

  Round 2 found PDF names still deduplicated as if pages were numbered, and the per-track default name staying on after switching to a single-file format. Both were fixed with tests. Round 3 approved.

## Limits
- D20 stays partial.
- GP8's separate destination-folder field, its "open folder" option and an overwrite choice are not reproduced. Exporting again into the same folder is refused file by file, and the user picks another folder.
- Per-track export has no native progress or cancel once the files are sent, the same as single SVG, PNG and MusicXML. The running-export guard still applies.
- Each track's conversion reloads the bundled fonts, so very large per-track exports are slower than one combined file.
- Only Windows was exercised on the desktop. macOS/Linux alias handling relies on `create_new` and is not run here.

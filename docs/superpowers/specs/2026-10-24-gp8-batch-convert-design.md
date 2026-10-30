# F08: batch legacy GP converter

Date: 2026-10-24. Status: design. Row F08 ("Batch legacy GP converter") stays at its current status until the source review, the security review of the new file access, the automated checks and one desktop run pass.

## Brief

GP8's batch converter turns a folder of older Guitar Pro files into the current format in one go. TabPlayer converts one score at a time, by opening and exporting it. This slice adds **File > Batch convert…**: pick a source folder, the file types and a destination folder, and every matching score under the source, in its subfolders too, is written as a new `.gp` file, with a result for each file. It reuses the import and export code that opening and exporting use (`loadInterchangeScore`, `exportGpInterchange`) and adds no edit command, so the protocol does not change.

## Behaviour

- **The dialog** (`src/batch/BatchConvertDialog.tsx`, modal like the ASCII import) has:
  - **Choose source folder…** and **Choose destination folder…**, each showing the picked path;
  - **File types**: Guitar Pro 3, 4 and 5; Guitar Pro 6 (`.gpx`); Guitar Pro 7 and 8 (`.gp`, written again in the current format); MusicXML (`.xml .musicxml .mxl`). The two legacy Guitar Pro types are on by default, the others off;
  - **Keep the subfolders in the destination** (on by default; off puts every result directly in the destination);
  - **Convert**, enabled with both folders, at least one type and no document operation under way; **Cancel conversion** while a run is under way; **Close**.
- **A run** first scans, then handles the files one at a time. It yields to the UI between files, so progress ("Converting 3 of 12…") and Cancel stay live. Each file is read natively and **probed first in a Worker** (`src/batch/probe.ts`: the stock importer, a 32 MiB decoding cap and a 15 second deadline, `terminate()` on expiry), because a damaged `.gpx` can make the importer spin forever or allocate without end. Only a file that passes is imported, exported to the current GP format, read back and compared (track and bar counts) on the window thread, then written. A file counts as converted only after its output was written. A file the probe times out on is reported Failed and the run goes on. The probe is a reusable helper (`probeScoreBytes`); single-file Open, which has the same hang, is not changed here.
- **Failure isolation:** a file that cannot be read, imported, exported or written is reported as Failed with the reason, and the next file follows.
- **The report** is a table with one row per file: relative path, result (Converted, Failed, Skipped, Not converted) and detail (track and bar counts and the name it was saved as, or the reason). A summary line reads "12 converted, 1 failed, 1 skipped." Files never listed are those of other types.
- **Cancel** (button or Escape) takes effect before the next file; the file under way finishes. Files not reached are listed as Not converted. Close is disabled during a run; Escape then cancels instead of closing.
- **Output names:** `<name>.gp` in the matching subfolder. A taken name never gets replaced: the result is `<name> (2).gp`, `(3)` and so on up to 99, and the report says it was saved under another name because the name was taken. Two sources with the same stem in one folder (`a.gp3`, `a.gp5`) therefore both survive.
- **The open document is untouched.** The dialog never calls `edit()`, opens a document or changes selection. The File menu button is disabled while documents are busy.

## Native side (security review needed)

New file access: `src-tauri/src/batch_convert.rs`, four commands (`batch_pick_folder`, `batch_scan`, `batch_read`, `batch_write`) and managed `BatchState`. `capabilities/default.json` does not change: the folder dialog is called from Rust, as `export_track_files` and the Library already do. Small visibility changes in `intake.rs` (`read_stable`, `component_prefix`, `reparse` become `pub(crate)`) so the existing stable-read and link checks are reused.

- **The window never names a path.** Folders are picked by the native dialog and kept in `BatchState`; files are addressed by index in the last scan. `batch_write` receives an index and bytes, nothing else.
- **Reading:**
  - confined to the source through `read_stable` with the source as scope: no link or reparse point in the path, a file that changes during the read is refused;
  - files are never opened for writing;
  - the scan does not follow links or junctions (reported as skipped).
- **Separation:** the destination may not be the source, inside it, or contain it. Decided by **file identity** (volume and file index through `GetFileInformationByHandle`, in `src-tauri/src/fs_identity.rs`) while walking up the ancestors of each folder, never by comparing names, so the administrative-share spellings of the source (localhost, 127.0.0.1, the computer's own name, and their extended UNC forms) count as the source. If an identity cannot be read the pick is refused. Checked on picking either folder and again at every write. `file_library/protected.rs` uses the same identity check against the protected roots, in addition to its name comparison.
- **Writing:**
  - **Folders:** created one component at a time. Each is passed to `NativeAudio::protect_destination` and checked to be a real folder, not a link, before it is created or entered, so no link can make a new folder anywhere else. The finished folder must still lie under the destination and not under the source.
  - **Files:** the bytes are written to a temporary name in that folder (`.tabplayer-batch-<pid>-<n>.tmp`), the handle's final path is read back and must be in the folder just checked (otherwise the file is deleted), then the file is renamed without replacing (`MoveFileExW` with no replace flag), so nothing is ever replaced and a killed run leaves no truncated `.gp` (at most a `.tmp`). A failed write removes the temporary file.
  - **Content and totals:** the output must start with the ZIP signature and be at most 64 MiB; each scanned file can be written once; a run writes at most 512 MiB in total.
  - **Destination choice:** protection is asked before the destination is kept, so a refused folder leaves the earlier choice. Choosing a destination, like a new scan, starts a new run and clears the list of files.
  - **Names:** names from a listing must be one plain component (no separators, colon or control characters, no trailing dot or space) and not a Windows device name (`NUL.gp`, `COM1`), or they are reported as skipped. Numbered copies run `(2)` to `(99)`; past that the file fails with a message saying so.
  - **Picker:** parented to the main window; Close and Escape are inactive while it is open.
- **Bounds:** 500 files, 32 MiB per file, 512 MiB in total, folders up to 12 levels deep, 20,000 directory entries examined (counted while listing, so a huge folder is never held whole), 1,000 skipped rows. A listing that fails ends that folder with a skipped row and is not read again. Past a limit the scan stops and the summary says the folder holds more than one run can convert and to **choose a subfolder, or fewer file types**, because a rerun would redo the same first files. The same note shows when nothing was listed.
- **Desktop-test builds** answer the pickers from `TABPLAYER_TEST_BATCH_SOURCE` and `TABPLAYER_TEST_BATCH_DESTINATION`, as `export_folder` does with `TABPLAYER_TEST_EXPORT_DIR`.
- The commands check the same workspace admission as the Library, so nothing runs during a session transition.

## Acceptance

- **Rust tests:** scan filters, recursion and order; limits (file count, file size, depth); destination separation in both directions and for a junction; reads confined to the scan and originals unchanged; new-file-only writes with kept or flat folders, numbered names, case-insensitive clashes, refused bytes, protected places and a vanished destination.
- **TypeScript tests:** conversion of generated MusicXML and, where `.analysis/compatibility` exists (or `TABPLAYER_COMPATIBILITY_DIR` names it), of the public GP3, GP4, GP5, GP6 and GP7 files, with their notes equal after the round trip; failure isolation, cancel, the report and the summary; the dialog's states.
- **Desktop** (`tests/desktop/parity-batch-convert.mjs`, on a Windows desktop-test build): a nested mixed corpus (legacy files in subfolders, a current `.gp` and a MusicXML file that are not chosen, a broken file and a text file) is converted with the default types; the report lists exactly the chosen types with the broken file failed; the outputs are new `.gp` files in the kept folders that load; the source tree is byte-identical; a second run writes numbered copies and replaces nothing; Escape cancels with a report that matches the disk; the open score and tabs are unchanged.

## Scope

- No MIDI or ASCII tab input, no option to convert in place or to overwrite, and no skip-existing mode.
- No saved report file and no per-file conversion settings.
- Conversion runs on the window's thread, one file at a time; a worker is a later change if very large folders prove slow.
- Files the importer accepts but renders imperfectly are reported as converted: the check is that the result reads back with the same tracks and bars, not a musical comparison.

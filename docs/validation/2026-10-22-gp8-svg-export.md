# GP8 parity F17: SVG export (2026-10-22)

GP8 (manual pp.231–232) exports SVG with the PDF export options and an optional transparent background. TabPlayer now does the same from the existing export dialog. This slice was implemented on branch `feat/gp8-parity`.

## Behavior
- **Export dialog:**
  - SVG uses the PDF page panel and its validation, covering paper, orientation, margins, scale, staves or a custom page.
  - It also uses the usual track, staff and measure selection.
  - A Transparent background checkbox is off by default.
  - As with PDF, the page or print layout used for the export is saved to the document.
- **Rendering:**
  - Pages come from the same renderer as the PDF (`renderPdfPages`).
  - An opaque export adds a white full-page rect behind each page; a transparent export leaves it out.
- **Native writing (`src-tauri/src/export/svg.rs`):**
  - Each page is parsed with the PDF's bundled fonts and resource denial, then written back with the vendored usvg writer.
  - Text and music glyphs become outline paths, so the files need no fonts.
  - Output keeps the physical page size in mm, with a `viewBox`, and has no indentation.
  - Text that no bundled font can draw is refused with the PDF's message.
- **Files (`export_svg`):**
  - One page is written to the chosen name. Several pages are written as `name-01.svg` … `name-NN.svg`, padded to the page count.
  - Every page is converted before anything is written.
  - The new `export_document_files` checks everything under one lock before writing:
    - the running-job guard;
    - document origin and revision;
    - protection for every destination;
    - for several outputs, that no target exists yet, including dangling links.
  - If a write fails, it removes the files that export already wrote. `export_document_to_path` (GP, MIDI, MusicXML) now runs through the same function with one file.

## Evidence
- **Frontend:**
  - The dialog test submits svg with the layout and `transparent`.
  - svg is in the coherent-source matrix of the coordinator tests.
  - The background test checks that the rect is present when opaque, absent when transparent, and that the live score is unchanged.
  - The bridge test checks the invoke payload.
  - `tsc` is clean, and the export, workspace and App suites pass (607).
- **Native:**
  - `cargo test --lib` passes, 260 tests.
  - Outlines: the test requires more paths than a background-only page. Re-parsing with no fonts gives the same path count.
  - The missing-glyph refusal and the existing-file refusal each fail when their guard is removed (mutation checked). So does the rollback test, which uses an over-long file name to make the write fail.
  - Numbered and padded names are tested.
  - The PDF tests are unchanged and still pass.
- **Desktop (Windows desktop-test build):** `tests/desktop/exports.mjs` passes all 8 cases (midi, musicxml, pdf, svg, wav, stems, and wav/stems at 50%). The svg case checks for no `<text>`, more than two paths, a white background and a viewBox. The document record is unchanged.
- **Independent render:** Chromium (the app's browser pane, independent of usvg) opened the desktop-exported file. It drew the title, tuning, tempo, clef, the entered note and TAB fret 7 from outlines alone.
- **Review:** an Opus adversarial review took 2 rounds and approved. Round 1 found partial multi-page sets, silent overwrite of numbered files, dropped missing glyphs, a weak outline test, and no viewBox. Its follow-up, moving the existence check under the helper's lock and testing both guards, is included.

## Limits
- There are no GP8 file-name tokens or per-track file splitting; those are D20.
- SVG has no cancel or progress job. Like MIDI and MusicXML, the conversion runs after the save dialog in one step, for up to 2000 pages.
- Output is outlines only, so text in the SVG cannot be selected or searched.
- No original-GP8 SVG comparison has been made.

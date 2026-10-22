# GP8 parity F16: PNG export (2026-10-22)

GP8 (manual p.231) exports PNG with the PDF export options and an optional transparent background, as an image that matches the screen. TabPlayer now does the same from the existing export dialog, rasterizing natively from the pages used for PDF and SVG. This slice was implemented on branch `feat/gp8-parity`.

## Behavior
- **Export dialog:**
  - PNG uses the PDF page panel and its validation, covering paper, orientation, margins, scale, staves or a custom page.
  - It also uses the usual track, staff and measure selection.
  - Transparent background is off by default.
  - Resolution offers 72, 150, 300 or 600 dpi, with 300 as the default.
  - As with PDF and SVG, the page or print layout used for the export is saved to the document.
- **Rendering:**
  - Pages come from the same renderer as the PDF (`renderPdfPages`). An opaque export adds a white full-page rect; a transparent export leaves it out.
  - The coordinator applies the native size limits before the save dialog opens.
- **Native rasterizing (`src-tauri/src/export/png.rs`):**
  - The resolution must be 72–600 dpi. Each page becomes round(mm / 25.4 × dpi) pixels.
  - Every page is sized before anything is parsed. A page may have up to 64 million pixels, and the whole export up to 1.5 billion.
  - Each page is parsed with the PDF's bundled fonts and resource denial. Text that no bundled font can draw is refused with the PDF's message.
  - resvg renders the page into a tiny-skia pixmap scaled to fill the image. Pixels with no background stay transparent.
  - Output is 8-bit RGBA with straight alpha, plus sRGB and pHYs chunks, so the physical page size is preserved.
  - New direct dependencies: `resvg =0.45.1` (default features off) and `png =0.17.16`. Both versions were already resolved in `Cargo.lock` through svg2pdf, so the lockfile only gains two dependency edges.
- **Files (`export_png`):**
  - Naming works as for SVG: one page keeps the chosen name, and several pages become `name-01.png` … `name-NN.png`. The page-number helper now takes the extension from the chosen path.
  - Every page is rendered before anything is written.
  - Files are written through `export_document_files`, with its lock, origin and revision checks, destination protection, refusal of existing files for multi-page sets, and rollback.

## Evidence
- **Frontend:**
  - The dialog test submits png with the layout, `transparent` and `dpi`.
  - png is in the coherent-source matrix of the coordinator tests.
  - The background test checks that the rect is present when opaque and absent when transparent, that the dpi is passed through, and that the live score is unchanged.
  - The oversized-export tests (one 1000 mm page, and 50 A4 pages at 600 dpi) refuse before the native call.
  - The bridge test checks the invoke payload.
  - `tsc` is clean, and the export, workspace and App suites pass (642).
- **Native:**
  - `cargo test --lib` passes, 263 tests.
  - At 150 dpi, A4 decodes as 1240×1754 with pHYs 5906 px/m and sRGB.
  - Both corners are opaque white. A word placed at (700, 1000) appears near (1093, 1562), and dark notation pixels are present.
  - At 72 dpi the page is 595×842.
  - A transparent page has alpha 0 in the background, and white text keeps white anti-aliased edges.
  - Mutation checks: rendering with an identity transform fails the scaling test, and skipping the demultiply step fails the straight-alpha test.
  - Refusals are tested for resolution, page count, page area, export budget, missing glyphs and external resources.
  - SVG tests are unchanged; a png-extension numbering case was added.
- **Desktop (Windows desktop-test build):**
  - `tests/desktop/exports.mjs` passes all 9 cases (midi, musicxml, pdf, svg, png, wav, stems, and wav/stems at 50%).
  - The png case selects 150 dpi, then checks the signature, an RGBA8 IHDR, pHYs 5906, an inflated data length that matches the size, and an opaque white first pixel. The document record is unchanged.
  - The exported image was viewed: an A4 page at 1240×1754 showing the title, tuning, tempo, clef, the entered note and TAB fret 7.
- **Review:** an Opus adversarial review took 2 rounds and approved. Round 1 found an overclaimed scope (so F16 is recorded as partial), scaling and straight-alpha tests that would pass anyway, a mismatch between the spec, UI and native size limits, no whole-export budget, parsing before the size check, and no sRGB chunk. All are fixed; round 2 left two comment nits, also fixed.

## Limits
- PNG exports every page of the track/stave/measure selection. You can't export a single system or pick one page.
- There are no GP8 file-name tokens or per-track files; those are D20.
- PNG has no cancel or progress job. Rendering runs after the save dialog in one step, up to the 1.5-billion-pixel budget.
- No original-GP8 PNG comparison has been made.

# D10: headers and footers on the on-screen page view (THE-178)

Spec: Linear THE-178 and the D10 row of `docs/validation/2026-10-15-gp8-parity-progress.md`. Research notes: the export draws page headers and footers (`src/engraving/page.ts:50-100`) but the on-screen page layouts (`src/ScoreView.tsx`, `src/engraving/screen-pages.ts`) do not.

## Rulings made before planning

- **Placement B.** The screen keeps its music exactly where it is today (no 64 px reservation; `screen-pages.test.ts` "uses raw paper content height rather than the PDF 64px reservation" stays). Header and footer text is drawn inside the page margins: same text, fields, slots, font sizes, fitting and horizontal placement as export, but the baselines are moved into the margins:
  - header baseline `max(size*0.8, top - 8)` where `size` is the header base size (`18*titleScale`);
  - footer baseline `min(height - 4, height - bottom + 15)`.
  These baselines are passed into the shared function as inputs, so export keeps its own baselines and byte-identical output.
- An absent `headerFooter` means `defaultHeaderFooter()` on screen, as it does in print (title top left, `%PAGE% / %PAGES%` at the foot).
- `%PAGE%`/`%PAGES%` on screen use the on-screen page index and `pagination.pageCount`. This can differ from the export page count; record it as a limit.
- Page 1 on screen keeps alphaTab's title block, so with the default header the title shows twice there. Recorded as a limit; not worked around in this slice.
- Header-only edits must not re-render alphaTab (`ScoreView.tsx` memoizes `page` without `headerFooter`). The overlay reads the unmemoized page input.

## Global constraints

- No edit-type or schema change. `PageLayout` and `setPageLayout` are unchanged.
- The overlay is decoration: `aria-hidden="true"`, `pointer-events:none`, no new UI strings.
- Zoom and arrangement changes must still not re-render alphaTab.
- Export output for PDF/SVG/PNG/print stays byte-identical (existing `header-footer.test.ts`, `page.test.ts`, `pdf.test.ts` must pass unchanged).
- Run `npm run typecheck` and the touched Vitest files. Do not run the Rust suite (nothing Rust changes).

## Task 1: Shared page text items

Files: `src/engraving/page.ts`, `src/export/page-title.ts`, `src/engraving/header-footer.test.ts` (or a new `src/engraving/page-text.test.ts`).

- Make `measurePageText` return `null` when `getContext('2d')` returns null (jsdom without canvas), instead of throwing.
- Extract and export a pure function from `page.ts`:
  `pageTextItems(input:{geometry:PageGeometry; bands:PageBands|null; title:string; fields:HeaderFields; page:number; pages:number; titleScale:number; headerY:number; footerY:number}):{header:PageTextItem[]; footer:PageTextItem[]}`
  with `PageTextItem={text:string; x:number; y:number; size:number; anchor:'start'|'middle'|'end'}`.
  `bands:null` reproduces the established default branch (title with `pageTitleFontSize`, footer `"i / n"` at size 11), exactly as `paginateEngravedSystems` does today.
- Export a small `pageTextSvg(items)` (or keep the string builder private) so `paginateEngravedSystems` renders items to the same `<text …>` strings it produces now: same attribute order, same escaping, same font attribute. Output must be byte-identical.
- Export a helper `screenPageBaselines(geometry, titleScale):{headerY; footerY}` implementing the placement-B formulas above.
- Tests: items match the positions export prints (first vs other pages, three slots, default branch); the screen baselines for the 15 mm default margins and for a 0 mm margin stay inside the page; `measurePageText` returns null when `getContext` returns null.

## Task 2: Screen overlay

Files: `src/ScoreView.tsx`, `src/ScoreView.css`, `src/export/pdf.ts` (font loading), `src/ScoreView.layouts.test.tsx`.

- Make the export font loading idempotent (one memoized promise; do not add FontFaces again on each call). The screen calls it once when a physical page layout is shown, and bumps a state value when fonts are ready, so text is re-fitted with Noto Sans. Failure to load fonts leaves the fallback face and is not an error to the user.
- Inside each `.score-sheet`, after the chunk divs, render `<svg class="score-page-text" aria-hidden="true" viewBox="0 0 paper.width paper.height" width={sheet.width} height={sheet.height}>` positioned at the sheet's top-left, `pointer-events:none`, with one `<text>` per item (same font-family as export, fill `#111`, `text-anchor` from the item).
- Inputs: the unmemoized page input's `headerFooter` (absent = default), fields from `headerFieldsOf(score)`, `titleScale` from the engraving typography as export uses it, geometry from `pageGeometry` of the page layout, page index and `pagination.pageCount`, baselines from `screenPageBaselines`. Memoize items per page so zoom does not re-measure.
- Only physical page layouts (`isPhysicalPageLayout`) draw the overlay.
- Tests in `ScoreView.layouts.test.tsx`: each sheet has an overlay with the default header title and `N / total` footer; custom first/other bands show the right text on page 1 and page 2; changing only `page.headerFooter` updates the text without another alphaTab render; overlay has `pointer-events:none` and `aria-hidden`; zoom changes the overlay size only; non-page layouts draw none. Existing ScoreView tests must still pass.

## Task 3: Desktop proof, docs and tracker

Files: `tests/desktop/parity-header-footer.mjs`, `tests/desktop/parity-symbol-editing.mjs` / `parity-style-typography.mjs` only if the overlay breaks their locators, `docs/validation/2026-11-07-gp8-screen-header-footer.md`, `docs/validation/2026-10-22-gp8-header-footer.md` (Limits), tracker D10 row (md + json).

- Extend `parity-header-footer.mjs`: after applying fields, read the `.score-page-text` texts on page 1 and page 2 and compare with the substituted values; after Undo, the screen shows the previous text; the overlay boxes lie inside their sheets and do not overlap the first system's bounds on page 1 at default margins.
- Controller writes the docs and tracker.

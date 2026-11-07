# GP8 D10: headers and footers on the on-screen pages (THE-178)

## Behavior

- The physical page layouts (vertical page, horizontal page and grid) draw each page's header and footer on screen. They use the same fields, first-page and other-page bands, slots, font sizes, fitting and ellipsis as PDF, SVG, PNG and print.
- On screen the text sits in the page margins and the music does not move:
  - the header baseline is `max(18 × title scale × 0.8, top margin − 8)`;
  - the footer baseline is `min(page height − 4, page height − bottom margin + 15)`.
- A document without saved header and footer fields shows the established title and `page / pages`, the same as print.
- The text is a decorative overlay. It is hidden from assistive technology, it lets clicks through to the notation, and it adds no UI strings.
- Header-only edits update the overlay without re-rendering the notation. Zoom changes only the overlay size.
- Export loads its fonts (Noto Sans, Noto Sans CJK JP, Noto Emoji and Bravura) once, as one memoized promise that adds the faces only after all of them have loaded. The screen uses the same promise and re-fits the text when the fonts are ready. If the fonts fail to load, the fallback face stays and the user sees no error.
- Export output is unchanged. Export and screen share `pageTextItems` in `src/engraving/page.ts`. A test pins the export page text to literal strings captured from the export code before this change, and checks that the shared items render to the same text.

## Evidence

- Vitest:
  - `src/engraving/page-text.test.ts` covers shrink and ellipsis, slot clearance, export text pinned to pre-change literals for custom and default bands, and the screen baselines at 15 mm and 0 mm margins.
  - `src/export/pdf-fonts.test.ts` covers the font memo, adding no face when any one fails, retry after failure, and a missing `FontFace`.
  - `src/ScoreView.layouts.test.tsx` covers:
    - the default and custom bands on pages 1 and 2;
    - a header-only change without another notation render;
    - `aria-hidden` and `pointer-events: none`;
    - zoom;
    - no overlay outside page layouts;
    - re-fitting after the fonts load;
    - a rejected font load.
  - The existing `header-footer.test.ts`, `page.test.ts` and `pdf.test.ts` pass unchanged.
- Windows desktop test, `tests/desktop/parity-header-footer.mjs` on the three-track engraving fixture at A4, in the vertical page view:
  - The run passed on 2026-11-07. The screen shows 3 pages and the PDF has 5, so the on-screen footer reads `1 / 3` where the PDF reads `1 / 5`.
  - Before the custom fields, every screen page shows the title top left and `i / n` at the foot.
  - After applying the fields:
    - the screen page count is unchanged;
    - page 1 shows title, subtitle, artist, `© title` and `1 / n`;
    - every other page shows `title (cont.)` and `i/n · 100%`.
  - Every text lies inside its sheet and clear of the music's top and bottom edges.
  - Undo restores the earlier screen text and Redo shows the authored text again. The existing PDF, save and reopen checks still pass.

## Limits

- D10 stays partial. The earlier limits in [2026-10-22-gp8-header-footer.md](2026-10-22-gp8-header-footer.md) still apply, except that the screen now draws headers and footers.
- The on-screen header and footer baselines differ from export's. Export reserves 64 px for the header and footer and moves the music down; the screen draws the text in the margins instead.
- `%PAGES%` and `%PAGE%` on screen count the on-screen pages, which can differ from the exported page count.
- Page 1 on screen shows the title twice: once in alphaTab's title block and once in the default header. This is not worked around.
- With very small top or bottom margins the header or footer can touch the music; the baselines are clamped only to stay on the page.
- There is no original-GP8 comparison of on-screen placement.
- The first page view in a session loads all export fonts, about 18.6 MB including the 15.7 MB CJK face, though plain text needs only Noto Sans. Before this change they loaded only on export.

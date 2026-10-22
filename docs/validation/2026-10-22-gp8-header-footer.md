# GP8 parity D10: header and footer fields (2026-10-22)

GP8's stylesheet sets separate headers and footers for the first page and for the other pages, filled from score fields. This slice adds that to the page layout used by PDF, SVG, PNG and print. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Presentation → Page layout → Header and footer:** a band of left, center and right text for each of these:
  - first page header and footer;
  - other pages header and footer.

  The same panel appears in Export score's custom page layout.
- **Fields:**
  - score fields: `%TITLE%`, `%SUBTITLE%`, `%ARTIST%`, `%ALBUM%`, `%WORDS%`, `%MUSIC%`, `%COPYRIGHT%`, `%TABBER%`, `%INSTRUCTIONS%` and `%NOTICES%`;
  - page fields: `%PAGE%` and `%PAGES%`;
  - `%%` for a percent sign.

  An empty slot prints nothing.
- **Refused text:** an unknown field, a stray `%`, a line break or other control character, U+FFFE/U+FFFF or a lone surrogate, or more than 200 characters.
  - The panel names the slot.
  - Rust refuses the same text when a document is edited or loaded.
- **Defaults:** "Default header and footer" restores the established page: the title at top left and "page / pages" centered at the foot.
  - A layout left at the defaults is saved without the field, so existing documents keep their saved shape and print exactly as before.
- **Printing:**
  - Left, center and right text is anchored at the margins and the page center.
  - Header text starts at 18 px and footer text at 11 px. Each is measured at its own size.
  - A centered slot never crosses a margin. When side slots share its line, it keeps up to a third of the line.
  - Side slots run from their margin to 12 px short of the centered text, so slots never overlap, even with uneven margins.
  - Text that still doesn't fit shrinks to a 5 px floor, then shortens with an ellipsis.
  - Filled text is escaped. Line breaks in score metadata print as spaces, and characters XML cannot carry are dropped, so metadata can't break an export.
  - Notation placement is unchanged.
  - Editing only the header and footer does not re-render the on-screen pages.
  - Changing the header and footer is one undoable page layout edit.
- **Test hook:** desktop-test builds record the pages that native PDF and SVG export accepted, because exported text is outlined. Other builds record nothing.

## Evidence
- **Frontend:**
  - `header-footer.test.ts`:
    - every field substitutes, as do page numbers and `%%`;
    - fields are read from the score metadata;
    - invalid text and shapes are refused;
    - the field is optional in page validation;
    - the default bands print exactly what the established pages print;
    - first-page and other-page bands appear in their positions on every page;
    - crowded slots shrink;
    - footers fit at their own size;
    - side slots stay clear of a centered slot, including with uneven margins (mutation-checked);
    - text shortens with an ellipsis at the floor size;
    - metadata line breaks and XML-invalid characters are cleaned;
    - unprintable template characters are refused;
    - an undefined header and footer counts as absent.
  - `pdf.test.ts`: a custom header and footer is filled from the exported score on every page.
  - `PageLayoutPanel.test.tsx`:
    - fields can be edited and are applied;
    - the default shape is omitted;
    - Reset works;
    - saved values are shown and kept;
    - unknown fields raise an alert.
  - RED log: `.analysis/parity/header-footer-red.log`.
- **Rust:** `tests/engraving_protocol.rs`:
  - an absent header and footer stays absent when serialized;
  - every field is accepted, with a round trip;
  - unknown fields, lowercase fields, stray `%`, line breaks, U+FFFE/U+FFFF, more than 200 characters, null, non-strings and unknown or missing keys are refused.
- **Desktop (Windows desktop-test build):** `tests/desktop/parity-header-footer.mjs` uses the three-track engraving fixture on A4, which prints five pages. It checks:
  - the established title header and "n / 5" footer;
  - an unknown field is refused with the slot named;
  - the custom bands are applied as one `setPageLayout` edit;
  - the first page prints the title, subtitle (center), artist (right), "© title" (left foot) and "1 / 5";
  - pages 2–5 print "title (cont.)" (center) and "n/5 · 100%" (right foot), in a real `%PDF-` export;
  - undo restores the established pages;
  - the layout is saved, and after a restart and reopen the project and fields are identical and the PDF prints the same.
- **Review:** an Opus adversarial review found these issues, all fixed with tests:
  - footers were measured at header size and shrank too far;
  - side slots could overlap a centered slot;
  - unprintable template or metadata characters made every export fail;
  - TS and Rust disagreed on lone surrogates and on an undefined header and footer;
  - header-only edits re-rendered the on-screen page view;
  - the fields' help text and errors weren't linked to the inputs (`aria-describedby`, `aria-invalid`).

## Limits
- D10 is partial:
  - There is no original-GP8 comparison. The field names and `%…%` syntax follow GP8's concept, not a verified GP8 token list.
  - Header and footer show only in exports and print. The on-screen page view does not draw them.
  - There are no per-field fonts, styles, images or multi-line text.
  - Score fields other than title and artist come only from imported files.

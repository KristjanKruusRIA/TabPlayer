# GP8 parity D12: text typography and notation style presets (2026-10-30)

GP8 sets fonts, sizes and notation style. TabPlayer's fonts and sizes were fixed. This slice adds typography to the engraving style, and Classic, Jazz and Rock presets. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-style-typography-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build. The row is partial: see Limits.

## Behavior
- **Controls:** a Typography disclosure in the Engraving panel sets one text family, text size and title size from 50 to 200%, and tab number size from 75 to 150%.
- **Presets:** Classic, Jazz and Rock fill the form. Apply is one undoable edit, and presets change no music.
- **Storage:** typography is an optional part of the existing `setEngraving` edit, so older documents are unchanged. A style library stays version 1 until a stored style uses typography, then becomes version 2.
- **Export:** PDF, PNG and SVG use the chosen sizes with bundled Noto. Title size scales the page header, which still shrinks to fit.
- **Overflow:** an export whose text would pass the paper edge fails with the text and the settings to reduce.
- **Fret numbers:** these keep the default family.

## Evidence
- **Rust:** 815 tests passed across the merged branch, none failed.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout, and the rest of the suite passed 3,742 of 3,743 with 1 skipped; the one failure, `src/editor/corpus.test.ts`, was a timeout under load, and it passed alone.
- **Desktop:** `tests/desktop/parity-style-typography.mjs` passed on a Windows desktop-test build of the merged source, on a 24-bar, two-track score with chord names, CJK, emoji and accented text. The run:
  - applied typography as one undoable edit, and checked family and size as drawn, and undo and redo;
  - found no text past a tile edge sideways, and exported every PDF, PNG and SVG page, with no SVG content leaving its page;
  - proved Title size changes the exported header without changing the page size;
  - applied each preset as one edit, drawn in its family, with the music unchanged;
  - saved a style with typography, and cleared it with Force default style;
  - kept a version 1 library readable, and upgraded it only when needed.

  `tests/desktop/parity-stylesheets.mjs` passed again on the same source.

## Review
- **Code review:** an Opus review probed export and the library.
- **Findings and fixes:**
  - **High, fixed:** Title size did nothing on export, while the panel said it did.
  - **High, fixed:** overflow was unchecked on export.
  - **Medium, fixed:** the driver exported only GP on a one-bar score.
  - **Medium, fixed:** numbered notation ignored the settings.
  - **Low, fixed:** Georgia's old-style figures on tab, grace font sizing, and any library write forcing version 2.
- **Desktop run:** it found a real bug the review could not. The new check refused the short track name "Gtr", which would have blocked most typed exports. Only the paper edge clips, so the check now allows the page margin. The other first failures were in the driver.

## Limits
- **Why partial:**
  - the music font is fixed to Bravura;
  - there is one family for all text, not one per text kind;
  - export keeps Noto, so the family is screen only.
- **On screen:** alphaTab keeps no room for beat text, so text at the end of a system can run past the page, even at default size, and a very long score title draws as one line. Export refuses the cases that would pass the paper edge.
- **Vertical spill:** it is not measured on screen, because text boxes overhang stacked tiles at every size.
- **Missing glyphs:** these rest on the font fallback stacks, and were exercised with CJK and emoji text.
- **Older builds:** a version 2 library is refused by older builds, and left unchanged.

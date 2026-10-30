# D12: text typography and notation style presets

Date: 2026-10-24. Status: design. Row D12 ("Music/text fonts, sizes and notation style presets") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's stylesheet has a Texts tab (a font, size and style per text kind) and ships Classic, Jazz and Rock notation styles. TabPlayer draws text with the renderer's fixed fonts and offers only the stylesheet and notation switches of the Engraving panel (`src/engraving/EngravingPanel.tsx`). The row's acceptance is "Change supported style typography with no missing glyphs/overflow".

This slice adds **typography** to a document's engraving settings and three built-in **notation style presets**. Nothing is a new edit command: typography is a field of `EngravingOverrides`, so changing it is the existing `setEngraving` edit (one undo step, protocol count unchanged).

## What is supported, and what is not

- **Music font.** Bravura is the only SMuFL font the app ships, and alphaTab draws every music symbol from it. It is shown in the panel but not selectable; offering a choice with one option would be a control that does nothing. Bundling another SMuFL font (for example a handwritten jazz face) needs a new licensed asset and font-directory packaging and is out of scope.
- **Text font.** One family choice for all text: Source/default (the renderer's own Georgia and Arial faces), Sans-serif, Serif, Monospace. Each is a CSS stack ending in a generic family (`sans-serif`, `serif`, `monospace`), so a character the named face lacks falls back to a system face rather than a blank box.
- **Sizes.** Three scales, each blank (renderer size) or a percentage of it:
  - text size, 50% to 200%: chord names, track names, bar numbers, fingering, tempo and every other staff annotation;
  - title size, 50% to 200%: the score title block (title, subtitle, artist, album, words, music) and the copyright line;
  - tab number size, 75% to 150%: fret numbers, grace-note fret numbers and numbered-notation digits. The range is narrower so numbers stay inside the staff lines. These numbers keep the renderer's default family whatever Text font is chosen, because a serif face with old-style digits would sit unevenly on the lines.
- **No per-element fonts, bold or italic.** The renderer's own weights and styles are kept. A font per text kind is a later change if needed.

## Data model

`EngravingOverrides.typography?: {family: 'inherit'|'sans'|'serif'|'mono'; textScale, titleScale, tabScale: number|null}`.

- The field is **optional and omitted while it is the default** (Rust `skip_serializing_if`, TypeScript `withTypography`). Documents, snapshots and edits saved before this change are byte for byte what they were, load unchanged, and stay readable by older builds until a typography choice is made. `tests/protocol.json` is unchanged.
- Validation agrees on both sides: unknown or missing keys inside `typography`, an unknown family, a non-number scale and a scale outside its range are refused (`engraving.rs` `EngravingTypography::validate`, `typography.ts` `validateTypography`). An explicit all-default `typography` is accepted and normalized away by the panel before it is sent.
- `configureEngraving` calls `configureTypography`, which **rebuilds every text font from the renderer defaults** and then applies the choice. A reused `Settings` therefore never keeps an earlier choice, and Reset to source/default restores the original fonts. Layout measures the final fonts, so larger text moves the notation instead of overflowing it.
- PDF, SVG and PNG export render through `configureEngraving`, so the chosen sizes apply there. Export always sets text in the bundled Noto fonts (`pdf.ts`, now including the grace and numbered fonts) so that glyph coverage and measurement do not depend on the machine; the chosen family therefore affects the screen only.
- **Title size on export:** the notation's own title block is switched off in export, so Title size scales the page header line instead (base 18px times the scale, 9px to 36px). The header is still shrunk to fit the usable page width, and its baseline moves down so a large line stays inside the 40px above the notation. A custom header and footer (D14) take the same larger base for the header band; the footer is not scaled.
- **Text that does not fit is refused on export.** The exporter only checked that bars fit the page, but enlarged annotations, chord names and track names can run past the last bar. When typography is not the default, `assertTextFits` (`src/export/text-bounds.ts`) lays each rendered system out in a hidden element and measures every text (music-font glyphs excluded, rotated track names measured as drawn). If any text starts left of the system or ends past the usable width, the export fails with a message naming the text and the settings to reduce. Nothing is silently clipped or shrunk. Documents with default typography are never refused by this check.
- **Bounded, not guaranteed:** the check measures what the webview lays out, so it cannot run where there is no layout (unit tests stub it). On screen the renderer draws the score title as one centred line without wrapping, so a very long title at a large Title size can run past the page edge there; the panel says so. Text taller than the room between systems is not checked.

## Style library compatibility (D13)

A saved style stores its typography with the rest of the engraving, because `styleOf` copies everything but the profiles. The library file's strict schema would refuse a style carrying the new field, so the file version moves to 2:

- Native `style_library.rs` reads version 1 and 2. A version 1 file is read as version 2 in memory (a version 1 entry that carries `typography` is damaged, since version 1 never wrote it). **Reading never rewrites a file.** A put (or a remove that changes an entry) writes version 2 only while some stored style has typography, and version 1 otherwise, so a library that does not use typography stays readable by older builds; a remove that changes nothing leaves the file as it was. Version 0, 3 and other formats are still damaged and left byte for byte.
- Entries omit `typography` while it is the default, so a library of old styles is byte-compatible with version 1.
- The client library (`style-library.ts`) accepts only version 2, since the native side always normalizes. `Force default style` and applying a style without typography clear the document's typography, because a style is applied whole.

## Presets

`notation-presets.ts` defines Classic, Jazz and Rock. A preset is a starting point: **Load preset** replaces the form's stylesheet, notation and typography choices (everything the preset does not name returns to Source/default) and keeps system spacing and staff profiles. Nothing reaches the document until Apply engraving, which is the existing single `setEngraving` edit.

| Preset | Typography | Stylesheet and notation |
|---|---|---|
| Classic | serif, title 125% | bar numbers on the first bar of each system, grouped staves, multi-rests on, chord diagrams on top, tab rhythm hidden |
| Jazz | serif, text 115%, title 140% | every bar numbered, chord diagrams on top and inline, multi-rests on, empty staves hidden, tab rhythm hidden |
| Rock | sans-serif, tab numbers 115% | every bar numbered, chord diagrams inline, similar-instrument brackets, tab rhythm beamed, extended bend arrows and line effects |

These are TabPlayer's own interpretations built from supported switches, not copies of GP8's style files.

## Behaviour of the panel

- **Typography** disclosure inside the Engraving panel: the music font note, a Text font select, and three percentage fields. A percentage field keeps what is typed and commits on blur or Enter; blank means the renderer size; an out-of-range value reports "<Field> must be between A% and B%." and reverts the field. Nothing is sent until Apply engraving.
- **Notation style presets** disclosure: one button per preset ("Load Classic preset" and so on).
- Both live inside the panel's `fieldset`, so they are disabled while the panel is busy. Typography fields and presets only fill the form; the only thing that edits is the existing Apply engraving button. A finalized document disables the Presentation area through `editBusy`, and the native side also refuses `setEngraving` (only the mixer stays editable), so no new editing surface was added outside the panel.
- The unapplied-changes guard (Apply saved style and Force default style are blocked while the form differs) includes typography.

## Acceptance

- **Unit tests:**
  - **Native** (`engraving_protocol.rs`, `style_library.rs`, including version 1 kept when no style uses typography): default typography stays off the wire and old commands round-trip unchanged; every range edge accepted and every outside value, wrong type, unknown family, extra key and missing key refused; library version 1 read without rewriting, upgraded on a changing write, refused when it carries typography; damaged table extended for version 0, 3 and malformed typography.
  - **Client** (`typography.test.ts`): normalization, validation agreement, font rebuilding from the defaults (including after an earlier choice), each family on every text font, `configureEngraving` integration, a full render at the extreme sizes with larger and smaller text, numbered-notation fonts, and preset content. `text-bounds.test.ts` adds export regressions: Title size scales and fits the page header, and long Latin and CJK annotations at 200% are refused with a reason while the same score exports at the default size.
  - **Panels** (`EngravingPanel.test.tsx`, `StylePresetsPanel.test.tsx`, `style-library.test.ts`): commit on blur or Enter, range errors, default typography never sent, presets fill without editing and keep spacing and profiles, busy state, saved styles carrying and clearing typography.
- **Desktop** (`tests/desktop/parity-style-typography.mjs`, written but run by the controller): on a fixture with several bars of chord names, CJK and long beat text, typography applied as one `setEngraving` edit whose text and fret-number sizes are measured as drawn, with no text outside its tile or page, PDF, PNG and SVG pages exported (SVG laid out to check spill) and the exported notes unchanged; Classic, Jazz and Rock each applied and checked; undo and redo restore the record and the drawing; the smallest sizes also lay out; a preset applies as one more edit; a saved style holds its typography in a version 2 library, and a library without typography stays version 1; Force default style restores the original drawing; a version 1 library is listed and applied, stays version 1 until a style uses typography, then becomes version 2; the user's real library is untouched.

## Limits to record

- The music font cannot be changed (one bundled SMuFL font).
- The text family is a screen choice; exports use the bundled Noto fonts. Fret and staff numbers keep the default family.
- Export refuses, rather than fits, enlarged text that would pass the page width; on screen a very long score title at a large Title size can run past the page edge (the renderer does not wrap it).
- No per-element fonts, bold or italic, and no separate page header and footer typography (those are D14's text fields).
- Presets are approximations of GP8's styles, not imports of them.
- System fonts (Georgia, Arial, Consolas) vary by machine; the generic fallback prevents blank glyphs but not a different look.

## Scope

- No new edit command and no change to `tests/protocol.json`.
- Changes to shared files are limited to `engraving.rs` (one field), `style_library.rs` (version 2) and the Engraving panel; no change to `App.tsx` or `lib.rs`.

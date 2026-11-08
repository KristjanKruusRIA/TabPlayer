# GP8 D12: font roles and music font (THE-181)

## Behavior

- The Typography disclosure of the Engraving panel has a "Music font" select (Bravura, Petaluma, Leland) and one row per text role: Title block, Page header, Page footer, Chord names, Staff text, Lyrics, Track names, Bar numbers, Markers and Tab numbers. Each role has a font (Source/default, Noto Sans, Noto Serif, Noto Sans Mono), a size (50 to 200%, tab numbers 75 to 150%) and bold and italic (Source/default, On, Off). Bold and italic need a chosen font. Everything fills the draft; "Apply engraving" sends one `setEngraving` edit, and an unchanged draft records nothing.
- A role with a chosen font is drawn in that font on screen (app-owned alias families `TabPlayer Sans`, `TabPlayer Serif`, `TabPlayer Mono`, with Noto Sans, Noto Sans CJK JP and Noto Emoji behind them) and in PDF, PNG, SVG and print, where the exported text uses the same bundled faces. A role without a font keeps today's look: the Text font stack on screen, Noto Sans in exports.
- Music font: the glyph family is switched by CSS on screen and by the export page style; alphaTab's glyph metrics are refilled from the chosen font's SMuFL metadata. A symbol the chosen font lacks is drawn from Bravura, and the panel says how many (Petaluma 10, Leland 104 of the 282 symbols alphaTab draws).
- The panel warns, without blocking, when the score's own text for a role holds a character the chosen face lacks, and when a font could not be loaded.
- Data: `EngravingOverrides.fonts`, `{music?, roles?}`, an optional field of the existing `setEngraving` edit, omitted when default at every level, validated identically by TypeScript and Rust. Old projects and edit logs replay unchanged. A style library is version 1, 2 or 3 by content: version 3 only when a stored style carries fonts.
- Export draws music glyphs at the size alphaTab lays the score out with (36 px). Before D12 it used 34 px (see "The 34 px / 36 px question").
- Fonts and metadata ship byte for byte as pinned. Nothing was dropped by the licence gate.

## Evidence

Commands run on 2026-11-08 in `.worktrees/d12-font-roles`, first on 7bd9654 plus the Estonian wording fix and the driver (commit 9a4476f, before develop was merged). They were rerun on the merged branch: see "After merging develop" at the end.

- `npm test`, `npm run typecheck`, `cargo test --locked ... --test engraving_protocol`, `--lib style_library`, `--lib export::pdf` and `cargo fmt -- --check`: see "Automated results" at the end.
- `src/i18n` tests passed (2 files, 56 tests) after "kuni see on laaditud" became "kuni font on laaditud" in `src/i18n/et.ts`.
- Desktop test build with `scripts/build-desktop-test.ps1` (default target folder, Rust 1.90.0). `.analysis/desktop-smoke/tabplayer.exe` and `src-tauri/target/release/tabplayer.exe` have the same SHA-256 (`6ec11c5b141cc3cb1b1a7f58643f73e64cf3f303f324a54b52a0409c627c4b95`, 75,774,976 bytes), written at the end of the build.
- `tests/desktop/parity-font-roles.mjs` on a Windows desktop-test build, on an authored one-track, eight-bar guitar score (section markers `[A] Verseq` and `[B] Chorusq`, chord names, lyric syllables `Lyriq`, a CJK character and an Estonian one, title and artist), at A4 in the vertical page view, with an isolated app-data folder:
  - A default document: the PDF embeds `Bravura`, `NotoSans-Regular` and `NotoSansCJKjp-Regular` and nothing outside {Bravura, NotoSans-Regular, NotoSansCJKjp-Regular, NotoEmoji}; the screen draws system fonts and no alias.
  - Lyrics = Noto Serif italic, Markers = Noto Sans Mono bold, Page header = Noto Serif 150% and music = Petaluma: nothing is recorded while choosing (the edit count is unchanged), the lyric character Noto Serif lacks (中) is named in the warning and the covered Estonian one is not, and "Apply engraving" adds exactly one `setEngraving` edit holding exactly those fonts (`size:1.5`); pressing it again with nothing changed adds none.
  - As drawn (`getComputedStyle`): the lyric is `"TabPlayer Serif"`, italic; the marker is `"TabPlayer Mono"`, weight 700; the page header is `"TabPlayer Serif"` at 27 px (18 x 150%); chord names (no font chosen) keep the system font; every notation glyph has the family `Petaluma, "TabPlayer Bravura"` (measured on the hidden staging surface alphaTab draws into and, after the merge round, also on the visible page chunks); the `TabPlayer Serif` italic and regular, `TabPlayer Mono` bold and `Petaluma` faces are loaded in `document.fonts`.
  - The PDF embeds `NotoSerif-Italic`, `NotoSansMono-Bold`, `NotoSerif-Regular` and `Petaluma` (with `Bravura`, `NotoSans-Regular` and `NotoSansCJKjp-Regular`). The page SVGs handed to the PDF writer carry `.at{font-family:Petaluma,Bravura;font-size:36px}`, the header in the Serif alias at 27, and no text element leaves the page (measured by laying the SVG out in the webview; 130 text items).
  - Undo restores the record and the default drawing; redo restores the fonts. Save leaves the document clean with the fonts in it; reopening gives an identical project and the fonts are drawn and exported again.
  - Music font to Leland is one more edit; glyphs use `Leland`, the PDF embeds `Leland` and no `Petaluma`, the text roles are unchanged. Back to Bravura omits `music` from the stored fonts, draws Bravura and embeds no Petaluma or Leland.
  - Saved styles: a style without fonts keeps the library at version 1; a style with fonts makes it version 3 and carries the fonts; deleting it brings it back to version 1. The user's real library file was not touched (hash compared).
  - The native playback generation (read idle) is 6 before and after every edit, undo, redo and save, and after Leland and Bravura on the reopened document.
- Driver output (final run):

```text
PASS default: no role or music font is chosen and the screen draws system fonts, not the aliases - {"lyric":"Georgia, serif","marker":"Georgia, serif","glyph":"alphaTab"}
PASS default: the PDF embeds only the faces exports always used (Noto Sans, CJK where used, Bravura), none of the D12 faces - ["Bravura","NotoSans-Regular","NotoSansCJKjp-Regular"]
PASS 34/36: export draws music glyphs at the size the screen does (36 px) - screen 36px, export 36px, css .at{font-family:Bravura;font-size:36px}
PASS a saved style without fonts keeps the style library at version 1
PASS choosing fonts records nothing until Apply, and the lyric character Noto Serif lacks is warned about - Noto Serif has no glyph for ‘中’ (Lyrics); it is drawn from the fallback font.
PASS Apply engraving is one setEngraving edit holding exactly the chosen fonts
PASS Apply engraving again with nothing changed records nothing
PASS screen: lyrics use the Serif alias in italic, markers the Mono alias in bold, the header the Serif alias at 150%
PASS screen: music glyphs use Petaluma and the Petaluma face is loaded - Petaluma, "TabPlayer Bravura"
PASS PDF embeds NotoSerif-Italic, NotoSansMono-Bold, NotoSerif-Regular and Petaluma - ["Bravura","NotoSans-Regular","NotoSansCJKjp-Regular","NotoSansMono-Bold","NotoSerif-Italic","NotoSerif-Regular","Petaluma"]
PASS export pages: Petaluma music CSS at 36 px, the header in the Serif alias at 27, and no text past the paper edge - 1 page(s), 130 text items
PASS undo restores the record and the default drawing; redo restores the fonts
PASS a saved style with fonts makes the library version 3 and carries the fonts
PASS removing the style with fonts brings the library back to version 1
PASS save leaves the document clean with the fonts in it
PASS native playback generation is unchanged across the font edit, undo, redo and saves - generation 6
PASS reopen: the project (history and fonts) is identical and the fonts are drawn again
PASS reopen: the PDF again embeds the chosen faces
PASS switching to Leland is one more edit; glyphs and the PDF use Leland and no longer Petaluma
PASS switching back to Bravura omits music from the fonts, draws Bravura and no D12 music face is embedded
PASS native playback generation is unchanged across Leland and Bravura
PASS no page errors
PASS the real user style library was not touched
font-roles: 23 passed, 0 failed.
```

- Runs: three consecutive runs of the final driver each ended `font-roles: 23 passed, 0 failed.`, with no flake (three earlier runs of the 22-check driver, two of them with a screenshot step added, also passed).
- Two first runs failed on driver faults, not on the product: the driver looked for glyphs as `text.at` (alphaTab draws `g.at > text`), `Track.applyLyrics` fills only the first beat in alphaTab 1.8.4 (so the CJK syllable never reached the score), and the PDF lists a composite font twice (the `-Identity-H` wrapper). All three were fixed in the driver. A screenshot of the page, the music-font select and the Markers row was looked at by eye: the panel rows are readable, and the page shows the Petaluma notation, italic serif lyrics and bold mono marker.
- The 34 px / 36 px question, measured on the desktop: the notehead (U+E0A4) is drawn at 36 px on screen (`getComputedStyle`), and at 36 px in the exported page SVG laid out in the webview, whose style is `.at{font-family:Bravura;font-size:36px}`. alphaTab lays the score out at `engravingSettings.musicFontSize` 36 (Task 1 measured an up-stem 10.62 px right of its notehead, equal to `stemUpSE` x 36/4; at 34 px it would be 10.03 px, 0.59 px off).
  - Task 1 (1963244, b249870) already changed export from the literal 34 px to `defaultMusicFont.size` (36, read from `new Settings()`), so export is now at 36 and nothing was left to fix here.
  - Effect on the byte-identity baseline: no existing byte-identity test pinned `34px` when Task 1 checked, so `page.test.ts`, `page-text.test.ts`, `pdf.test.ts`, `header-footer.test.ts` and `pdf-fonts.test.ts` pass unchanged. After merging D11, one did: the no-groups export hash `NO_GROUPS_SHA256` in `src/engraving/staff-groups.render.test.ts` covers the whole page string, and was re-recorded (see "After merging develop"). A document without `fonts` exports page SVGs that differ from a pre-D12 build in that one literal, so its notation glyphs are about 5.9% larger (36/34) than before (the old ones were about 5.6% smaller than the layout assumed). Header and footer text is byte-identical.
- Bytes added to the install (exact, from `assets/fonts/sources.json` and the files):

| File | Bytes |
|---|---:|
| NotoSans-Bold.ttf | 575,740 |
| NotoSans-Italic.ttf | 552,776 |
| NotoSans-BoldItalic.ttf | 555,292 |
| NotoSerif-Regular.ttf | 616,196 |
| NotoSerif-Bold.ttf | 638,164 |
| NotoSerif-Italic.ttf | 657,092 |
| NotoSerif-BoldItalic.ttf | 675,428 |
| NotoSansMono-Regular.ttf | 512,836 |
| NotoSansMono-Bold.ttf | 525,664 |
| Petaluma.otf | 397,440 |
| Leland.otf | 89,132 |
| Font files, once | 5,795,760 |
| Font files twice (web copy in `export-fonts` and `include_bytes!` in the binary) | 11,591,520 |
| petaluma_metadata.json (web only) | 369,544 |
| leland_metadata.json (web only) | 150,602 |
| Metadata, once | 520,146 |
| **Total added** | **12,111,666** (12.11 MB, 11.55 MiB; budget 16 MB) |

  The four new licence texts (17,575 bytes) and the generated `font-coverage.json` (8,190 bytes) are small extras not in that total. The total was computed from the file sizes; the installed size of a packaged build was not measured.

## Limits

- D12 stays partial. There is no comparison with the GP8 manual (it was not available), only three bundled text families, no user or system fonts, and Guitar Pro files do not carry fonts.
- Screen and export share the glyph shapes of the chosen faces for a role with a chosen font; this is not a guarantee of identical layout. alphaTab builds a width table per family from the first family that already has one, so a chosen alias can be measured with Noto Sans widths (after an export or a page view in the same session), and screen and export layout widths can then differ. Roles without a font keep system fonts on screen and Noto Sans in exports.
- The characters ♯ ♭ ♮ in text of a chosen role come from Noto Sans CJK JP or a system face on screen and from Bravura in exports (Noto Sans, Serif and Sans Mono differ in what they hold), so their shapes can differ between the two.
- The Title block role affects the screen only; export prints the title in the page header (the Page header role).
- Bold and italic need a chosen font. Noto Sans Mono has no italic face upstream: italic On is refused for it, and its default-italic elements (staff text, lyrics, chord names, track names) are drawn upright. This was checked by unit tests, not on the desktop.
- The Markers role also restyles the tempo text ("= 120"): alphaTab draws it with the marker font. It is visible in the screenshot of the run, and it follows the alphaTab element mapping, not the role table.
- alphaTab measures text with an 11 px table of one family for code points 32 to 254, ignoring bold and italic, so wider faces can still run past a system end on screen. Export's fit check refuses text that would pass the paper edge, and its error text is English only (it is not translated).
- Music fonts other than Bravura keep alphaTab's Bravura-tuned spacing; symbols the font lacks are drawn from Bravura (Petaluma 10, Leland 104). The notation entry panel and palette keep Bravura.
- After a failed font load, every later edit retries the load and registers duplicate `FontFace` entries. This only matters with a corrupt bundled font.
- A role face or music font that fails to load aborts an export, with the message, so a layout measured with the wrong face is never printed. The screen carries on with a fallback font and shows "A font could not be loaded".
- The status lines of the font panel (substituted symbols, missing glyphs, load failure) are inserted with their text, so some screen readers may not announce them.
- The "Music font is not loaded." guard in `configureEngraving` (`src/engraving/projection.ts`) is English only. It is an internal error that the loaders prevent from reaching a person (export awaits the music font and the screen falls back to Bravura), so it was left untranslated. The other new messages (fit check, role names, font load failure in an export) follow the interface language.
- Older builds refuse a document, edit log or style library that uses fonts (`deny_unknown_fields`; library version 3).
- Only the Typography disclosure is translated (English, Estonian, German); the rest of the Engraving panel is not.
- Not proven on the desktop: the roles Title block, Chord names, Staff text, Track names, Bar numbers, Tab numbers and Page footer (they share the code path and are covered by unit tests); a size-only role; PNG, SVG and print export (they use the pages that were measured, but only PDF was written); the glyph size of a rendered PDF page (the PDF's embedded font names and the SVG pages handed to the writer were checked, not the PDF drawn to pixels); a Mono role with default-italic elements; a failed font load; and a default document compared against a pre-D12 build (its font set was checked against the faces exports always used, not against a pre-D12 binary).
- The driver identifies the lyric, marker and chord text by its content, and the page header by its position. It fails safe (nothing found fails the check).
- Licence gate: all three Noto families, Petaluma and Leland are SIL OFL 1.1, so none was dropped. Petaluma and Leland carry a Reserved Font Name, and the Petaluma licence file says 2018 while its font name table says 2021 (both are cited in `THIRD_PARTY_NOTICES.md`).
- About 12.1 MB larger install (table above).

## Automated results

- `npm run typecheck`: clean.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: `--test engraving_protocol` 28 passed, `--lib style_library` 14 passed, `--lib export::pdf` 16 passed; `cargo fmt -- --check` clean. (Before develop was merged; the counts on the merged branch are 31, 15 and 17, see "After merging develop".)
- `npm test` (Node resource tests, then Vitest), run twice in full on a machine under load from other work: 17 failed of 5,646 in 4 files the first time, and 23 failed in 5 files the second time, different tests each time (the worktree also has no `.analysis/compatibility` fixtures). Every failing file passed when rerun alone: `WorkspaceApp.test.tsx`, `TrackSettingsPanel.test.tsx`, `library/content.test.ts` and `midi-import.test.ts` 122 of 122, and `App.test.tsx` 214 of 214 at a 60-second test timeout. The failures are load timeouts, not proven on a clean baseline.

## After merging develop

develop (D11 staff groups, then NAM captures) was merged into this branch (5c4166a, b859a14), and a review round followed (c70cf40, 546f5f3). Everything below was run on 2026-11-08 on 546f5f3, the code under test, with the two drivers' later edits kept out of the app build.

- Desktop test build from 546f5f3 with `scripts/build-desktop-test.ps1` (default target folder). `.analysis/desktop-smoke/tabplayer.exe` and `src-tauri/target/release/tabplayer.exe` have the same SHA-256 (`79041ee40cf1e847ac83fd0cfde883fc1057cce61e20aae20a5c2e6250bab826`, 76,209,152 bytes). Port 9223 was free before each run and the app was closed after.
- `tests/desktop/parity-font-roles.mjs`, two runs: each ended `font-roles: 23 passed, 0 failed.` The driver now also measures the visible page (`.score-pages .score-svg-chunk`), not only the hidden staging surface alphaTab draws into: the lyric, marker and glyph families and styles are asserted there for Petaluma, Leland and Bravura too.
- `tests/desktop/parity-staff-groups.mjs` (D11's driver, on the merged branch), two runs: each ended `staff-groups: 47 passed, 0 failed.` The hardcoded NOTE about the 34 px export size is now a check that the export pages draw the music font at the screen's size and that the export brace is not shorter than the screen brace within 1 px. It measured 36 px on screen and in the export pages, and a group brace of 536.61 px in both. Before D12 the export brace was 506.8 px (34/36 of 536.61 px), which is the "about 5.6% short" limit D11 recorded; that limit is resolved.
- `NO_GROUPS_SHA256` in `src/engraving/staff-groups.render.test.ts` is the SHA-256 of the exported pages of the three-track fixture without groups, recorded by D11 at a04f3c3 before any export code changed. It was `835470b6a122843f21a6bfd08659f6bbb75a9b629526b92386f7d0a5f6085113` and is now `5c3925802b6cf45dbbeec710ed5fe90365ee736c8953e75b2653e721f285cb42` (re-recorded in c70cf40). Why it changed: D12 moved the export music font from 34 px to alphaTab's `musicFontSize` (36 px), so the page style rule on all three pages went from `.at{font-family:Bravura;font-size:34px}` to `font-size:36px`. Nothing else in the pages changed. This was checked again here: hashing the current pages with that one rule changed back to 34 px gives exactly `835470b6...`.
- Counts on 546f5f3: `--test engraving_protocol` 31, `--lib style_library` 15, `--lib export::pdf` 17 passed; `cargo fmt -- --check` clean; `npm run typecheck` clean; `node --test scripts/*.test.mjs` 44 passed. `npm test` ran Vitest in full: 5,763 passed and 21 failed of 5,791 (7 skipped), in `App.test.tsx`, `WorkspaceApp.test.tsx`, `TrackSettingsPanel.test.tsx`, `library/content.test.ts` and `midi-import.test.ts`, the same tests as in the earlier full runs. Rerun alone, `WorkspaceApp`, `TrackSettingsPanel`, `content` and `midi-import` pass (122 of 122) and `App.test.tsx` passes 214 of 214 at `--testTimeout=60000`. The failures are timeouts under the full parallel run, not proven on a clean baseline.

# D12: font choices for music and text roles (THE-181)

Date: 2026-11-07. Status: design. Row D12 ("Music/text fonts, sizes and notation style presets") is partial today and stays partial until the source review, automated checks and one desktop run pass; even then it stays partial for the limits below.

## Brief

GP8's stylesheet sets a font, size and style per text kind and a music font. TabPlayer today has one text family for all text (a system font stack, screen only), three size scales and a fixed Bravura music font; exports always set text in Noto Sans ([typography design](2026-10-24-gp8-style-typography-design.md)). This slice adds:

- ten **text roles**, each with an optional bundled font, size, bold and italic, applied on screen and in every export (PDF, print, SVG, PNG);
- a **music font** choice of Bravura (default), Petaluma or Leland, on screen and in export;
- the fonts that make this work identically everywhere: Noto Sans, Noto Serif and Noto Sans Mono static faces, and the two extra SMuFL fonts with their metadata.

Nothing is a new edit command: the choices live in a new optional `engraving.fonts` field carried by the existing `setEngraving` edit. The GP8 manual's role and music-font lists were not available (no network during research); the role list below is the user's decision, not a copy of GP8.

## Roles and what each one drives

Every one of alphaTab 1.8.4's 36 `elementFonts` entries and its four number fonts belongs to exactly one role (defaults checked in `alphaTab.core.mjs` `RenderingResources.defaultFonts`). The page header and footer are TabPlayer's own text (D10, `src/engraving/page.ts`).

| Role id | Label | Drives | Size base |
|---|---|---|---|
| `titleBlock` | Title block | ScoreTitle, ScoreSubTitle, ScoreArtist, ScoreAlbum, ScoreWords, ScoreMusic, ScoreWordsAndMusic, ScoreCopyright (8). Screen only: export hides this block and prints the title in the page header. | each element's default (32/20/15/12 px) |
| `pageHeader` | Page header | D10 header band, on the screen page overlay and in export | 18 px |
| `pageFooter` | Page footer | D10 footer band, on the screen page overlay and in export | 11 px |
| `chordNames` | Chord names | EffectChordNames, ChordDiagrams, ChordDiagramFretboardNumbers (3) | 12/12/11 px |
| `staffText` | Staff text | EffectText, EffectDirections, EffectBeatTimer, EffectFingering, EffectCapo, EffectFreeTime, EffectTap, EffectPalmMute, EffectLetRing, EffectBeatBarre, EffectTripletFeel, EffectHarmonics, EffectPickSlide, EffectRasgueado, EffectWhammyBar, EffectHammerOnPullOffText, EffectSlideText, ScoreBendSlur, GuitarTuning (19) | each default |
| `lyrics` | Lyrics | EffectLyrics (1) | 12 px |
| `trackNames` | Track names | TrackNames (1) | 12 px |
| `barNumbers` | Bar numbers | BarNumber, RepeatCount (2) | 11 px |
| `markers` | Markers | EffectMarker, EffectAlternateEndings (2) | 14/15 px |
| `tabNumbers` | Tab numbers | `tablatureFont`, `graceFont`, `numberedNotationFont`, `numberedNotationGraceFont` (4) | 14/12/16/14 px |

8 + 3 + 19 + 1 + 1 + 2 + 2 = 36 element fonts, plus the four number fonts. A test enumerates `new Settings().display.resources.elementFonts` and fails if an element is unmapped or mapped twice.

Each role has four optional settings:

- **Font**: Source/default, Noto Sans, Noto Serif, Noto Sans Mono.
- **Size**: a percentage of each driven element's default size, like the existing scales (50% to 200%; tab numbers 75% to 150%). When set it replaces the group scale (`titleScale` for the title block and page header, `tabScale` for tab numbers, `textScale` for the rest; the footer had no scale before and uses 100%).
- **Bold** and **Italic**: Source/default, On, Off. Only available once a font is chosen for the role, because only bundled faces exist on both sides: the export has no system fonts and `usvg` cannot synthesize bold or italic, and the webview has `font-synthesis:none`. Source/default keeps each element's own style (for example staff text italic, markers bold).

A role without a chosen font keeps today's behaviour exactly: the typography Text font (a system stack) on screen and Noto Sans in export.

## Fonts

### Text faces (decision 2)

Noto Sans, Noto Serif and Noto Sans Mono, static TTF (glyf outlines), from `notofonts/noto-fonts` at the revision the bundled Noto Sans Regular is already pinned to (`ffebf8c1ee449e544955a7e813c54f9b73848eac`, `hinted/ttf/<Family>/<Family>-<Style>.ttf`). Each family Regular, Bold, Italic and Bold Italic; Noto Sans Regular is the file already bundled. The controller verifies each upstream path before pinning.

- **Noto Sans Mono is believed to have no italic** upstream (UNVERIFIED). If the pin task confirms that, Mono ships Regular and Bold only, Italic: On is refused for Mono in validation on both sides and unavailable in the panel with a reason, and a Mono role whose elements are italic by default (staff text, lyrics, chord names, track names) draws them upright on screen and in export alike. This is recorded as a limit.
- Static instances are required: `usvg` ignores variable axes and `svg2pdf` refuses CFF2. The pin task checks each file has no `fvar` table and no `CFF2` table.

### Music fonts (decision 3)

| Id | Family | Upstream (UNVERIFIED paths, pinned by commit SHA in the pin task) |
|---|---|---|
| `bravura` | Bravura | already bundled (`@coderline/alphatab@1.8.4 font/Bravura.otf`); alphaTab's built-in Bravura metadata |
| `petaluma` | Petaluma | `github.com/steinbergmedia/petaluma`, `redist/otf/Petaluma.otf`, `redist/petaluma_metadata.json`, its OFL text |
| `leland` | Leland | `github.com/MuseScoreFonts/Leland`, `Leland.otf`, `leland_metadata.json`, its licence file |

**Licence gate.** A controller task reads each licence file before anything is bundled. Each font must be under SIL OFL 1.1 (with or without a Reserved Font Name). Any font that is not is dropped: its enum value is not added, and this spec's limits name it. Expected: all OFL-1.1; Bravura and Petaluma carry an RFN (Bravura's is in `assets/fonts/Bravura-OFL.txt`).

**Unmodified files only.** Because of RFNs (the OFL FAQ shipped in `public/font/` says subsetting or format conversion makes a Modified Version that may not keep the name), every font and metadata file is shipped byte for byte as pinned. No subsetting, no woff conversion, no filtering of the metadata JSON. PDF embedding of subsets stays allowed (same FAQ). The screen loads the OTF directly.

### Pipeline

Each new file follows the existing font pipeline: an entry in `assets/fonts/sources.json` (filename, family, licence, licence file, source URL, revision, SHA-256), a licence text in `assets/fonts/`, `prepare-fonts.mjs` hash-checking and copying it to `public/export-fonts/`, `copy-notices.mjs` packaging the licences, and a line in `THIRD_PARTY_NOTICES.md`. Music entries carry `smuflMetadata:{filename,sha256}`, which `prepare-fonts.mjs` checks and copies too. Text and music font files are also `include_bytes!`'d into the native export font database (`src-tauri/src/export/pdf.rs`), as today; metadata JSON is web-only.

**Coverage test.** A new Node test (`scripts/font-coverage.test.mjs`, in `npm test`) reads each bundled face's `cmap`:

- every text face covers the Estonian and German set (Ä Ö Ü Õ ä ö ü õ ß ẞ Š š Ž ž „ “ ” ‘ ’ – — … € °);
- for ♯ and ♭ the chain (face, then Noto Sans, then Noto Sans CJK JP) covers them (Noto Sans lacks them; CJK JP has them);
- every music font has, for each SMuFL glyph alphaTab draws with Bravura (each name with a non-zero bbox in `EngravingSettings.bravuraMetadata`), the code point in its `cmap` and a bbox in its metadata, or the glyph is listed in a checked-in expected-substitution list for that font. The list is the coverage gate: a new gap fails the test until reviewed.
- the generated per-face coverage ranges (`src/engraving/font-coverage.json`, written by `scripts/font-coverage.mjs`) match the font files.

### Bundle size

Estimates before pinning (UNVERIFIED; the pin task records exact bytes in `sources.json` and the validation doc): Noto Sans Bold/Italic/BoldItalic about 1.7 MB, Noto Serif four faces about 2.4 MB, Noto Sans Mono two faces about 0.8 MB, Petaluma and Leland about 1 MB, metadata JSON about 1 MB. Fonts are stored twice (web copy and the native binary), metadata once: **about 12.8 MB added** to the installed app. Budget: 16 MB. If the measured total exceeds it, the controller stops and reports before committing (unhinted Noto faces are the fallback option).

## Screen

### Alias names

alphaTab's `FontSizes` builds a width table from `11px ${family}` with the family unquoted and caches it per family for the session. The screen therefore uses app-owned alias families without digit tokens: `TabPlayer Sans`, `TabPlayer Serif`, `TabPlayer Mono`, registered as `FontFace`s with `style`/`weight` descriptors over the pinned files. The native side maps each alias to its real family (below). Music fonts use their real names (Bravura, Petaluma, Leland; no digits).

A chosen role's font list is `[alias, 'Noto Sans', 'Noto Sans CJK JP', 'Noto Emoji']` on screen and in the export DOM, so the browser falls back through the same faces export uses when they are loaded. On screen CJK and Emoji are not awaited (they load with D10's page view or an export); until then the browser falls back to system faces, which the missing-glyph warning covers.

### Loading before the first render

`loadRoleFaces(fonts)` loads, once per face (memo per file, a failure clears that face's memo), only the faces the chosen roles need, plus Noto Sans Regular. ScoreView awaits it, and the music font data, before calling alphaTab render, so `FontSizes` never caches a table built on a fallback face. If a bundled face fails to load, the render proceeds with the stack's next face and the panel shows "A font could not be loaded" (the session's width table for that alias is then the fallback's; recorded as a limit).

### Music font switching: CSS override, not a new API

alphaTab registers its web font once, at `AlphaTabApi` construction, as family `alphaTab<N>` under `.at-surface.at<N> .at`, sized `engravingSettings.musicFontSize` px. Two ways to change it:

1. Re-create the `AlphaTabApi`: a new family and surface class, but ScoreView would have to tear down and rebuild its render, cursor, selection, bounds and chunk-copy wiring (which already copies the surface class), and alphaTab would also re-load Bravura.
2. **Chosen:** keep the API and override the glyph family with app CSS. ScoreView sets `data-music-font="<id>"` on its root; a stylesheet rule more specific than alphaTab's (`.score-view[data-music-font=petaluma] .at`, applying inside both the alphaTab surface and the copied page chunks) sets `font-family: Petaluma, 'TabPlayer Bravura'`. The size stays alphaTab's. Before rendering, the app loads the face and the metadata, then `configureEngraving` resets `resources.engravingSettings` to a fresh `EngravingSettings.bravuraDefaults` and, for a non-Bravura font, calls `fillFromSmufl(merged, musicFontSize)`, then re-renders.

Justification: one render instead of an API teardown, no change to the selection/cursor lifecycle, and the same rule covers the copied page chunks because they live under the same root. alphaTab's own non-SMuFL spacing stays Bravura-tuned (documented by alphaTab; a limit).

### No silent blank notation

alphaTab silently skips any symbol whose metadata bbox is zero. `mergeSmuflMetadata(chosen, bravura, needed)` fills every needed glyph name missing from the chosen metadata with Bravura's bbox and anchors and returns the substituted names. The CSS stack (`Petaluma, 'TabPlayer Bravura'`) and the export stack (`Petaluma, Bravura`) then draw those glyphs from Bravura. The panel lists the count ("N symbols are drawn from Bravura"). Together with the coverage test, a music font can never leave a symbol blank.

### Missing text glyph warning

For roles with a chosen font, the panel compares the score's own text for that role (title fields, header and footer text, chord names, beat text and directions, lyrics, track names, markers and section text) against the chosen face's coverage from `font-coverage.json`, and shows: "Noto Serif has no glyph for ‘ŋ’ (Lyrics); it is drawn from the fallback font." Numbers-only roles are skipped. The warning does not block anything.

## Export

- `renderPdfPages` keeps overwriting element families with the Noto stack, but only for elements in roles without a chosen font. Chosen roles keep `[alias, 'Noto Sans', 'Noto Sans CJK JP', 'Noto Emoji']` with their style, weight and size.
- Page header and footer items (`pageTextItems`) gain optional `family`, `weight`, `style`; the SVG text gains those attributes only when set, so default output stays byte-identical. The fit measure uses the alias.
- The page music CSS comes from one helper, `musicFontCss(size, families)`, with `size` = alphaTab's `engravingSettings.musicFontSize`: `.at{font-family:Bravura;font-size:36px}` or `.at{font-family:Petaluma,Bravura;font-size:36px}`.
- `assertTextFits` runs when typography is non-default **or** any role font is set.
- **Native resolution** (`pdf.rs` `export_options`):
  - The font database adds the new text faces under their real names and the music faces.
  - `select_font` maps each alias to its real family. A query naming no alias keeps today's result by asking for normal style and weight 400 (before this slice each literal family had exactly one face, so this is the face it got).
  - `select_fallback` only considers the four faces bundled before this slice, in their load order and with usvg's default style rule. New faces are never used as fallback, so default documents resolve every glyph as today, and a chosen role's chain is: chosen face → today's fallback order (Noto Sans → Noto Sans CJK JP → Noto Emoji; Bravura, loaded first, only supplies ♯ ♭ ♮ in text, which a characterization test pins before the change).

### The 34 px / 36 px question (verified first)

Export pages style glyphs with `.at{font-size:34px}` (`pdf.ts:35`, `page.ts:118`) while alphaTab 1.8.4 lays out with `engravingSettings.musicFontSize` 36 and styles the screen at 36 (`alphaTab.core.mjs` `:25332`, `:41062`); glyph groups emit `font-size: N%` relative to that. The plan's first code task tests it on a real render (an up-stem's x against the notehead's x plus `stemUpSE` × musicFontSize/4). If the layout assumes 36, the helper above uses `musicFontSize` and the only intended change to default export output is that glyph size. If the test shows 34 is right, the helper keeps 34 and the spec's limit says why.

## Data model and persistence (decision 4)

```ts
type TextFontId='notoSans'|'notoSerif'|'notoSansMono';
type MusicFontId='bravura'|'petaluma'|'leland';
type FontRole='titleBlock'|'pageHeader'|'pageFooter'|'chordNames'|'staffText'|'lyrics'|'trackNames'|'barNumbers'|'markers'|'tabNumbers';
interface RoleFont {font?:TextFontId;size?:number;bold?:boolean;italic?:boolean}
interface EngravingFonts {music?:MusicFontId;roles?:Partial<Record<FontRole,RoleFont>>}
// EngravingOverrides.fonts?: EngravingFonts
```

- Sibling of `typography`, which is untouched (its exact four-key check stays).
- Omitted when default at every level: no `music` for Bravura, no `roles` when empty, no `fonts` when empty. `withFonts` normalizes. Both sides accept an explicit default (`fonts:{}`, `music:'bravura'`, `roles:{}`), as they accept an all-default `typography`, and the panel never sends one. Validation refuses an empty role object, `null` values, unknown keys, unknown ids, a size outside its range, `bold`/`italic` without `font`, and `italic:true` with Mono when Mono has no italic.
- Rust: `EngravingFonts`, `RoleFonts` (ten `Option<RoleFont>` fields) and `RoleFont`, all `deny_unknown_fields`, fields `#[serde(default, skip_serializing_if = …)]` with a deserializer that refuses `null`; `EngravingOverrides.fonts` is `#[serde(default, skip_serializing_if = "EngravingFonts::is_default")]`. `TextFont` and `MusicFont` are closed `named_enum!`s.
- TS `validateEngraving` adds `fonts` to the allowed root keys only when present, as it does for `typography`, `barWidths` and `systemGaps`.
- Old projects and edit logs replay unchanged and serialize without the field; `tests/protocol.json` is unchanged. Older builds refuse a document or log that carries `fonts` (`deny_unknown_fields`); recorded limit.
- One Apply engraving is one `setEngraving`; Apply with an unchanged engraving records nothing (existing App guard, with `withFonts` normalization so `{}` never differs from absent).
- GP import and export do not read or write fonts (unchanged; GP stylesheet fonts stay native-only).

## Saved styles and presets (decision 5)

- `styleOf` keeps `fonts`; applying a style applies its fonts whole (a style without fonts clears them), as typography does.
- Library file version 3. Native reads 1, 2 and 3; a version 1 or 2 entry carrying `fonts` is damaged; reading never rewrites. A write picks the lowest version that can hold the content: 3 if any style has fonts, else 2 if any has typography, else 1. The client accepts only version 3 (native normalizes on read).
- Classic, Jazz and Rock do not set fonts; Load preset keeps the draft's fonts.

## Panel (Typography disclosure)

- Music font select (Bravura, Petaluma, Leland) with its substitution note.
- A role grid, one row per role: font select, size %, bold and italic selects (each labelled with the role, e.g. "Lyrics italic"). Bold and italic are unavailable with a reason until a font is chosen. The existing Text font and three size fields stay above it with their labels unchanged (desktop drivers use them).
- Missing-glyph and load-failure warnings as above. Everything fills the draft; Apply engraving sends one edit.
- Busy: the panel's `<fieldset disabled={busy}>` becomes `busyRegion(busy)`, and Apply and Reset use `busyGuard`, so a focused control is never disabled.
- i18n: all new text and the whole Typography disclosure (including the existing typography strings it shows) move to `src/i18n` with `en`, `et` and `de`; English wording of existing labels stays identical. The rest of the Engraving panel stays untranslated in this slice (recorded).

## Default look (decision 6)

A document without `fonts` looks exactly as today: system Arial/Georgia (or the typography stack) on screen, Noto Sans in export, Bravura. The only exception is the music glyph size in export if the 34/36 verification finds a bug. Screen and export are guaranteed to use the same faces only for roles with a chosen font.

## Acceptance

- Unit tests (names in the plan): role mapping completeness; validation agreement TS/Rust; omission and normalization; old-shape replay; style library versions; metadata merge; coverage gate; alias loading gate; export families per role; page text attributes; native alias resolution, default-request identity and fallback restriction; the 34/36 render test.
- Existing byte-identity tests (`page.test.ts`, `page-text.test.ts`, `pdf.test.ts`, `header-footer.test.ts`, `pdf-fonts.test.ts`) pass unchanged, apart from the music size literal if the verification changes it.
- Desktop (`tests/desktop/parity-font-roles.mjs`): set Lyrics to Noto Serif italic, Markers to Noto Sans Mono bold, Page header to Noto Serif 150%, music to Petaluma, as one edit; on screen the drawn text uses the alias faces and the music glyphs use Petaluma; the PDF's embedded font names include NotoSerif-Italic, NotoSansMono-Bold and Petaluma; undo, redo, save and reopen; switch to Leland and back to Bravura; a saved style round-trips the fonts in a version 3 library; a document without fonts exports as before.

## Limits to record

- D12 stays partial: no GP8 manual comparison, three bundled text families only, no user or system fonts, GP files do not carry fonts.
- Screen and export match only for roles with a chosen font; default roles keep system fonts on screen.
- The title block role affects the screen only; export prints the title in the page header (Page header role).
- Bold and italic need a chosen font. Noto Sans Mono has no italic (if confirmed).
- alphaTab measures text with an 11 px table of the first family for code points 32 to 254, ignoring bold and italic; wider faces can still run past a system end on screen. Export's fit check refuses them.
- Music fonts other than Bravura keep alphaTab's Bravura-tuned non-SMuFL spacing; substituted symbols are drawn from Bravura. The notation entry panel and palette keep Bravura.
- Older builds refuse documents, edit logs and style libraries that use fonts.
- Any font dropped by the licence gate is named here.
- About 12.8 MB larger install (exact figure in the validation doc).

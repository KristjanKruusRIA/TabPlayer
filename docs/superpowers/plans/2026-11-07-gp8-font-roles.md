# D12 Font Roles Implementation Plan (THE-181)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 0 and 9 belong to the controller; implementer subagents never download, build the desktop app or run desktop drivers.

**Goal:** Ten text roles (font, size, bold, italic) and a music font (Bravura, Petaluma, Leland) that look the same on screen and in every export, stored as one optional `engraving.fonts` field.

**Architecture:** Bundled static Noto faces and two extra SMuFL fonts enter the existing pinned font pipeline. `configureEngraving` maps roles onto alphaTab's 36 element fonts and four number fonts under app-owned alias families. ScoreView loads only the needed faces before rendering and overrides the music glyph family by CSS, re-filling `engravingSettings` from merged SMuFL metadata. Export keeps Noto for unchosen roles. The native font database maps aliases to real names and limits fallback to the faces bundled before this slice.

**Tech Stack:** React 19, TypeScript, alphaTab 1.8.4, Vitest, Node test runner, Rust/Tauri 2 with vendored usvg 0.45.1, fontdb 0.23 and svg2pdf 0.13. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-07-gp8-font-roles-design.md` (read it first; role table, alias names and limits are there).

## Global constraints

- Work only in `.worktrees/d12-font-roles` (branch `feature/d12-font-roles`). Never push.
- Old `.tabplayer` projects and edit logs replay unchanged; `tests/protocol.json` is unchanged.
- Documents without `fonts` render and export as today. The existing byte-identity tests (`page.test.ts`, `page-text.test.ts`, `pdf.test.ts`, `header-footer.test.ts`, `pdf-fonts.test.ts`) pass unchanged, except the music size literal if Task 1 changes it.
- Font and metadata files are shipped byte for byte as pinned: no subsetting, conversion or filtering (Bravura and Petaluma Reserved Font Names).
- No family name with a digit token reaches alphaTab `Font.families` (alias names only).
- New UI text goes through `src/i18n` with `en`, `et` and `de`; the English wording of existing labels does not change. No `disabled` for busy: `busyRegion`, `busyGuard`, `busySelect`.
- Do not touch `src-tauri/src/audio/tone.rs`, `src-tauri/gen/`, `src-tauri/resources/audio/`, `.analysis/compatibility/`, `vendor/usvg/`.
- Checks per task: `npm run typecheck`, the named Vitest or Node files, and for Rust `cargo test --locked --manifest-path src-tauri/Cargo.toml` with `--lib <module>` or `--test engraving_protocol`, plus `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`. Use the default `src-tauri/target` (or `E:/cargo-target/slot-1..3` if busy); never a scratchpad or per-task target folder.
- Commits: named files only, a BOM-free message file, `git commit -F`, message ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

1. **Default documents unchanged.** A document without `fonts` must export byte-identically (bar the Task 1 size fix), even though new faces sit in the native font database. Test: `default_requests_keep_pre_d12_faces` and `fallback_never_picks_new_faces` (Task 7), with the existing byte-identity tests.
2. **Replay and refusal.** Old logs without `fonts` replay and re-serialize without it; malformed `fonts` is refused identically by TS and Rust. Test: `fonts_absent_round_trips_byte_identical` and `fonts_validation_matches_typescript_cases` (Task 3).
3. **No silent blank notation.** A music font missing a glyph alphaTab draws must fall back to Bravura, never draw nothing. Test: `merge_fills_missing_bboxes_from_bravura_and_lists_them` (Task 6) and the coverage gate `music_fonts_cover_alphatab_symbols_or_list_substitutes` (Task 2).
4. **Width table poisoning.** alphaTab caches a per-family width table for the session; a render before the face loads corrupts layout. Test: `render_waits_for_role_faces_before_first_render` (Task 5) and `role_families_have_no_digit_tokens` (Task 5).
5. **Style library gate.** Older builds must keep reading libraries that do not use fonts, and v1/v2 files must never carry fonts. Test: `write_picks_lowest_version_for_content` and `v2_entry_with_fonts_is_damaged` (Task 4).

## Task 0 (controller): licence gate, download and pin

**Files:** `assets/fonts/` (new font, metadata and licence files), `assets/fonts/sources.json`.
**Produces:** pinned files and `sources.json` entries every later task reads; the final enum lists (a dropped font is removed from them) and whether Noto Sans Mono has an italic.

- [ ] Read each licence before downloading any font. Sources to verify and pin (paths UNVERIFIED until checked):
  - Noto: `https://raw.githubusercontent.com/notofonts/noto-fonts/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSans/NotoSans-{Bold,Italic,BoldItalic}.ttf`, `.../NotoSerif/NotoSerif-{Regular,Bold,Italic,BoldItalic}.ttf`, `.../NotoSansMono/NotoSansMono-{Regular,Bold}.ttf` (confirm there is no `NotoSansMono-Italic.ttf`); licence `.../LICENSE` at the same revision, saved as `NotoSerif-OFL.txt` and `NotoSansMono-OFL.txt`.
  - Petaluma: `github.com/steinbergmedia/petaluma` at a pinned commit SHA: `redist/otf/Petaluma.otf`, `redist/petaluma_metadata.json`, its OFL text (`Petaluma-OFL.txt`).
  - Leland: `github.com/MuseScoreFonts/Leland` at a pinned commit SHA: `Leland.otf`, `leland_metadata.json`, its licence (`Leland-OFL.txt`).
- [ ] Gate: each licence must be SIL OFL 1.1. Record any Reserved Font Name. If a font is not OFL-1.1, do not download it; tell the implementers to drop its enum value, and add it to the spec's Limits.
- [ ] Download each file into its own new empty folder under the scratchpad, then copy the files into `assets/fonts/`. Check with a read-only script run with paths as arguments (`node <script> <file>`): no `fvar` table, no `CFF2` table, family name (name ID 16, else 1) as expected (`Noto Sans`, `Noto Serif`, `Noto Sans Mono`, `Petaluma`, `Leland`), and the subfamily matches the style.
- [ ] Add `sources.json` entries in the existing shape (`filename,family,license,licenseFile,licenseSource,source,revision,sha256`, plus `copyright` where the licence names one). Music entries also get `"smuflMetadata":{"filename":"…","sha256":"…"}`. Record each file's byte size in the validation notes; stop if the total added (fonts ×2 + metadata) exceeds 16 MB.
- [ ] Commit: `chore: pin D12 role and music fonts (THE-181)`.

## Task 1: Verify the export music glyph size (34 vs 36 px)

**Files:** new `src/export/music-font-size.test.ts`; `src/engraving/page.ts`; `src/export/pdf.ts`; the one literal in `page.test.ts` / `pdf.test.ts` only if the size changes.
**Consumes:** `renderPdfPages`, `buildScore(blankProject())` as in `src/engraving/bar-widths.render.test.ts`.
**Produces:** `export function musicFontCss(size:number,families:readonly string[]):string` in `src/engraving/page.ts` (returns `.at{font-family:${families.join(',')};font-size:${size}px}`); `paginateEngravedSystems(...)` and `paginateSystems(...)` take an optional last argument `music?:{size:number;families:readonly string[]}` defaulting to `{size:new Settings().display.resources.engravingSettings.musicFontSize,families:['Bravura']}`.

- [ ] Write `music-font-size.test.ts`:
  - `layout_uses_alphatab_music_font_size`: render one bar with a quarter note (stem up) through `rendering.ScoreRenderer` (svg); find the notehead glyph (`<g … class="at"><text …>` U+E0A4) and the stem; assert the stem's x equals notehead x + `bravuraMetadata.glyphsWithAnchors.noteheadBlack.stemUpSE[0]` × `musicFontSize`/4 × scale within 0.5 px, with `musicFontSize` read from `new Settings()` (36).
  - `export_page_css_matches_layout_size`: `renderPdfPages(...)` page SVG contains `.at{font-family:Bravura;font-size:36px}`.
- [ ] Run `npx vitest run src/export/music-font-size.test.ts`. Expected: the first passes (the layout assumes 36) and the second FAILS (`34px`). If the first fails, stop and report: the premise is wrong and the spec keeps 34.
- [ ] Implement `musicFontCss` and use it in both page builders instead of the literal.
- [ ] Run the test file plus `npx vitest run src/engraving/page.test.ts src/engraving/page-text.test.ts src/export/pdf.test.ts src/engraving/header-footer.test.ts`; update only the `34px` literals those tests pin. PASS.
- [ ] Commit: `fix: export music glyphs at alphaTab's music font size (D12, THE-181)`.

## Task 2: Font catalog, coverage gate and notices

**Files:** new `src/engraving/font-catalog.ts`, `scripts/font-cmap.mjs`, `scripts/font-coverage.mjs`, `scripts/font-coverage.test.mjs`, generated `src/engraving/font-coverage.json`, `scripts/music-substitutes.json`; `scripts/prepare-fonts.mjs`, `scripts/copy-notices.mjs`, `package.json` (`test` script), `THIRD_PARTY_NOTICES.md`.
**Consumes:** Task 0 files.
**Produces:**
- `font-catalog.ts`: `export type TextFontId='notoSans'|'notoSerif'|'notoSansMono'`, `export type MusicFontId='bravura'|'petaluma'|'leland'`, `export interface TextFace {file:string;bold:boolean;italic:boolean}`, `export const textFonts:Record<TextFontId,{alias:string;family:string;label:string;faces:readonly TextFace[]}>` (aliases `TabPlayer Sans|Serif|Mono`), `export const musicFonts:Record<MusicFontId,{family:string;file:string;metadata:string|null}>`, `export const hasFace(font:TextFontId,bold:boolean,italic:boolean):boolean`.
- `font-cmap.mjs`: `export function codePoints(bytes:Uint8Array):Set<number>` (cmap formats 4 and 12).
- `font-coverage.json`: `{[filename:string]:Array<[number,number]>}` inclusive ranges; `font-catalog.ts` exports `export function covers(file:string,codePoint:number):boolean`.

- [ ] Write `scripts/font-coverage.test.mjs` (`node:test`):
  - `text_faces_cover_estonian_and_german`: every `textFonts` face file covers the set in the spec.
  - `sharp_and_flat_covered_by_chain`: for each face, ♯ ♭ are in the face, Noto Sans or Noto Sans CJK JP.
  - `music_fonts_cover_alphatab_symbols_or_list_substitutes`: for every name with a non-zero bbox in alphaTab's Bravura metadata (read from `node_modules/@coderline/alphatab` dist), each music font has the code point and a metadata bbox, or the name is in `scripts/music-substitutes.json[font]`; and every listed name really is missing.
  - `coverage_json_is_current`: rerunning `font-coverage.mjs` in memory equals the checked-in JSON.
  - `catalog_matches_sources`: every catalog file has a `sources.json` entry, and the reverse.
  - `notices_name_every_bundled_font`: `THIRD_PARTY_NOTICES.md` names each `sources.json` family.
- [ ] Run `node --test scripts/font-coverage.test.mjs`. Expected FAIL (modules missing).
- [ ] Implement the reader, the generator (writes the JSON), the catalog, the substitutes list (start empty, add only what the test reports, each reviewed), `prepare-fonts.mjs` copying and hash-checking `smuflMetadata`, `copy-notices.mjs` (already copies every `licenseFile`; confirm), and notice lines for Noto Serif, Noto Sans Mono, Petaluma and Leland, stating unmodified files and any RFN. Add the test file to `npm test`.
- [ ] Run `node --test scripts/font-coverage.test.mjs` and `node scripts/prepare-fonts.mjs`. PASS.
- [ ] Commit: `feat: D12 font catalog, coverage gate and notices (THE-181)`.

## Task 3: `engraving.fonts` data model (TS and Rust)

**Files:** new `src/engraving/fonts.ts` and `fonts.test.ts`; `src/engraving/types.ts`, `src/engraving/projection.ts` (`validateEngraving`); `src-tauri/src/engraving.rs`; `src-tauri/tests/engraving_protocol.rs`; shared fixture `tests/fixtures/engraving-fonts-cases.json`.
**Consumes:** `TextFontId`, `MusicFontId`, `hasFace` (Task 2).
**Produces (TS):** `export type FontRole=…` (ten ids), `export const FONT_ROLES:readonly FontRole[]`, `export interface RoleFont {font?:TextFontId;size?:number;bold?:boolean;italic?:boolean}`, `export interface EngravingFonts {music?:MusicFontId;roles?:Partial<Record<FontRole,RoleFont>>}`, `EngravingOverrides.fonts?:EngravingFonts`, `export function validateFonts(value:unknown):asserts value is EngravingFonts`, `export function fontsOf(e:Pick<EngravingOverrides,'fonts'>):{music:MusicFontId;roles:Partial<Record<FontRole,RoleFont>>}`, `export function isDefaultFonts(f:EngravingFonts|undefined):boolean`, `export function withFonts(e:EngravingOverrides,f:EngravingFonts):EngravingOverrides`, `export function sizeRange(role:FontRole):{min:number;max:number}`.
**Produces (Rust):** `named_enum!(TextFont {…})`, `named_enum!(MusicFont { Bravura = "bravura", Petaluma = "petaluma", Leland = "leland" })`, `pub struct RoleFont`, `pub struct RoleFonts` (ten `Option<RoleFont>` fields, camelCase), `pub struct EngravingFonts { pub music: MusicFont, pub roles: RoleFonts }` with `is_default()` and `validate()`, called from `EngravingOverrides` validation; field `#[serde(default, skip_serializing_if = "EngravingFonts::is_default")] pub fonts: EngravingFonts`. A `non_null` deserializer refuses `null` for the optional fields.

- [ ] Write the shared fixture `engraving-fonts-cases.json` (`{valid:[…],invalid:[…]}`). Invalid cases: empty role object, `null` values, unknown role, unknown key, unknown font or music id, size 0.49 / 2.01 (tab numbers 0.74 / 1.51), `bold` without `font`, `italic:true` with `notoSansMono` (only if Task 0 found no Mono italic). Valid cases: each range edge, `fonts:{}`, `music:'bravura'`.
- [ ] Write `fonts.test.ts`: `validation_cases_from_fixture`; `with_fonts_normalizes_defaults_away` (`{}`, `music:'bravura'` and `roles:{}` all yield no key; result is a new object, input unchanged); `validate_engraving_allows_optional_fonts_only_when_present`; `typography_exact_keys_unchanged`.
- [ ] Write Rust tests in `engraving_protocol.rs`: `fonts_validation_matches_typescript_cases` (reads the same fixture); `fonts_absent_round_trips_byte_identical` (an old `setEngraving` line serializes with no `fonts`); `default_fonts_never_serialized`; `fonts_history_undo_redo_save_reopen` (copy of the `system_gaps` history test); `old_log_replays_beside_fonts` (an old log plus a new fonts edit replays).
- [ ] Run `npx vitest run src/engraving/fonts.test.ts src/engraving/typography.test.ts` and `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`. Expected FAIL (missing types and field).
- [ ] Implement both sides to the signatures above.
- [ ] Rerun both, plus `npm run typecheck` and `cargo fmt … -- --check`. PASS.
- [ ] Commit: `feat: engraving.fonts field with matching validation (D12, THE-181)`.

## Task 4: Style library version 3

**Files:** `src-tauri/src/style_library.rs` (+ inline tests), `src/engraving/style-library.ts`, `style-library.test.ts`, `src/engraving/notation-presets.ts` (+ test).
**Consumes:** `EngravingFonts::is_default`, `isDefaultFonts`.
**Produces:** `const VERSION: u32 = 3`; `fn file_version(library:&StyleLibrary)->u32` (3 if any fonts, else 2 if any typography, else 1); TS `StyleLibrary.version:3`.

- [ ] Write Rust tests: `write_picks_lowest_version_for_content` (1, 2, 3 by content; removing the last fonts style writes 2 or 1); `v2_entry_with_fonts_is_damaged` and `v1_entry_with_fonts_is_damaged` (bytes left as they were); `v3_read_without_rewrite`; `versions_0_and_4_damaged`.
- [ ] Write TS tests: `client_accepts_only_version_3`; `style_of_keeps_fonts_and_applied_style_replaces_them`; `preset_load_keeps_draft_fonts` (Classic, Jazz, Rock set no fonts).
- [ ] Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib style_library` and `npx vitest run src/engraving/style-library.test.ts src/engraving/notation-presets.test.ts`. Expected FAIL.
- [ ] Implement: `parse_library` refuses fonts in versions 1 and 2 and lifts both to 3 in memory; `write_library` uses `file_version`; TS accepts 3; `presetApplied` keeps `draft.fonts`.
- [ ] Rerun. PASS.
- [ ] Commit: `feat: style library version 3 carries fonts (D12, THE-181)`.

## Task 5: Screen text roles and face loading

**Files:** `src/engraving/fonts.ts` (role mapping), new `src/engraving/font-loading.ts` (+ test), `src/engraving/projection.ts` (`configureEngraving`), `src/ScoreView.tsx`, `src/ScoreView.layouts.test.tsx`, `src/engraving/typography.test.ts`.
**Consumes:** Task 2 catalog, Task 3 types.
**Produces:**
- `export const roleElements:Record<'titleBlock'|'chordNames'|'staffText'|'lyrics'|'trackNames'|'barNumbers'|'markers',readonly NotationElement[]>` and `export const TAB_NUMBER_FONTS=['tablatureFont','graceFont','numberedNotationFont','numberedNotationGraceFont'] as const`.
- `export const FALLBACK_FAMILIES=['Noto Sans','Noto Sans CJK JP','Noto Emoji'] as const`.
- `export function configureRoleFonts(settings:Settings,fonts:EngravingFonts|undefined,typography:EngravingTypography):void`, called by `configureEngraving` after `configureTypography`; for each chosen role sets `families=[alias,...FALLBACK_FAMILIES]`, `weight`/`style` from `bold`/`italic` (else the element default) and size `default × (role.size ?? group scale ?? 1)`; a size-only role changes size only.
- `export interface PageRoleFont {family:string|null;bold:boolean;italic:boolean;scale:number|null}` and `export function pageRoleFont(fonts:EngravingFonts|undefined,role:'pageHeader'|'pageFooter'):PageRoleFont` (`family` is the alias, or null for the default Noto stack).
- `font-loading.ts`: `export function neededFaces(fonts:EngravingFonts|undefined):TextFace[]`; `export function loadRoleFaces(fonts:EngravingFonts|undefined):Promise<{failed:string[]}>` (memo per file; adds a `FontFace(alias,url(/export-fonts/<file>),{weight,style})` after it loads; a failure clears that memo and is reported, not thrown).

- [ ] Write tests:
  - `role_mapping_covers_every_element_once`: union of `roleElements` equals the keys of `new Settings().display.resources.elementFonts`, with no element twice (36).
  - `role_families_have_no_digit_tokens`: every alias and every family `configureRoleFonts` writes matches `/^[A-Za-z]+( [A-Za-z]+)*$/`.
  - `chosen_role_sets_family_style_weight_size` and `unchosen_roles_keep_typography_result` (compare to `configureTypography` alone); `size_only_role_scales_without_family`; `reconfigure_restores_defaults` (a second call without fonts gives the renderer defaults).
  - `needed_faces_only_for_chosen_roles`; `load_failure_reported_and_retried` (stub `FontFace`).
  - In `ScoreView.layouts.test.tsx`: `render_waits_for_role_faces_before_first_render` (a deferred `loadRoleFaces` stub: no alphaTab render until it resolves); `fonts_change_rerenders_once`.
- [ ] Run `npx vitest run src/engraving/typography.test.ts src/engraving/font-loading.test.ts src/ScoreView.layouts.test.tsx`. Expected FAIL.
- [ ] Implement. ScoreView gates the render on `loadRoleFaces(engraving.fonts)` with its existing render-generation guard, and passes failures up through a new `onFontStatus?(status:{failed:string[];substituted:string[]})` prop (the panel shows it in Task 8). The D10 overlay uses `pageRoleFont` for family, weight, style and size.
- [ ] Rerun, plus the existing ScoreView tests. PASS.
- [ ] Commit: `feat: text roles drive alphaTab element fonts on screen (D12, THE-181)`.

## Task 6: Music font switching on screen

**Files:** `src/engraving/font-loading.ts` (+ test), `src/engraving/projection.ts`, `src/ScoreView.tsx`, `src/ScoreView.css`, `src/ScoreView.layouts.test.tsx`.
**Consumes:** `musicFonts` (Task 2), `musicFontCss` (Task 1).
**Produces:**
- `export interface MusicFontData {id:MusicFontId;families:readonly string[];metadata:SmuflMetadata|null;substituted:string[]}`.
- `export function mergeSmuflMetadata(chosen:SmuflMetadata,base:SmuflMetadata,needed:readonly string[]):{metadata:SmuflMetadata;substituted:string[]}`.
- `export function loadMusicFont(id:MusicFontId):Promise<MusicFontData>` (Bravura resolves at once with `metadata:null`; others fetch the metadata, load `FontFace(family)` and `FontFace('TabPlayer Bravura', url(/export-fonts/Bravura.otf))`, merge against `EngravingSettings.bravuraMetadata`; memo per id).
- `configureEngraving(settings:Settings,value:EngravingOverrides,music?:MusicFontData|null):void`: always sets `resources.engravingSettings=EngravingSettings.bravuraDefaults`, then `fillFromSmufl(metadata, musicFontSize)` for a non-Bravura font. It throws `Music font is not loaded.` when the value names a non-Bravura font and `music` is missing or names another id.

- [ ] Write tests:
  - `merge_fills_missing_bboxes_from_bravura_and_lists_them` (a chosen metadata missing `noteheadBlack` gets Bravura's bbox and anchors; `substituted` is `['noteheadBlack']`; present glyphs keep the chosen values).
  - `configure_resets_to_bravura_defaults` (after Petaluma, a Bravura configure equals `bravuraDefaults`); `configure_throws_without_loaded_music`.
  - `music_font_css_rule_targets_surface_and_chunks` (ScoreView root has `data-music-font`, and the stylesheet rule matches `.at` inside `.at-surface` and `.score-pages`).
  - `music_change_rerenders_after_load`.
- [ ] Run `npx vitest run src/engraving/font-loading.test.ts src/ScoreView.layouts.test.tsx`. Expected FAIL.
- [ ] Implement. The CSS rule for each id sets `font-family:<Family>,'TabPlayer Bravura'` with higher specificity than alphaTab's `.at-surface.at<N> .at`; the size stays alphaTab's. ScoreView awaits `loadMusicFont` alongside the role faces and passes the data to `configureEngraving`.
- [ ] Rerun. PASS.
- [ ] Commit: `feat: switch the music font on screen by CSS override (D12, THE-181)`.

## Task 7: Export with role and music fonts (webview and native)

**Files:** `src/export/pdf.ts`, `src/engraving/page.ts`, `src/export/page-title.ts`, `src/export/useExportCoordinator.ts`, tests `src/export/font-roles.render.test.ts`, `src/engraving/page-text.test.ts`; `src-tauri/src/export/pdf.rs` (+ inline tests).
**Consumes:** Tasks 1, 2, 3, 5, 6.
**Produces:**
- `export function applyExportFamilies(settings:Settings,fonts:EngravingFonts|undefined):void` (Noto stack only on elements and number fonts of unchosen roles).
- `renderPdfPages(score,selection,layout,options?:{page;engraving;trackIds;music?:MusicFontData})`.
- `PageTextItem` gains optional `family?:string;weight?:'bold';style?:'italic'`; `pageTextSvg` writes `font-family`, `font-weight` and `font-style` only when set. `pageTextItems` input gains optional `header?:PageRoleFont;footer?:PageRoleFont`. `measurePageText(text,size,family?)`.
- Rust: `const FONT_ALIASES: [(&str, &str); 3]`; `fn alias_font_selector() -> usvg::FontSelectionFn<'static>`; `fn legacy_fallback_selector(allowed: Vec<usvg::fontdb::ID>) -> usvg::FallbackSelectionFn<'static>`; `export_options()` sets `options.font_resolver` from both.

- [ ] Write the Rust characterization test first and run it against the unchanged code: `sharp_in_text_resolves_like_before` records which face serves ♯, ♭ and ♮ in default `Noto Sans` text; it must PASS before any change.
- [ ] Write Rust tests: `alias_family_resolves_real_face_with_style` (`TabPlayer Serif` bold italic gives NotoSerif-BoldItalic); `default_requests_keep_pre_d12_faces` (`Noto Sans` italic and bold, `Bravura`, CJK and Emoji resolve to the same faces as before); `fallback_never_picks_new_faces` (a glyph missing from Noto Serif falls to Noto Sans, never to another new face); `petaluma_missing_glyph_falls_back_to_bravura`; `pdf_embeds_chosen_faces` (a page with alias text and Petaluma glyphs embeds those fonts).
- [ ] Write Vitest tests: `export_keeps_noto_for_unchosen_roles_and_alias_for_chosen`; `page_text_attributes_only_when_role_set` (default items render to the pinned literals); `export_music_css_uses_chosen_family`; `fit_check_runs_when_fonts_set`; `export_awaits_role_faces_and_music` (coordinator calls both loaders before rendering).
- [ ] Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib export::pdf` and `npx vitest run src/export/font-roles.render.test.ts src/engraving/page-text.test.ts src/export/pdf.test.ts`. Expected FAIL for the new tests only.
- [ ] Implement: native loads the new faces, adds the selectors (no alias in the query means normal style, weight 400), and keeps fallback to the four pre-D12 face IDs in load order with usvg's default style rule. Webview implements the signatures above and the coordinator awaits `loadRoleFaces` and `loadMusicFont` next to `loadExportFonts`.
- [ ] Rerun, plus `header-footer.test.ts`, `page.test.ts`, `pdf-fonts.test.ts`, `text-bounds.test.ts` and `cargo fmt … -- --check`. PASS with the pinned literals unchanged.
- [ ] Commit: `feat: export role and music fonts with alias resolution (D12, THE-181)`.

## Task 8: Panel, warnings, i18n and busy handling

**Files:** new `src/engraving/FontRolesFields.tsx` (+ test), `src/engraving/TypographyFields.tsx`, `src/engraving/EngravingPanel.tsx` (+ test), `src/engraving/fonts.ts` (`roleTexts`, `missingGlyphs`), `src/i18n/en.ts`, `et.ts`, `de.ts`, `src/App.tsx` (font status wiring only).
**Consumes:** Tasks 2, 3, 5, 6 (`onFontStatus`).
**Produces:** `export function roleTexts(score:model.Score,fields:HeaderFields,headerFooter?:HeaderFooter):Partial<Record<FontRole,string[]>>`; `export function missingGlyphs(fonts:EngravingFonts|undefined,texts:Partial<Record<FontRole,string[]>>):Array<{role:FontRole;chars:string[]}>`; `FontRolesFields({value,onChange,busy,texts,status}:{value:EngravingFonts|undefined;onChange:(f:EngravingFonts)=>void;busy:boolean;texts:Partial<Record<FontRole,string[]>>;status:{failed:string[];substituted:string[]}|null})`.

- [ ] Write tests:
  - `role_grid_fills_draft_and_apply_sends_one_set_engraving`; `apply_unchanged_fonts_records_nothing` (draft `{}` against absent).
  - `bold_italic_unavailable_until_font_chosen` (`aria-disabled`, reason text, no `disabled` attribute); `mono_italic_unavailable_with_reason` (if Mono has no italic).
  - `missing_glyph_warning_names_role_and_char` (a lyric `ŋ` against a face without it, from `font-coverage.json`).
  - `substituted_music_symbols_count_shown`; `font_load_failure_shown`.
  - `busy_keeps_focus_and_refuses_changes` (focused select stays focused and enabled while `busy` flips; a change is refused).
  - `typography_labels_unchanged_in_english` ("Text font", "Text size (%)", "Title size (%)", "Tab number size (%)").
  - The existing i18n catalog test passes with the new keys in all three languages.
- [ ] Run `npx vitest run src/engraving/FontRolesFields.test.tsx src/engraving/EngravingPanel.test.tsx src/i18n/i18n.test.ts`. Expected FAIL.
- [ ] Implement. Replace `<fieldset disabled={busy}>` with `<fieldset {...busyRegion(busy)}>`, use `busyGuard` on Apply and Reset and `busySelect` on the new selects. Move the Typography disclosure's text (new and existing) to i18n keys under `typography.*` and `font_roles.*`. Update existing EngravingPanel tests that asserted `disabled`.
- [ ] Rerun, plus `npm run typecheck`. PASS.
- [ ] Commit: `feat: font roles panel with glyph warnings, translated (D12, THE-181)`.

## Task 9 (controller): desktop proof, validation doc and tracker

**Files:** new `tests/desktop/parity-font-roles.mjs` (based on `parity-style-typography.mjs`), `docs/validation/<run date>-gp8-font-roles.md`, `docs/validation/2026-10-15-gp8-parity-progress.md` and `.json` (D12 row), `docs/validation/2026-10-30-gp8-style-typography.md` (Limits pointer).

- [ ] Run `npm test`, `npm run typecheck`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`, `--lib style_library`, `--lib export::pdf` and `cargo fmt … -- --check` yourself; do not rely on implementer reports.
- [ ] Build with `scripts/build-desktop-test.ps1` (default target folder), confirm `.analysis/desktop-smoke/tabplayer.exe` is the new build, then run the driver on the stylesheet fixture:
  - a default document exports a PDF whose text font set equals the pre-D12 build's (`NotoSans`, plus CJK and Emoji where used);
  - apply Lyrics = Noto Serif italic, Markers = Noto Sans Mono bold, Page header = Noto Serif 150%, music = Petaluma as one edit (history grows by one); drawn text uses the alias families (`getComputedStyle`), music glyphs use Petaluma;
  - PDF embeds NotoSerif-Italic, NotoSansMono-Bold, NotoSerif-Regular and Petaluma; no text past the paper edge;
  - the score's own text with a character outside the chosen face shows the warning;
  - undo, redo, save, reopen; switch to Leland, then Bravura; the native playback generation is unchanged;
  - save a style with fonts (library becomes version 3), remove it (back to 2 or 1), using the driver's isolated profile.
- [ ] Write the validation doc: behaviour, evidence (commands and results), exact added bytes per file and total, the 34/36 outcome, and every limit from the spec (plus any font the licence gate dropped). Update the D12 row: keep **partial**, list what is now supported and the remaining limits.
- [ ] Commit: `docs: record the D12 font roles desktop run (THE-181)`.

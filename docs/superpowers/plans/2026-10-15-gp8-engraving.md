# Guitar Pro 8 Engraving and Display Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already approved parallel feature workers and all in-scope parity changes; root schedules execution after current clipboard/practice acceptance.

**Goal:** Persist public native/PDF engraving, render selected/all/chosen tracks with source/standard/tab/slash/numbered profiles and arbitrary zoom, and export independent/custom physical page geometry without changing music or practice playback.

**Architecture:** New owned modules validate finite presentation overrides and produce detached render projections with canonical-ID mappings. Root integrates settings-only native history, display rendering independent of musical preparation, and the same projection into the existing PDF pipeline. Source GP style remains untouched; unknown style-schema and full-engraving parity stay open.

**Tech Stack:** Rust/Tauri, React/TypeScript, alphaTab1.8.4, fflate0.8.3, existing SVG/vector-PDF pipeline and bundled Bravura/Noto fonts, Vitest.

**Spec:** [Engraving and display foundation](../specs/2026-10-15-gp8-engraving-design.md), supporting [the umbrella parity design](../specs/2026-10-15-gp8-feature-parity-design.md). Canonical DTO bodies/public mappings/provenance and remaining families live in the subsystem spec; executors read both.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old command JSON and replay meaning remain compatible.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes or dependency patches.
- Keep the approved three-column slate/cream/lime editor and realistic instrument views/assets. Do not replace them with generic placeholders or a new layout.
- Root owns shared DTOs/validators, controller/engine, App/ScoreView/EditorPanel, playback/export integration, native registration, source lifetimes, Git, applications and final verification. Workers own only assigned new modules/panels/tests.
- Presentation edits are atomic native history entries. Session visibility/zoom do not dirty the document. No presentation change may change notes, timing, source bytes, audio settings, backing, raw lyrics or surviving relationships.
- Use public renderer/model APIs and demonstrated standard file fields. Do not guess score.gpss, invent GPIF extensions, or expose arbitrary alphaTab JSON as a command.
- Model retention, rendered image/PDF quality, native replay, musical output, GP8 target-runtime fidelity and physical printing are separate acceptance checks.
- This batch writes native document/PDF presentation only. GP export preserves original/default source style; faithful export of changed GP styles remains open.

## Review Focus

1. A displayed clone must resolve clicks, range handles and note bounds to the correct canonical note after multitrack/zoom/structural changes — Tasks1/3/5.
2. Inherit/reset and index-keyed source exceptions must retain imported style rather than move an exception to the neighboring track — Tasks1/4.
3. Settings-only apply/undo/redo during playback/practice must not reprepare, seek, restart or overwrite the styled render — Tasks4/5.
4. Custom/asymmetric pages and dense systems must remain physically correct and unclipped in final rendered PDF images, independently of model tests — Tasks2/5.
5. Old histories, frozen exports, source archive/style/backing/lyrics/links/dynamics and unchanged MIDI must survive every projection/replay — Tasks1/4/5.

---

## File map and ownership

- Root stages `src/engraving/types.ts` with the exact spec types and interface declarations before dispatch. It modifies shared TypeScript/Rust schemas and settings routing later. Root does not concurrently edit workers' implementations.
- Engraving worker owns `src/engraving/projection.ts`, `projection.test.ts`, `EngravingPanel.tsx`, `EngravingPanel.test.tsx`. Implements default factory/validation/projection/configuration/source-map remapping and panel. Task1.
- Page worker owns `src/engraving/page.ts`, `page.test.ts`, `PageLayoutPanel.tsx`, `PageLayoutPanel.test.tsx`. Implements pure legacy conversion/geometry/pagination and panel. Task2.
- Display helper worker, or root if fewer workers are used, owns `src/engraving/view.ts`, `view.test.ts`, `TrackDisplayControls.tsx`, `TrackDisplayControls.test.tsx`. Implements session view resolution and toolbar/track-eye controls only. Task3.
- Root owns `src/edit-types.ts`, `document-settings.ts`, `parity-commands.ts`, `engine.ts`, `controller.ts`, App/EditorPanel/ScoreView/styles integration, NativePlaybackController, existing PDF/export files, Rust edit/settings/project registration, and new `src/engraving/replay.test.ts`, `tests/desktop/engraving.mjs`. Tasks4/5.
- Feature workers run focused tests only and report RED/GREEN evidence. No applications, full suites/builds, dependencies, Git changes or edits to another owner. Root performs cross-feature/native/desktop work after integration.

### Task 1: Validated source-aware projection and engraving panel

**Files:** Create projection module/tests and EngravingPanel/tests listed above; consume root types unchanged.

**Interfaces:** Produce `defaultEngraving():EngravingOverrides`, `validateEngraving(value:unknown):asserts value is EngravingOverrides`, `validateEngravingTracks(score:model.Score,ids:readonly string[],value:EngravingOverrides):void`, `projectEngraving(source:model.Score,ids:readonly string[],value:EngravingOverrides):EngravingProjection`, `configureEngraving(settings:Settings,value:EngravingOverrides):void`, and `remapStylesheetTracks(stylesheet:model.Score['stylesheet'],oldToNew:Array<number|null>):void`. Panel consumes the exact spec props and emits one complete setEngraving command.

- [ ] Write `inherit_and_reset_preserve_source_style_without_mutation`: source hideDynamics=true and a per-track tuning exception; inherit projection retains them, explicit hideDynamics=false changes only clone, Reset default restores source true. Compare source public JSON, style maps, raw lyric cache, backing bytes and note relationships before/after.
- [ ] Write `finite_override_validation_is_atomic`: all enum boundaries/nulls, missing/extra nested keys, nonfinite spacing, factor below0.25/above4, duplicate/empty profile IDs, and invalid profile strings reject. A valid first field followed by invalid final field must not mutate source/applied settings. Two default factories have independent arrays/objects.
- [ ] Write `profiles_preserve_music_and_canonical_identity`: guitar, piano-grand-staff and percussion fixtures; assert the spec's exact four-flag tuple for every profile, starting from source `(true,true,true,true)` to catch stale flags. source preserves that mixed tuple; explicit standard/tablature/standardTab/slash/numbered replace all four together. Source model stays unchanged; tablature-only with untuned staff and numbered percussion reject. IDs map both directions to original/rendered objects. Independently decode unchanged MIDI keys/velocities/ticks after every profile/style combination. Temporary PDF Score/Tab/ScoreTab profiles obey the same full tuples/applicability checks.
- [ ] Write `known_public_fields_and_maps_are_projected_exactly`: table-drive every spec stylesheet/notation mapping, explicit tuning/chord global overrides clearing clone-only maps, bar-number override clearing clone-only per-bar values, all/none multirest sets, and dormant empty-first-system choice. Do not change Chord.showDiagram, notationMode, transpositions or settings core/player/resources.
- [ ] Write `source_track_maps_follow_surviving_identity`: tuning/chord/multirest source exceptions at old index1 become index0 after removing track0; reorder mapping is injective; removed entries disappear; arbitrary unrelated style fields remain equal. Validate invalid maps before mutation.
- [ ] Run `npx vitest run src/engraving/projection.test.ts`; confirm meaningful RED from missing behavior, not unresolved root registration.
- [ ] Implement a detached scoreFromJson clone with restored links and copyGpInterchangeSource. Preserve IDs; no custom model properties. Apply only finite public mappings. configureEngraving resets owned fields/three element-map keys to defaults when inherit and preserves unrelated configuration. systemSpacing multiplies only the three documented default system padding fields.
- [ ] Write `engraving_panel_roundtrips_source_choices_and_profiles`: displayed effective source/default values are distinct from overrides; named choices match finite options; Apply emits exact full object once; Reset emits defaultEngraving; profile IDs use provided source IDs, not cloned identities; busy disables and applied-value/document changes reset drafts. Existing inspector styling remains compact.
- [ ] Run `npx vitest run src/engraving/projection.test.ts src/engraving/EngravingPanel.test.tsx`; require GREEN. Report exact exports and source-map/remap expectations to root.

### Task 2: Backward-compatible page geometry, pagination, and panel

**Files:** Create page module/tests and PageLayoutPanel/tests listed above. No edits to existing export/pdf.ts from this worker.

**Interfaces:** Produce `effectivePageLayout(settings:Pick<DocumentSettings,'page'|'print'>):PageLayout`, `validatePageLayout(value:unknown):asserts value is PageLayout`, `pageGeometry(layout:PageLayout):PageGeometry` with the exact spec result fields, and `paginateEngravedSystems(systems:SvgSystem[],title:string,layout:PageLayout):SvgPage[]`. PageLayoutPanel consumes spec props and emits one complete setPageLayout command.

- [ ] Write `legacy_print_conversion_retains_old_geometry`: legacy A4/Letter portrait/landscape, equal15mm margins, scale/profile produce exactly the former physical dimensions, margins, header/footer reservations and page grouping. page null means legacy; nonnull page wins without modifying print.
- [ ] Write `asymmetric_custom_page_has_one_physical_truth` using width180/height240mm, margins `{top:10,right:12,bottom:14,left:16}`, scale1/profile document. With `p=96/25.4`:

```ts
expect(g.usableWidth).toBeCloseTo(152*p);
expect(g.usableHeight).toBeCloseTo(216*p-64);
expect(g.left).toBeCloseTo(16*p);
expect(g.top).toBeCloseTo(10*p);
```

- [ ] Write `pagination_uses_sides_and_rejects_clipping`: two400px systems produce two pages under the custom geometry; first system origin is `(16*p,10*p+40)`, footer y=`240*p-14*p`; SVG viewBox/page mm match. Scale2 leaves page/margins unchanged. Oversize system/width, invalid/nonfinite sides, dimensions outside20..1000, unusable body below100px, invalid profile/unknown keys and scale outside0.25..3 reject. Escape title `A&B <solo>`.
- [ ] Run `npx vitest run src/engraving/page.test.ts`; confirm RED.
- [ ] Implement geometry/whole-system pagination with the fixed existing title/page-number convention and no second notation renderer. Presets are panel conveniences filling final dimensions; orientation swaps dimensions, no second persisted enum truth.
- [ ] Write `page_panel_emits_exact_layout_and_presets`: A3/A4/A5/Letter/Legal exact spec dimensions, swap orientation, four independently edited margins, scale/profile document, Apply once, busy/reset behavior. Invalid geometry dispatches nothing and leaves applied state untouched. Root keys/remounts the draft by documentEpoch on document replacement.
- [ ] Run `npx vitest run src/engraving/page.test.ts src/engraving/PageLayoutPanel.test.tsx`; require GREEN. Handoff helper/wrapper integration to root without editing existing PDF files.

### Task 3: Session visibility and arbitrary zoom controls

**Files:** Create view helper/control files/tests listed above. Root owns actual ScoreView/App integration.

**Interfaces:** Produce `resolveVisibleTracks(ids:readonly string[],selected:number,view:TrackView):number[]` and TrackDisplayControls with props `{ids:readonly string[];names:readonly string[];selected:number;view:TrackView;zoom:number;disabled:boolean;onView:(view:TrackView)=>void;onZoom:(zoom:number)=>void}`. TrackView is the exact session union in the spec. Inputs/outputs use source track IDs; do not import controller state or modify document history.

- [ ] Write `selected_all_and_custom_follow_live_source_order`: IDs `[base/0,added/3,base/1]`, custom `[base/1,base/0]` resolves `[0,2]`; selected follows the root-repaired active index; all includes added tracks. Removing an ID preserves surviving choices; empty repaired custom falls back to active. Selecting a hidden track does not alter the custom set. Source IDs are the existing engine identities, not a second identity allocator.
- [ ] Write `view_controls_never_hide_final_track_or_dirty_document`: prevent hiding last live eye, switch selected/all/custom, name/ID match after removal, busy disabled and numeric zoom25,100.5,300 accepted; NaN/blank/out-of-range does not dispatch. No edit/history callback exists on this component.
- [ ] Run `npx vitest run src/engraving/view.test.ts src/engraving/TrackDisplayControls.test.tsx`; confirm RED.
- [ ] Implement minimal finite controls in existing toolbar/track-card style, no panel redesign or persistent preferences. DocumentEpoch reset remains root's responsibility.
- [ ] Repeat focused tests; require GREEN. Report exact props and render indices to root.

### Task 4: Root history, schema compatibility, source provenance, and PDF integration

**Files:** Root modifies shared TypeScript/Rust types/settings/validators/controller/engine/export/PDF files; creates `src/engraving/replay.test.ts` and native/shared schema cases. Consumes Tasks1–3 unchanged.

**Interfaces:** Register exactly setEngraving/setPageLayout as SettingsEdit variants; derive settings.engraving/default and settings.page/null from native source/history. Existing setPrintLayout JSON stays unchanged and explicitly clears page on later application. Add optional rendering argument `{page,engraving,trackIds}` to existing renderPdfPages(score,selection,legacyLayout), retaining old call compatibility.

- [ ] Write `engraving_schema_shapes_match_native_and_frontend`: complete valid objects with every required null/enum/array; reject missing/unknown nested keys, invalid enum/bounds, duplicate/empty profile IDs and nonfinite values. Current-track membership is frontend score-dependent preflight before bridge submission; native validates shape/domain/nonempty/distinct IDs without pretending to parse alphaTab source.
- [ ] Write `old_project_and_print_history_retain_meaning`: existing version1 normalization/version2 histories load; derived new settings default; old setPrintLayout data still decodes and renders the same. Sequence setPageLayout then legacy setPrintLayout returns page null; undo restores prior custom page. New malformed commands do not append native history or change controller state.
- [ ] Write `presentation_history_changes_only_settings`: setEngraving/setPageLayout preview returns canonical score reference unchanged; undo/redo/save/native restart/reopen reproduce complete overrides. Compare music JSON, source hash/bytes, captured links, per-note dynamics, raw lyric source/visibility/slots, embedded backing and mixes/sounds. Source map remapping follows actual track identity after structural removal/selection.
- [ ] Write `presentation_after_paste_preserves_canonical_references`: create a valid delivered clipboard fixture with pasteMusic already in history and embedded backing, retain the post-paste score/backing references, then apply setEngraving and setPageLayout, undo both and redo both. Every transition must retain `state.score === pastedScore` and `state.embeddedBacking === pastedBacking` while producing the correct presentation settings/backing maps. Protect the current clipboard replay fallback, which now derives fallback settings/maps but explicitly keeps current.score/current.embeddedBacking; do not redo that implementation.
- [ ] Write `export_freezes_presentation_and_keeps_source_gp_styles`: start PDF export, change document style/page, and assert frozen output still uses launch settings; cancel leaves native state intact. GP export uses canonical score; generated valid source fixture has original BinaryStylesheet/PartConfiguration/LayoutConfiguration plus an opaque `Content/score.gpss` sentinel. Assert those source entries/siblings remain byte-identical, and never parse or claim the sentinel as understood style.
- [ ] Run focused new replay/schema tests and existing print/export snapshot cases; confirm RED. Use strict Rust DTOs/defaulting only for missing derived DocumentSettings fields, not missing new command fields.
- [ ] Implement settings-only routing/defaults/replay, source-ID preflight, legacy precedence and dormant removed-profile behavior. Do not call beforeScoreChange for these commands. Extend Rust DocumentSettings for existing audio IPC payload compatibility while leaving audio behavior unchanged.
- [ ] Integrate one existing PDF renderer: selectStaves retains original indices; apply common projection/configuration; document profile uses actual cloned flags, legacy profiles remain explicit temporary overrides with no tab on untuned/percussion staves; use page helpers/whole-system overflow rejection. Suppress all native header metadata consistently to avoid duplicate fixed title/credits. Respect explicit export tracks/staves/range independently of screen visibility.
- [ ] Extend export/page UI and frozen settings; show the actual native/PDF-only GP styling boundary. Preserve source archives and existing music adapters rather than replacing generated/original style merge order without proven schema support.
- [ ] Run new module/replay/panel tests, existing `src/export/pdf.test.ts`, relevant export-coordinator tests, `npm run typecheck`, and native command/settings/project tests. Suggested native filters use `cargo test --manifest-path src-tauri/Cargo.toml engraving_` for added unit cases plus existing `--test project_v2`/`--test project_history` after inspecting actual names. Root alone broadens checks after integration.

### Task 5: Root rendering/audio separation and rendered acceptance

**Files:** Root modifies ScoreView/App/NativePlaybackController/shared layout integration and creates `tests/desktop/engraving.mjs`, focused ScoreView/controller regressions, and final validation receipts. No feature worker starts the desktop app.

**Interfaces:** ScoreView consumes EngravingProjection and visible indices. Root adds `NativePlaybackController.setRenderedScore(score:model.Score,tracks:number[]):void` using the existing external-media suppression mechanism. Musical loadDocument retains the canonical score and does not overwrite the display with single-track source render. Projection lookup maps canonical/rendered IDs both directions.

- [ ] Write `styled_render_is_independent_of_musical_preparation`: use both ordinary history and history already containing pasteMusic. While playing, change style/profile/visible tracks/zoom, apply setPageLayout, undo/redo presentation; assert canonical score/backing identity and spy that native prepare/invalidate/seek/play/pause counts do not increase. Same-score page/engraving-only settings do not send setMix; a real mix edit still does. Preserve generation, advancing musical time, practice/count-in/progressive state and correct renderer refresh. Do not let a delayed loadDocument completion overwrite the newest projection/view set.
- [ ] Write `rendered_selection_resolves_canonical_multitrack_notes`: two visible tracks, partial-chord Ctrl-click, Shift/drag and endpoint handles after zoom/resize/re-render; emitted canonical address/noteIndex matches original IDs. Bounds lookups use rendered objects. Hidden-track selection is described in inspector but not retargeted; markers cover all visible selected notes and handles remain anchor-lane. Dispose old events/clear stale bounds on projection replacement.
- [ ] Wire rendering ownership, visible membership, controls, model-layout setting, numeric zoom and documentEpoch reset. Keep column structure/sizes and realistic selected instrument rendering. Do not use deprecated global staveProfile to override source/native flags.
- [ ] Add an authored dense acceptance score: guitar, piano grand staff, drums; two voices; bend/tied continuation/cross-string slur/grace; five-line raw lyrics; capo/tuning/chord diagram; repeats/tempo changes; three empty bars with a repeat/section barrier. Exercise on/off/reset and all finite choices. Multi-rest condenses only permissible silent runs and does not change independently decoded notes/timing.
- [ ] Run the focused component/native integration checks first. Root then launches the existing desktop harness for `node tests/desktop/engraving.mjs`: apply/undo/redo/save/restart/reopen; multi-track selection; zoom25/100.5/300; style during playback/count-in/progressive loop; page presets/custom/asymmetric margins; cancellation/frozen export. Root records actual native/renderer receipts.
- [ ] Export vector PDFs in document notation and explicit legacy profiles, selected/nonzero bar ranges, custom180x240mm/asymmetric margins, A4/Letter landscape, multistaff dense systems. Use the PDF skill/bundled rendering runtime to render **every** page to images; inspect names/brackets/dynamics/rhythm/fingerings/numbered key-relative figures, missing glyphs, lyric/chord/slur collisions, clipping, order/page count, physical page dimensions and margins. Check geometry with an independent PDF reader. A passing SVG text/path count or JSON test alone does not pass this step.
- [ ] Capture approved-layout screenshots at960/1280/1600 widths with existing realistic instruments visible; inspect new inspector sections and input focus without replacing the three-column layout. GP8-open unchanged-source-style musical exports separately; do not claim altered GP stylesheet fidelity.
- [ ] Only after focused and rendered/native checks pass, root runs appropriate combined frontend/native regressions and independent review, then integrates under existing approval. Record individual partial row evidence from the spec inventory; leave page/grid/fit modes, full fonts/templates/style libraries, unknown GP styles, physical printing/other platforms and fermata timing explicitly open.

## Self-review

- Coverage: projection/provenance/all finite public controls → Task1; page/backward geometry → Task2; visible tracks/zoom → Task3; history/native/source/export compatibility → Task4; actual selection/playback/rendered PDF acceptance → Task5.
- Each of the five Review Focus conditions has named RED assertions and a responsible integration gate.
- Canonical settings/DTO bodies live in the linked spec; worker interfaces and task tests agree with those contracts.
- Parallel workers have disjoint new files after root stages types. Root owns all source/transport/export/shared integration.
- No proprietary schema, physical print result, target engraving fidelity or fermata timing is inferred from green model tests. Drafting changed only these two new documents; no product code, tests/builds/apps, Git or external messages were executed.

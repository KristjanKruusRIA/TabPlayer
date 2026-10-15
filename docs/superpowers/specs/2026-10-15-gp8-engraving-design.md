# Guitar Pro 8 engraving and display foundation

Date: 2026-10-15. Status: bounded subsystem design under the user's standing approval to finish all258 parity requirements using parallel workers. Root executes later; this document does not authorize a false claim of complete GP8 engraving. Supports [the umbrella design](2026-10-15-gp8-feature-parity-design.md); execution follows [the engraving plan](../plans/2026-10-15-gp8-engraving.md).

## Intent and selected slice

Make score presentation editable without changing music or disrupting practice playback: persist known public stylesheet/notation overrides, display selected/all/chosen tracks and source/standard/tab/slash/numbered profiles, accept arbitrary zoom25–300%, and export the same document engraving with custom physical page dimensions and independent margins. Preserve the approved three-column slate/cream/lime editor and realistic instrument assets/views.

The selected architecture uses native history for document presentation, a detached public-model render projection, and session state for visible tracks/zoom. An alternative that mutates the musical score for every style change would entangle playback/history and imported source; a complete replacement engraving engine would exceed this bounded delivery. The projection approach retains the existing public renderer and source provenance. Full physical page/grid editing, headers/fonts/style libraries, and unknown GP style writing remain separate deliveries.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old command JSON and replay meaning remain compatible.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes or dependency patches.
- Keep the approved three-column slate/cream/lime editor and realistic instrument views/assets. Do not replace them with generic placeholders or a new layout.
- Root owns shared DTOs/validators, controller/engine, App/ScoreView/EditorPanel, playback/export integration, native registration, source lifetimes, Git, applications and final verification. Workers own only assigned new modules/panels/tests.
- Presentation edits are atomic native history entries. Session visibility/zoom do not dirty the document. No presentation change may change notes, timing, source bytes, audio settings, backing, raw lyrics or surviving relationships.
- Use public renderer/model APIs and demonstrated standard file fields. Do not guess score.gpss, invent GPIF extensions, or expose arbitrary alphaTab JSON as a command.
- Model retention, rendered image/PDF quality, native replay, musical output, GP8 target-runtime fidelity and physical printing are separate acceptance checks.
- This batch writes native document/PDF presentation only. GP export preserves original/default source style; faithful export of changed GP styles remains open.

## Current evidence and outstanding families

The pinned [baseline matrix](../../validation/2026-10-15-gp8-parity-baseline.md) is historical. Delivered [entry/interchange](../plans/2026-10-15-gp8-entry-interchange.md), [lyrics](2026-10-15-gp8-lyrics-design.md), [notation](2026-10-15-gp8-notation-design.md), [range editing](2026-10-15-gp8-range-editing-design.md), and [measure transforms](2026-10-15-gp8-measure-transforms-design.md) add music/selection capabilities, not full stylesheet parity. No matrix status is changed by this design.

| Inventory | Actual remaining work | This slice |
| --- | --- | --- |
| D01 | Current continuous vertical score; physical page vertical/horizontal/grid and screen-horizontal workflow absent. Public LayoutMode.Page means endless vertical systems, not physical pages. | Retain vertical editing; modes stay open. |
| D02 | Five70–130% presets; arbitrary/fit controls absent. | Arbitrary25–300%; fit width/page remains open. |
| D03 | ScoreView renders only selected track; export track selection already exists. | Selected/all/chosen simultaneous tracks with intact interaction. |
| D04/D05 | Global overview timeline and hide/resize main panels absent. | Preserve three columns; these families stay open. |
| D06/D08 | No graphical bar/beat dragging or individual system/staff-gap reset. | Global system-spacing factor only; per-system design tools stay open. |
| D07 | Track bars/system and forced breaks already exist; PDF uses model layout. | Preserve and honor them on screen/PDF; no duplicate layout command. |
| D09 | PDF has A4/Letter, orientation, one margin and scale. | Custom dimensions, five convenience presets, independent margins, existing scale. Twelve-preset GP8 catalogue parity remains open. |
| D10 | PDF title/page count fixed; no first/other-page metadata templates. | Fixed header/footer retained; templates are next separate work. |
| D11 | No public stylesheet UI for brackets, bar lines, names or global spacing. | Known grouping/name/orientation/bar-number controls; first-system-of-each-page names and custom grouping remain open. |
| D12/D13 | Fixed Bravura/Noto; no notation/text font presets, saved styles or default-style preferences. | Keep bundled fonts; these families remain open. |
| D14 | Automatic tuning/chord presentation only. | Global tuning visibility and chord placement; tuning formatting/frame/columns, chord size/spacing remain open. |
| D15/D16 | No tab rhythm/fingering display controls. | Four public tab-rhythm modes and four fingering modes; per-voice above/below placement, languages and custom sizes remain open. |
| D17 | No notation-style controls for tied bends and effect span choices. | Only the finite public switches below; HoPo/trill/slide/collision/tuplet formatting remains open. |
| D18/D19 | Existing selected PDF/viewer print handoff; physical printer and other-platform behavior unverified. | Same output geometry/style for PDF/print; no native printer dialog or physical acceptance claim. |
| D20 | No naming placeholders/background/PNG/SVG batch exporter. | Unchanged; remains open. |
| N02/N03/N29 | Beat slash authoring exists; source staff slash/numbered not selectable in current view. Multirest/unnecessary-rest UI absent. | Display profiles and public multirests; unnecessary-rest formatting, numbered input, and exact GP8 renderer equivalence remain open. |
| L07 | No saved startup display/style/zoom preferences. | View state remains session-only; preferences/default-style behavior remains open. |

Primary references: [track visibility](https://www.guitar-pro.com/docs/gp8/display-options/track-visibility), [page/screen modes](https://www.guitar-pro.com/docs/gp8/display-options/page-screen), [systems/staves](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/systems-staves), [notation style](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/notation), [headers/footers](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/header-footer). Cached manual bodies were reused; missing systems/header bodies were checked against official pages. No third-party descriptions define behavior.

## Source inspection and narrow public probes

Graph tools were unavailable; discovery used narrow reads. `src/ScoreView.tsx` currently delegates renderScore to NativePlaybackController.replaceScore, filters selection to the selected track, and compares rendered model identity with the canonical document. `src/export/pdf.ts` forces Score/Tab flags, suppresses its cloned title, packs systems with a fixed40px header/24px footer, and calls model layout. `src/document-settings.ts` currently has sounds/mixes/backing/legacy print only. Controller settings edits already avoid beforeScoreChange. The current export coordinator freezes score/settings and copies links/source before export.

An authored two-bar public-model probe established JSON retention of the stylesheet fields below and all four staff flags. Direct public GP export/import retained hideDynamics, bracket mode, system separators, tuning/chord booleans, name policy/mode/orientation, multirests, extended barlines and bar-number display. It lost **hideEmptyStaves**, **hideEmptyStavesInFirstSystem**, and **showSingleStaffBrackets**. Staff flags `[standard=true,tab=false,slash=true,numbered=true]` survived direct GP at track level. This is model/interchange evidence, not visual proof.

Public GP7 output contains `Content/BinaryStylesheet`, `Content/PartConfiguration`, `Content/LayoutConfiguration`, and `Content/score.gpif`. It does not demonstrate an arbitrary score.gpss schema. The installed PartConfiguration writer derives a track's display from its first staff, so per-staff GP display fidelity is not established. The current owned GP adapter merges generated entries then original siblings, allowing originals to replace generated style entries. Never infer changed-native-style GP export from a direct public-writer probe.

## Exact document contracts

Root stages `src/engraving/types.ts` before parallel workers. Types are finite; every object has exact fields and all nullable fields are required in command JSON.

```ts
type InheritBool = boolean|null;
type NamePolicy = 'inherit'|'hidden'|'firstSystem'|'allSystems';
type TrackProfile = 'source'|'standard'|'tablature'|'standardTab'|'slash'|'numbered';
interface EngravingOverrides {
  stylesheet:{
    hideDynamics:InheritBool;
    brackets:'inherit'|'none'|'staves'|'similar';
    extendBarLines:InheritBool; systemSeparators:InheritBool;
    tuning:InheritBool;
    chords:'inherit'|'hidden'|'top'|'inline'|'both';
    singleNames:NamePolicy; multiNames:NamePolicy;
    firstNames:'inherit'|'full'|'short'; otherNames:'inherit'|'full'|'short';
    firstNameDirection:'inherit'|'horizontal'|'vertical';
    otherNameDirection:'inherit'|'horizontal'|'vertical';
    barNumbers:'inherit'|'all'|'firstSystem'|'hidden';
    multiRests:'inherit'|'off'|'on';
    hideEmptyStaves:InheritBool; hideEmptyFirstSystem:InheritBool;
    singleStaffBrackets:InheritBool;
  };
  notation:{
    tabRhythm:'inherit'|'auto'|'hidden'|'beams'|'connected';
    fingering:'inherit'|'score'|'piano'|'above'|'abovePiano';
    smallGraceTab:InheritBool; extendBendArrows:InheritBool;
    extendLineEffects:InheritBool; parenthesizeTiedBends:InheritBool;
    showTiedBendNumbers:InheritBool; showDiveWhammyZeros:InheritBool;
  };
  systemSpacing:number|null;
  profiles:Array<{trackId:string;profile:TrackProfile}>;
}
interface PageLayout {
  widthMm:number; heightMm:number;
  marginsMm:{top:number;right:number;bottom:number;left:number};
  scale:number; profile:'document'|'ScoreTab'|'Score'|'Tab';
}
type EngravingCommand =
  | {type:'setEngraving';engraving:EngravingOverrides}
  | {type:'setPageLayout';layout:PageLayout};
```

Add derived `DocumentSettings.engraving:EngravingOverrides` and `DocumentSettings.page:PageLayout|null`. The native project still stores source/history, not a second mutable score/settings snapshot. Default engraving has every boolean null, every enum inherit, systemSpacing null, profiles empty. Default page is null. Fresh objects must not share arrays/maps.

Both commands are SettingsEdit variants and one history step; no musical rebuild, playback invalidation or audio-plan preparation. Validate exact nested shapes/enum domains, finite values, duplicate profile IDs, and current track identities before assigning. Native Rust uses strict serde structs/enums, required nullable fields in commands, and matching bounds. Derived DocumentSettings decoding may default missing new top-level fields for older IPC/test callers; new command fields cannot be omitted. There is no project schema-version bump or rewrite of existing histories.

A preceding pasteMusic history does not relax the presentation-only identity contract. The current clipboard replay fallback derives settings/backing maps through buildDocument but retains current.score and current.embeddedBacking references. Preserve that fix when adding the new settings cases; protect it with paste-before-presentation apply/undo/redo and active-playback regression tests. Do not redo the clipboard implementation or reintroduce its earlier canonical-score replacement.

Profiles use existing stable trackIdentity values, never renderer clone fallback identities. At command application, profile IDs must exist and be unique. Historical entries whose track was later removed stay dormant; final projection ignores missing IDs, allowing undo to restore the same source track. A new Apply emits current live entries. Track-level profile overrides apply to all its staves; source retains individual original staff combinations. Reject tablature-only if any target staff is untuned/percussion; standardTab shows standard everywhere and tab only on stringed nonpercussion staves. Numbered rejects a track containing percussion; slash supports pitched/stringed/percussion. No profile changes canonical staff settings or pitch.

Every explicit profile replaces **all four** cloned Staff flags together. The tuple order is `(showStandardNotation,showTablature,showSlash,showNumbered)`:

| TrackProfile | Exact per-staff tuple |
| --- | --- |
| source | Preserve that source staff's original four values unchanged, including mixed combinations. |
| standard | `(true,false,false,false)` |
| tablature | `(false,true,false,false)`; reject an untuned/percussion target before projection. |
| standardTab | `(true,isStringedAndNonPercussion,false,false)` |
| slash | `(false,false,true,false)` |
| numbered | `(false,false,false,true)`; reject percussion before projection. |

Here isStringedAndNonPercussion means `staff.tuning.length>0 && !staff.isPercussion`. Do not OR explicit profiles with source flags or leave stale slash/numbered flags enabled. Temporary PDF Score/Tab/ScoreTab profiles use the corresponding standard/tablature/standardTab tuple and the same applicability checks; the document profile retains projected source/native flags.

## Backward compatibility and page precedence

Existing PrintLayout and `setPrintLayout {layout}` JSON remain unchanged. `setPageLayout` sets page only. An explicit later legacy setPrintLayout updates print and clears page, making chronological precedence deterministic. With page null, `effectivePageLayout` converts legacy print to the same physical size, equal margins, scale and profile. Thus old project behavior remains unchanged. The new export/page panel can select `document` to use actual source/native profile flags; its initial choice reflects the last saved legacy profile instead of silently changing it.

Width/height are final physical orientation:20..1000mm, finite. Margin sides are finite/nonnegative; after conversion at96/25.4px/mm, content width and content height minus the fixed64px header/footer reservation must each be at least100px. Scale0.25..3. Preset buttons set dimensions only: A3(297,420), A4(210,297), A5(148,210), Letter(215.9,279.4), Legal(215.9,355.6); Landscape swaps width/height. Native data has one dimension truth, not duplicated paper/orientation fields. Reject invalid geometry at Apply and before export, never clip.

## Projection, provenance, and public mappings

Worker-owned `src/engraving/projection.ts` exports:

```ts
interface EngravingProjection {
  score:model.Score;
  beats:Map<number,{source:model.Beat;rendered:model.Beat}>;
  notes:Map<number,{source:model.Note;rendered:model.Note}>;
}
defaultEngraving():EngravingOverrides
validateEngraving(value:unknown):asserts value is EngravingOverrides
validateEngravingTracks(score:model.Score,ids:readonly string[],value:EngravingOverrides):void
projectEngraving(source:model.Score,ids:readonly string[],value:EngravingOverrides):EngravingProjection
configureEngraving(settings:Settings,value:EngravingOverrides):void
remapStylesheetTracks(stylesheet:model.Score['stylesheet'],oldToNew:Array<number|null>):void
```

This is one small clone helper and two ID maps, not a projection framework, cache, new renderer, or alternate selection model. Clone with scoreFromJson, capture/restore links, and copyGpInterchangeSource (which already carries raw lyrics/backing). Preserve public note/beat IDs. Apply overrides only to the detached model/settings. Never call trackIdentity on cloned tracks; carry source IDs explicitly. Null/inherit means the source/default model value; for notation configuration, inherit means alphaTab's renderer default. Reset only owned setting fields/map keys when clearing; preserve unrelated settings/core/player/resources. Expose “Source/default” and “Reset to source/default” in the panel so an edit does not silently overwrite imported values.

| Contract | Public mapping |
| --- | --- |
| brackets | NoBrackets0,GroupStaves1,GroupSimilarInstruments2; similar means same MIDI program, not arbitrary custom grouping. |
| names | single/multi TrackNamePolicy Hidden0,FirstSystem1,AllSystems2; mode FullName0/ShortName1; orientation Horizontal0/Vertical1. First-system-per-page has no equivalent here. |
| hideDynamics/extendBarLines/systemSeparators | RenderStylesheet.hideDynamics/extendBarLines/useSystemSignSeparator. |
| tuning | globalDisplayTuning; explicit override clears the cloned perTrackDisplayTuning map so source exceptions cannot defeat a global choice. |
| chords | globalDisplayChordDiagramsOnTop and globalDisplayChordDiagramsInScore; explicit override clears cloned perTrackChordDiagramsOnTop. Preserve each Chord.showDiagram/name flags. |
| barNumbers | AllBars0/FirstOfSystem1/Hide2; explicit override clears cloned Bar.barNumberDisplay overrides only. |
| multiRests | explicit on/off sets multiTrackMultiBarRest and all/none of the current track indices in perTrackMultiBarRest. Inherit preserves source maps/sets. |
| empty staff flags | hideEmptyStaves/hideEmptyStavesInFirstSystem/showSingleStaffBrackets. Dormant first-system choice is retained when hiding is off. |
| profiles | sets only cloned Staff.showStandardNotation/showTablature/showSlash/showNumbered; keep Default stave profile so deprecated global ScoreTab cannot override these flags. |
| tabRhythm/fingering | TabRhythmMode Hidden0,ShowWithBeams1,ShowWithBars2,Automatic3; FingeringMode ScoreDefault0,ScoreForcePiano1,SingleNoteEffectBand2,SingleNoteEffectBandForcePiano3. |
| notation switches | smallGraceTabNotes,extendBendArrowsOnTiedNotes,extendLineEffectsToBeatEnd; NotationElement ParenthesisOnTiedBends11,TabNotesOnTiedBends12,ZerosOnDiveWhammys13. Do not change notationMode, which can alter musical interpretation. |
| systemSpacing | finite factor0.25..4; multiplies default display systemPaddingTop,systemPaddingBottom,lastSystemPaddingBottom. First-system top remains unchanged. UI is a percentage of default spacing, not an unproven mm equivalence. |

Use SystemsLayoutMode.UseModelLayout on both screen and PDF, preserving existing forced breaks/bars-per-system. Do not introduce separate per-system settings. Root uses remapStylesheetTracks for index-keyed source per-track tuning/chord/multirest maps on track deletion/reordering and detached selections; native override profiles themselves use stable IDs. Tests must prevent an inherited source exception migrating to a neighboring track.

## Visible tracks, interaction, zoom, and playback boundary

Session-only types live with the display owner:

```ts
type TrackView = {kind:'selected'}|{kind:'all'}|{kind:'custom';trackIds:string[]};
resolveVisibleTracks(ids:readonly string[],selected:number,view:TrackView):number[]
```

Return live tracks in source order. Selected follows the active track; all includes newly added tracks; custom keeps its chosen stable IDs across index shifts. Ignore removed IDs and fall back to the active track if none remain. UI prevents hiding the final visible track. Selecting a hidden track for inspection does not silently alter a custom set; show its hidden state. Document replacement resets selected/100%; view changes never create history. Numeric zoom accepts finite25..300, including fractional values; fit-width/page remains open.

ScoreView receives the projection/visible indices. Renderer callbacks resolve clone Beat/Note IDs to canonical objects, then emit canonical addresses. Range/note bounds must resolve canonical IDs back to rendered objects. Replace selected-track filters with visible-track membership; draw note markers for all visible selected notes. Existing single-lane range handles stay on the anchor lane, while cross-track scope remains in the inspector. Refresh all overlays after render/zoom/resize, using fresh bounds; no hidden track becomes an accidental edit target. Preserve input modifiers and disposal from the delivered range workflow.

Root separates display rendering from native musical preparation. ScoreView owns calling a new `NativePlaybackController.setRenderedScore(score:model.Score,tracks:number[]):void` under the existing external-media suppression/updateSyncPoints mechanism. loadDocument prepares canonical music and no longer replaces a styled multitrack render with the original single-track score. Styling/zoom/visible tracks call render/updateSettings only and do not invalidate, seek, restart or reprepare the native plan. Same-score changes containing only engraving/page do not send a mixer update; compare sounds/mixes/backing for audio changes. Native cursor timing continues from canonical music; projection IDs/timing remain identical. Active instrument rendering continues to use the canonical selected track and existing realistic assets.

## PDF/export contract

Page worker owns `src/engraving/page.ts`, `PageLayoutPanel.tsx`, and tests:

```ts
interface PageGeometry {
  widthMm:number;heightMm:number;width:number;height:number;
  left:number;top:number;right:number;bottom:number;
  usableWidth:number;usableHeight:number;
}
effectivePageLayout(settings:Pick<DocumentSettings,'page'|'print'>):PageLayout
validatePageLayout(value:unknown):asserts value is PageLayout
pageGeometry(layout:PageLayout):PageGeometry
paginateEngravedSystems(systems:SvgSystem[],title:string,layout:PageLayout):SvgPage[]
```

Keep old renderPdfPages calls working; root adds optional rendering argument `{page:PageLayout;engraving:EngravingOverrides;trackIds:string[]}` to the existing `(score,selection,legacyLayout)` function instead of adding a second renderer. Absent options retain old output. With options, validate/freeze all values, use selectStaves retaining source indices, apply the same projection/configuration, and honor explicit export selection independently of screen visibility. `document` uses source/native profiles; legacy Score/Tab/ScoreTab remain explicit temporary profile overrides, with no tabs on nonstringed staves. Hide native renderer header metadata consistently to retain the existing single fixed PDF title and footer; no duplicate title/artist from the clone.

Set renderer width to usableWidth; render complete SVG systems with model breaks, then paginate at left/top+40px and footer at height-bottom. Height capacity subtracts64px; scale affects notation, not physical margins/page dimensions/header/footer. Keep clipping/too-tall rejection and XML escaping. The existing Rust vector conversion/fonts stay unchanged; physical page dimensions already accept20..1000mm. No screen DOM screenshot becomes PDF content. Freeze engraving/page/settings at export launch; a later edit cannot alter an in-progress document.

GP and MIDI/audio export consume canonical musical score and existing source/selection adapters, never the visual projection. The export dialog clearly states that screen/PDF engraving overrides do not update the original GP stylesheet in this slice. Preserve original BinaryStylesheet/PartConfiguration/LayoutConfiguration, unknown score.gpss and every source sibling byte. Native save/reopen retains overrides through commands. This explicit boundary avoids silently replacing unknown source style data with a partial public serialization.

## Panels and task ownership

EngravingPanel receives `{score,trackIds,value,busy,onEdit:(command:Extract<EngravingCommand,{type:'setEngraving'}>)=>void}`. It uses compact details/fieldset sections for source/default choices, profiles, named stylesheet/notation controls and system-spacing percent; one Apply and Reset create one command each. PageLayoutPanel receives `{value:PageLayout,busy,onEdit:(command:Extract<EngravingCommand,{type:'setPageLayout'}>)=>void}` and provides presets, final width/height, swap orientation, independent margins, scale/profile, one Apply. Root integrates existing toolbar track-view/eyes/zoom without changing three-column structure. Both reset drafts when their applied value/document changes and surface existing controller errors.

Parallel ownership: root stages types/shared DTOs. Engraving worker owns the default factory/projection/validation/EngravingPanel/tests. Page worker owns page geometry/pagination/PageLayoutPanel/tests. Display helper worker can own `src/engraving/view.ts`, `view.test.ts`, and a focused TrackDisplayControls component/test; root alone changes ScoreView/playback/App/export/controller. No worker touches shared product files or another worker's files.

## Acceptance and later research gates

Use authored dense fixtures with guitar/piano grand staff/drums, two voices, bend/tie/slur/grace, raw five-line lyrics, capo/tuning/chords, repeat/tempo changes, empty systems and multirests. Verify exact native history, immutable canonical model/source/backing/links/dynamics, independently decoded unchanged MIDI, visible glyph/bounds changes, selectable multi-track notes, and final vector PDF geometry. Root renders every exported page to images and inspects clipping, overlap, missing glyphs, page count, margins, names and lyric/chord/tie spans. Green JSON assertions cannot establish faithful engraving.

Native acceptance includes apply/undo/redo/save/restart/reopen; old project/schema/history regression; changing engraving while playing/progressive practice/count-in without reprepare; range dragging after zoom/multitrack rendering; export cancellation/frozen snapshot. Preserve realistic instrument screenshots and approved columns at960/1280/1600 widths. Windows results do not prove physical Mac/Linux input/audio/printing behavior.

Later GP style research must author one changed setting at a time in GP8, archive-before/after bytes, map entry paths and typed deltas, independently reimport and render both consumers, and prove untouched unknown data survives. First prove whether the actual file uses BinaryStylesheet, score.gpss or another source entry; do not assume equivalence. Header/page tokens, first/other-page rules, arbitrary fonts, twelve paper presets, per-voice rhythms, fine collision rules and page-mode interactions need their own bounded designs/corpus. Fermata Length units/timing remain unrelated and open.

## Self-review

- The slice addresses native/PDF presentation and interaction coherently; every remaining display family is retained in the inventory table.
- Finite settings/commands preserve source/default provenance and old histories; session state is separate.
- Projection maps preserve canonical note selection and native audio independence; source-style entries are never guessed or overwritten.
- The plan owns exact RED tests, root integration and rendered/native acceptance. Unknown GP style/physical printing/fermata timing cannot be closed by model tests.

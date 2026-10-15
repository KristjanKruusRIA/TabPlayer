# Engraving and display foundation validation

Date: 2026-10-15. Branch `feat/gp8-parity`; released `main` remains `7fc41c7`. This is a bounded delivery under the full Guitar Pro parity goal. The historical 258-requirement baseline remains unchanged.

## Delivered behavior

Document history now stores finite stylesheet and notation overrides, global system spacing and per-track source/standard/tab/combined/slash/numbered profiles. Rendering uses a detached public-model projection with exact source-to-rendered beat/note identity. Selection, indexed note hits, dragging and resize handles resolve back to canonical music. Source staff flags, relationships, raw lyrics, rich harmony, backing and archive provenance survive the projection.

Selected/all/chosen visible tracks and fractional 25–300% zoom are session state. They do not dirty the document and reset on New/Open. Hidden selected tracks receive a visible notice. Presentation changes retain prepared native audio, playback position and practice settings. Serialized mix acknowledgements prevent an older in-flight mix request from overwriting the latest desired mix.

Custom physical page dimensions, five convenience presets, independent margins, scale and notation profile apply to PDF and print handoff. Export freezes its own chosen tracks and presentation. An explicit custom page wins; otherwise explicit legacy export geometry remains authoritative. Applying old print-layout commands clears a later custom page chronologically. Old native-valid layouts outside the new page domain remain editable and receive a recoverable correction notice. Incompatible live staff/profile changes reject before publication; removed track identities remain dormant.

## Verification

The joined engraving/harmony product passes **1,366 Vitest tests across 106 files plus 10 Node checks**, with one explicit benchmark skip; TypeScript and Rust formatting pass. The complete Rust suite passes **216 tests**, with six explicit hardware/bank ignores. Independent projection, page, view, native schema, playback-controller and root-integration reviews accepted the final corrections. Root review regressions cover explicit legacy geometry, profile applicability, legacy-layout recovery and inactive-layout validation.

The rebuilt diagnostic Windows app passes `tests/desktop/parity-engraving.mjs` against an original deterministic three-track/four-staff fixture: guitar with capo/drop tuning, two-staff piano and drums; 12 written/14 performed bars; two voices, grace, bend/tie/slur, lyrics, chord diagrams and silent passages. During playback, engraving/page changes preserve native generation **5**, running state and advancing ticks. Session visibility/zoom leave history unchanged; native save, full process restart and reopen preserve document edits and reset session display defaults. Before/after GP exports retain all **420 note-on/off events** and untouched archive siblings. Original fixture SHA-256 remains `a19cd67ee67038eb62655119f56459351576626c6d5a71dcfcd89e39e0a8cfba`.

Actual native PDF export produces a **250×350 mm two-page portrait document** and a **350×250 mm three-page landscape score**. All five final pages were rendered with Poppler and visually inspected: complete systems, legible notation/text, deliberate independent margins, first-page title and separate page-count footer. PDF text bounds remain within each physical page. Output sizes are 59,750 and 71,134 bytes. Existing attribution remains present. The approved columns and original physical guitar artwork remain visible at 960/1280/1600 px.

The prior Windows mouse/range/measure workflow also passes selection, reverse drag, resize, triple click, indexed chord members, pitch-preserving re-fingering, global bar alignment, cursor mapping, native playback, source preservation and process restart. Its harness waits for native preparation and React publication and uses a viewport containing both drag endpoints; cached off-screen coordinates from the earlier harness were not reliable after initial layout scrolling.

Ignored evidence: `.analysis/parity/*engraving*review*`, `native-engraving-result.json`, final PDF/page PNGs, width screenshots and `native-range-measures-result.json`. Diagnostic binaries, private scores and generated evidence are excluded from source delivery.

## Remaining scope

This is not complete Guitar Pro engraving equivalence. Physical screen-page/grid/horizontal modes, fit controls, graphical spacing, metadata templates, fonts/style libraries, full paper catalogue, fine collision/layout tools and changed GP stylesheet export remain open. Dense forced multi-bar systems can crowd at narrow screen widths/high zoom; the PDF fixtures above do not establish arbitrary-score collision freedom. Native printer dialogs, physical printing, original GP8 runtime acceptance and physical macOS/Linux validation remain unverified. No shipping installer or new `main` release is produced by this batch.

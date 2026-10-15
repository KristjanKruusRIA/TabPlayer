# Guitar Pro 8 Bounded Musical Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-contained cross-document app Copy/Cut/Paste with repeat count and paste-special filters, using one history command per mutation.

**Architecture:** Root stages finite DTOs and owns controller/replay/UI integration. A source worker implements the sanitized snapshot/store contract; a paste worker consumes that stable contract to return a detached candidate and BarIndexMap. A fresh reviewer checks each task and the integrated native workflow.

**Tech Stack:** Existing alphaTab 1.8.4, React/TypeScript, Rust/Tauri, Vitest and native desktop-test harness; no new dependencies or OS clipboard integration.

**Spec:** [2026-10-15-gp8-clipboard-design.md](../specs/2026-10-15-gp8-clipboard-design.md)

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency or OS clipboard permission changes.
- Root owns shared DTOs/validators, controller/engine/settings replay, App/EditorPanel/ScoreView, source lifetimes, Git, apps/builds and native verification. Workers edit only assigned new modules and tests.
- Copy and selection are not native history. Cut and Paste each change music in one native history entry; repeated Paste has one undo step.
- Validate complete clips, all mappings, all repetitions and all contextual destinations before committing. Failed Cut leaves the previous clipboard and document unchanged.
- Clipboard snapshots contain selected music and required instrument context only: no recursive native Project, unrelated music, source paths/archive siblings, raw lyric sources, backing bytes/assets or document sound graphs.
- Destination source bytes, archive siblings, backing audio, raw lyric text, unrelated notes and document settings remain immutable except the approved bar-index mapping. Preserve note dynamics and valid links through rebuild.
- Keep the approved slate/cream/lime layout and existing note-name/one-based UI conventions. Public roundtrip, native replay, actual MIDI/audio and GP8 runtime compatibility need separate evidence.

## Review Focus

1. A clipboard accidentally containing the full source document leaks unrelated music/metadata/audio; Task 2 asserts absent sentinel data, selected scope and source immutability.
2. A failed last mapping/repetition or queued Cut must not partially commit or replace the previous clipboard; Tasks 3/4 test pure candidate failure and serialized native commit order.
3. Fractional DSP events and copied program/tempo/sustain must not move to carrier-beat time or leak into the destination suffix; Tasks 3/5 independently decode exact output.
4. Raw lyrics, backing anchors and source archive siblings can disappear during detached cloning/replay; Tasks 3/4 preserve destination provenance and test settings replay with empty-store restart.
5. IDs/effects/custom drum articulations must not alias across repetitions or map by coincident numeric IDs; Tasks 2/3 test complete articulation identity, link conversion and independent mutable objects.

---

### Task 1: Root stages clipboard DTOs and protocol

**Files:** Create `src/editor/clipboard-types.ts`; modify `src/edit-types.ts`, `src/parity-commands.ts`, `src/parity-commands.test.ts`, `src-tauri/src/edit_types.rs`, `src-tauri/tests/protocol.rs`, `tests/protocol.json`.

**Interfaces:** Produce all types in the spec verbatim: ClipboardMode/Link, MusicClip, PasteFilters/Destination/Options, ClipboardCommand, PreparedMusicPaste and ClipboardPanelProps. Existing selection/index-map types are imported. Native EditCommand adds only pasteMusic; Cut reuses existing finite edits.

- [ ] Write failing exact-shape/native protocol tests for one phrase clip and a multitrack bar clip. Assert supported version/engine, required nullable slideOutType, count 1/1000 and all six booleans. Reject unknown nested fields, missing filter, null boolean, count 0/1001, fractional/negative indices, duplicate source/destination/staff mapping, invalid kind/mode/version/engine, malformed JSON and unsupported slide link type.
- [ ] Run `npx vitest run src/parity-commands.test.ts` and `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test protocol`; capture missing-command RED.
- [ ] Implement strict outer DTO validation; Rust validates scoreJson UTF-8 byte budget 128,000,000 and JSON syntax, TS enforces semantic candidate validation before native history. Keep existing command behavior unchanged.
- [ ] Rerun both checks. Root commits reviewed contracts and shares the exact APIs before workers begin.

### Task 2: Sanitized musical snapshots, reader and app store

**Files:** Create `src/editor/clipboard-source.ts`, `src/editor/clipboard-source.test.ts`, `src/editor/ClipboardStore.ts`, `src/editor/ClipboardStore.test.ts`.

**Interfaces:** Consume Task 1 types and existing range/link/model-clone helpers. Produce makeMusicClip(score,selection,mode):MusicClip, readMusicClip(value):MusicClip and ClipboardStore.get()/set() as specified. No existing source/provenance module edits.

- [ ] Write `snapshot_contains_only_selected_music`: source has root title/artist/path-like sentinels, unselected track/bar notes/text/chord names, backing bytes/sync points, raw lyric text and archive sibling. Copy one selected phrase; decoded JSON contains only its requested note members/rest gaps/instrument context and no sentinels/unrelated music/backing/Beat.lyrics. Referenced chord dictionary remains; unused chords do not. Source arrays, bytes, raw sources and note links are unchanged.
- [ ] Write `bar_scope_and_expansion_are_exact`: singleTrack complete bars retains all selected track staves/voices and excludes global structure in application metadata; multitrack note/range scope expands inclusive bars/all voices of selected tracks. Mixed partial lanes reject. Phrase duration is selected complete rhythms/rest gaps, not nominal first-bar capacity. Empty/rest bars copy as bar clips.
- [ ] Write `links_and_pinned_json_are_validated`: internal tie/slur/slide/hammer capture both IDs; outward links detach, tie destination sounds independently; external continued bend/contextual simile reject. Multitrack partial repeat/direction clips reject, while a SingleTrack riff inside a repeat copies with no global structure. Legal Note.id == Beat.id is accepted; duplicate IDs within the same kind, missing link endpoint, nonfinite JSON number, invalid rhythm/pitch/articulation and backing/sync payload reject. Converter-restored note dynamics 3 remains 3.
- [ ] Write `store_clones_and_retains_across_document_change`: get/set do not alias a caller's links/options/string envelope; changing retrieved content cannot change stored content. A document replacement simulation does not reset the app-owned store. Invalid clip set throws without replacing an existing valid clip.
- [ ] Run `npx vitest run src/editor/clipboard-source.test.ts src/editor/ClipboardStore.test.ts`; capture missing-module/behavior RED.
- [ ] Implement sanitized new-Score snapshots, exact reader checks plus public pinned conversion, and the small deep-copy store. No full custom alphaTab schema or source Project embedding. Do not call copyGpInterchangeSource on a clip snapshot.
- [ ] Rerun focused tests and request fresh privacy/link/scope review. Root commits accepted task files. Task 3 may develop against authored clip fixtures while these APIs stabilize; it must not duplicate the reader.

### Task 3: Pure detached paste preparation and instrument conversion

**Files:** Create `src/editor/clipboard-paste.ts`, `src/editor/clipboard-paste.test.ts`; optionally split only the independently complex conversion into `src/editor/clipboard-conversion.ts` and `.test.ts` with the same worker ownership.

**Interfaces:** Consume Task 2 reader; existing planFingering, planMeasureMap/applyMeasureEdit, mapLyricsMeasures, trackMixAutomations, public percussion registry and copyGpInterchangeSource. Produce preparePasteMusic(score,command):PreparedMusicPaste. It never edits the input score; root applies returned barMap to document/embedded backing settings.

- [ ] Write `insert_bar_clips_with_structure_and_scope`: two-bar multitrack clip count 3 inserts six global bars before target, maps old bar1->7, retains source meter/key/internal repeat structure and all copied voices; unmapped destination tracks receive inherited empty bars. SingleTrack bars retain destination meter/key/clef and reject overflow. Missing final staff/voice, nested repeat context, wrong placement, expansion >1000 bars and unsupported direction/simile context reject with the original score fingerprint unchanged.
- [ ] Write `phrase_fills_rest_tail_and_spills_before_music`: destination beat1 onward is a rest suffix, copied complete beats fill it, leave exact supported remainder rests, reuse subsequent empty voice bars, then insert one contiguous block before the next sounding bar. Earlier notes/other voices remain identical. Sounding target, too-long beat, free-time phrase, unrepresentable remainder and metadata without an exact retained onset reject atomically.
- [ ] Write `melodic_pitch_conversion_and_custom_drums`: guitar model string1/fret5 -> piano literal45 under destination offset; piano60/64 -> playable collision-free guitar chord, using preferred source strings larger than destination count safely. Sounding source/destination offsets and capo do not change output. Melodic<->drum transfers rhythm as rests. Source custom index0/output82 must not become destination index0/output38; an equivalent complete destination articulation is reused or a deep custom entry appended, preserving old destination entries/notation symbols.
- [ ] Write `fresh_repetition_links_and_technique_limits`: every repetition has disjoint Voice/Beat/Note IDs and mutable effects/chords/articulations, including persisted destination IDs ahead of the process constructor counter; internal links connect only its own copy. Mutating copy1 does not change clip/copy2/source. Preserve dynamics3 and compatible effects. Unsupported cross-instrument bend/harmonic/string gesture or broken link constraints reject; do not drop them silently.
- [ ] Write `each_filter_preserves_destination_and_restores_suffix`: toggle diagrams/texts/timers/track automation/master tempo/sections separately, proving false does not delete destination data. SingleTrack master/section true rejects. Source DSP .25 carried on beat3 remaps by musical ratio; keep flags/text/visibility and fades. After copied tempo/program/bank/CC7/CC10/sustain, original destination suffix state returns unless explicit ratio0 overrides it. Missing exact processed program/bank carrier rejects. No source backing sync Bank payload is copied.
- [ ] Write `candidate_keeps_destination_provenance`: source clip has none; destination has raw hidden/visible lyrics with CRLF/comments/empty slots, imported sibling and WAV bytes. Candidate clone keeps exact destination provenance, maps lyric starts once with returned barMap, retains unmanaged outside beat assignments and does not alias source bytes. Input project/score/clip remains identical after a failure in the final repeated destination.
- [ ] Run `npx vitest run src/editor/clipboard-paste.test.ts` (and conversion test if split); capture RED.
- [ ] Implement complete preflight and detached destination preparation. Clone with scoreFromJson, restore destination links and immediately carry destination provenance before bar changes. Plan one insertion, use existing measure/lyric adapters, allocate fresh music objects/IDs, apply filters/conversion/boundary restoration and return candidate plus map. No document settings/native history mutations or source archive imports.
- [ ] Rerun focused tests and request fresh review of actual pitch/controller timing, aliases and invalid-last atomicity. Root commits accepted task files.

### Task 4: Root joins serialized Copy/Cut, history replay and UI

**Files:** Modify `src/controller.ts`, `src/controller.test.ts`, `src/engine.ts`, `src/App.tsx`, `src/EditorPanel.tsx`, `src/styles.css`; create `src/editor/ClipboardPanel.tsx`, `src/editor/ClipboardPanel.test.tsx`, `src/editor/clipboard-replay.test.ts`, `src/clipboard-interaction.test.tsx`. A dedicated UI worker may own only the new panel/test; root retains shared files.

**Interfaces:** Consume Task 1 ClipboardPanelProps and Task 2/3 APIs. Root adds serialized controller copyMusic(selection,mode):Promise<MusicClip> and cutMusic(selection,mode):Promise<MusicClip>; private editNow contains the existing edit body so Cut does not call queued edit from inside run. Paste uses existing controller.edit({type:'pasteMusic',clip,options}).

- [ ] Write `cut_is_serialized_one_commit_and_store_changes_after_success`: queued changes are resolved against committed score; singleTrack Cut records one eraseSelection, multitrack Cut records one removeMeasures expanded globally. Failed candidate/native commit leaves prior store, score and history unchanged. Successful Cut returns clip only after commit; Copy returns a snapshot with no history/dirty/seek change. Existing asset-candidate cancellation behavior remains intact after editNow extraction.
- [ ] Write `empty_store_restart_and_settings_replay`: Copy -> New/Open -> Pastecount3 -> save/native-style JSON restart with empty store -> later setTrackMix/setPrintLayout -> undo/redo reproduces identical music/raw lyrics/backing map. Paste is one entry and undo restores all three repeats together. buildDocument consumes embedded clip without source file; settings-only replay falls back to buildDocument when pasteMusic exists and retains sourceBarCount/track identities.
- [ ] Write `backing_validation_rejects_before_native_history`: returned insertion map moves document and embedded anchors once, keeps ratio/occurrence/audioMs, raw bytes/mix/offset; invalid surviving occurrence rejects before bridge.applyEdit. All original and sibling/backing hashes remain unchanged.
- [ ] Write panel/interaction tests: default phrase/currentBar vs bars/beforeBar; unique track/staff mappings; all six filter booleans/count; SingleTrack master controls disabled false; Copy/Cut mode scope/global implication visible. Ctrl/Cmd+C/X/V and Shift variants submit appropriate callbacks; inputs/selects/textareas/contenteditable retain text shortcuts; busy disables actions; successful Paste clears stale indexed selection; no JSON payload leaks into UI/logs.
- [ ] Run `npx vitest run src/controller.test.ts src/editor/clipboard-replay.test.ts src/editor/ClipboardPanel.test.tsx src/clipboard-interaction.test.tsx`; capture RED.
- [ ] Integrate one app-lifetime store, controller queue methods, paste candidate branch in engine, root backing map/final rebuild/timer/lyrics/anchor validation and settings replay fallback. Do not add a recursive transaction command, redundant map DTO, OS clipboard plugin or source assets.
- [ ] Rerun focused checks plus `npm run typecheck`, and apply the condensed React review to edited components. Obtain fresh integration review; root commits accepted changes.

### Task 5: Root verifies independent musical/native workflows

**Files:** Create `tests/desktop/parity-clipboard.mjs`, `docs/validation/2026-10-15-gp8-clipboard.md`; extend `src/editor/clipboard-replay.test.ts` for independent output checks.

**Interfaces:** Existing native desktop-test bridge/build, exportGp/exportMidi, authored/public fixtures. Never commit private scores, clipboard snapshots with private music, binary backing assets or diagnostic executables.

- [ ] Independently decode SMF for source45->piano45, piano60/64->guitar60/64, custom drum82 on channel9, repeated clip count/timing/velocities and exact DSP .25 controller ticks. Check suffix program/tempo/CC7/CC10/sustain restoration, not only internal model flags. Inspect GPIF bar/meter/key/repeat/controller fields after export/reopen and preserve destination sibling/WAV bytes.
- [ ] Run complete frontend/native suites, typecheck/fmt and root's native desktop-test release build once integration is stable; report actual results and explicit hardware/bank skips.
- [ ] Exercise actual desktop partial single-lane Copy/Cut, complete-bar multitrack scope, Paste Special filters/count/mapping, failed unsupported destination, New/Open persistence, one-step undo/redo and save/full process restart with empty clipboard. Verify text-editing shortcuts and source file hashes unchanged. Capture safe rendered screenshots.
- [ ] Request an independent whole-delivery review, fix validated findings through meaningful RED tests and rerun affected checks. Root records evidence/limits and commits/pushes under standing authorization. Leave the remaining E08–E11/E21 gaps and full inventory open.

## Self-review and handoff

Coverage: finite DTOs Task 1; privacy/scope/links/store Task 2; pure candidate/filter/conversion/state/map Task 3; serialized history/source replay/UI Task 4; independent output/native proof Task 5. Each of the five review focuses maps to named RED tests. Existing selection, measure, lyric and fingering interfaces are consumed without changing worker-owned files. No undefined clipboard callback, recursive project snapshot, temporal fingering state or OS integration is assumed. The plan is bounded to the spec; unsupported contexts reject visibly and are not counted as parity. User preapproval permits root adoption/execution without a new permission question.

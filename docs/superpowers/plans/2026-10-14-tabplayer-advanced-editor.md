# TabPlayer Advanced Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete techniques, voices/staves, notation/rhythm, existing-track editing and the selection correction while preserving replay and originals.

**Architecture:** Extend the existing typed edit/history boundary. Focused editor modules apply public alphaTab model changes; candidate validation precedes native history commit. Shared project/settings DTOs provide the later audio/export contracts.

**Tech Stack:** Existing Rust/Tauri 2, TypeScript/React and pinned alphaTab 1.8.4.

**Spec:** [Advanced editor](../specs/2026-10-14-tabplayer-advanced-editor-design.md) and [shared expansion](../specs/2026-10-14-tabplayer-deferred-features-design.md).

## Global Constraints

- Engine version remains exactly 1.8.4.
- Version 1 projects migrate in memory without changing their musical result and save as version 2.
- A rejected edit or failed native commit keeps the displayed score and history unchanged.
- Private test music and extracted Guitar Pro application resources remain outside product/source releases.
- Keep the approved toolbar, track panel, score and inspector arrangement.
- Implementation and plan reviews are auto-approved; use inline execution and independent final review.

## Review Focus

1. Empty/fractional/non-finite selection drafts must not throw or change selection — task 1.
2. Undo/open at unchanged numerical indices must refresh fret/technique controls — tasks 1, 6.
3. Deleting/copying linked music must repair both relationship ends and avoid source links — tasks 3–4.
4. Imported empty/multiple voices must remain aligned after meter/staff operations — tasks 4–5.
5. Large assets and a failed native transaction must preserve document/history without retransmission — task 2.

## Files and interface ownership

Keep `src/engine.ts` as import/build/replay coordinator. Move its relationship helper into `src/editor/links.ts` when adding linked commands; add `techniques.ts`, `structure.ts` and `notation.ts` for the respective new families. `src/project.ts` and new `src/edit-types.ts` define runtime DTOs; matching Rust types live in `src-tauri/src/project.rs`, `edit_types.rs`, `settings.rs` and `assets.rs`. New UI controls live in `src/editor/` and compose into the existing `EditorPanel.tsx`/`TrackPanel.tsx`.

### Task 1: Whole-number selection and refreshed inspectors (E5)

**Files:** Create `src/selection.ts`, `src/editor/IndexInput.tsx`, `src/selection.test.ts`, `src/editor/IndexInput.test.tsx`. Modify `src/App.tsx`, `src/EditorPanel.tsx`, `src/App.test.tsx`.

**Interfaces:** Produce `repairSelection(score:model.Score, target:BeatTarget):BeatTarget`, `validSelectionIndices(target:BeatTarget):boolean` and `IndexInput({label,value,min,max,disabled,onValue}: {label:string;value:number;min:number;max:number;disabled?:boolean;onValue:(value:number)=>void})`. Input values are one-based; targets remain zero-based. `repairSelection` clamps whole-number indices to existing structures and uses zero for invalid numeric indices, retaining beat zero as an empty-voice insertion location. User input invokes `onValue` only for valid whole numbers in bounds; a blank draft remains editable.

- [ ] Write `rejects_fractional_and_empty_selection_drafts`, `repairs_deleted_staff_voice_and_empty_bar` and `refreshes_fret_after_undo_with_same_indices`: `expect(onValue).not.toHaveBeenCalled()` for `''`, `'1.5'`, non-finite and out-of-range drafts; then `expect(onValue).toHaveBeenLastCalledWith(2)` for valid `2`. After undo, `expect(fretInput).toHaveValue(originalFret)`.
- [ ] Run `npm test -- src/selection.test.ts src/editor/IndexInput.test.tsx src/App.test.tsx`; confirm the new cases fail for the intended missing/incorrect behavior.
- [ ] Implement the interfaces; route both measure/beat fields through IndexInput, guard user selection, replace App's local repair, and refresh selected-note controls from score/selection/string revisions.
- [ ] Rerun the targeted command and `npm run typecheck`; require all tests and type checking to pass.
- [ ] Commit the task files with message `fix: validate selection drafts and refresh selected notes`.

### Task 2: Finite command DTOs and v2 project/settings/assets (shared contract)

**Files:** Create `src/edit-types.ts`, `src/document-settings.ts`, `src-tauri/src/edit_types.rs`, `src-tauri/src/settings.rs`, `src-tauri/src/assets.rs`, `src/document-settings.test.ts`, `src-tauri/tests/project_v2.rs`. Modify `src/project.ts`, `src/engine.ts`, `src/controller.ts`, `src/bridge.ts`, `src-tauri/src/project.rs`, `files.rs`, `lib.rs`, `tests/protocol.json`, `src-tauri/tests/protocol.rs` and existing controller/project tests.

**Interfaces:** `StoredProject` is the on-disk schema-v2 envelope with `assets:Map<Sha256,StoredAsset>`; `StoredAsset` has `{filename,mediaType,bytesBase64}`. Runtime `ProjectView` has the same base/edits plus `assets:Record<string,AssetInfo>` with `{filename,mediaType,byteLength}` and no encoded audio. Export TS `Project=ProjectView` for existing consumers. `DocumentCandidate={project:ProjectView,path:string|null,token:string}` is native-staged; bridge methods become `createBlankDocument():Promise<DocumentCandidate>`, `readDocument():Promise<DocumentCandidate|null>`, `replaceProject(token:string):Promise<ProjectSnapshot>` and `applyEdit(command:EditCommand,assetToken?:string):Promise<ProjectSnapshot>`. Native staging retains full validated assets until candidate commit/cancel; a command and asset insertion commit together.

Produce `BuiltDocument={score:model.Score,settings:DocumentSettings,embeddedBacking:Uint8Array|null}`; `buildDocument(project:ProjectView):BuiltDocument`, keep `buildScore(project):model.Score` as wrapper, and extend `previewEdit(project,command,current?:BuiltDocument)` to return `{project:ProjectView}&BuiltDocument`. Settings-only commands reuse `current.score` and update audio without stopping/rebuilding notation. `DocumentState` extends BuiltDocument; score-changing commands retain serialized candidate-before-commit behavior.

Define these strict payloads once in matching Rust/TS, with fixture coverage for every variant:

| Commands | Payload |
| --- | --- |
| Existing commands | Preserve their names/payloads; duration becomes signed to allow `-4,-2` |
| `setNoteTechniques` | `{target:BeatTarget,string:number,patch:NoteTechniques}` |
| `setNoteLink` | `{from:NoteTarget,to:NoteTarget|null,kind:'tie'|'hammerPull'|'slur'}`; `NoteTarget={target:BeatTarget,string:number}` |
| `setBeatTechniques` | `{target,patch:BeatTechniques}` |
| `setBeatRhythm` | `{target,duration,dots,tupletNumerator,tupletDenominator,graceType}` |
| `setTrackInfo` | `{track,name,shortName,program}` |
| `setStaffSettings` / `addStaff` / `removeStaff` | `{track,staff,settings:StaffSettings}` / `{track,settings:StaffSettings}` / `{track,staff}` |
| `addVoice` / `removeVoice` / `copyVoice` | `{track,staff}` / `{track,staff,voice}` / `{track,staff,sourceVoice,destinationVoice,startBar,endBar}` |
| `setTrackLayout` | `{track,barsPerSystem:number,lineBreaks:number[]}` |
| `setMeasureSettings` | `{bar,numerator,denominator,pickup:boolean,freeTime:boolean,repeatStart:boolean,repeatCount:number,endings:number[],section:string,tempos:TempoPoint[]}` |
| `setBarNotation` / `setBeatAnnotation` | `{track,staff,bar,keySignature:number,keyMode:number,clef:number}` / `{target,text:string,chord:ChordDefinition|null}` |
| `setTrackSound` / `setTrackMix` | `{trackId:string,sound:TrackSound}` / `{trackId:string,mix:ChannelMix}` |
| `setBacking` | `{backing:BackingSettings|null}`; null explicitly selects score-only |
| `setPrintLayout` | `{layout:PrintLayout}` |

`NoteTechniques` has optional boolean `letRing,palmMute,dead,ghost,staccato,leftHandTapped`; numeric public-enum `accent,dynamics,leftFinger,rightFinger,slideIn,slideOut,vibrato,ornament`; nullable `bend:PitchCurve`, `harmonic:{type:number,value:number}`, `trill:{pitch:number,speed:number}`. `BeatTechniques` has optional public-enum `pickStroke,brushType`, `brushDuration`, nullable `whammy:PitchCurve`, `tremolo:{speed:number,style:number}`. `PitchCurve={type:number,style:number,points:{offset:number,value:number}[]}` uses the pinned public enums, finite sorted 0–60 offsets and endpoints. `TempoPoint={beat:number,bpm:number,linear:boolean}`. `StaffSettings={tuning:number[],capo:number,transposition:number,displayTransposition:number,clef:number,showTab:boolean,showNotation:boolean}`. `ChordDefinition={name:string,firstFret:number,frets:number[]}` (`-1` mute, `0` open).

`ChannelMix={gain:number,pan:number,mute:boolean,solo:boolean}`, gain 0–1, pan -1–1. `TrackSound={voiceId:string|null,presetId:'clean'|'crunch'|'lead'|'bass'|'gm',effects:FxSettings}`, null voice means automatic program selection. FxSettings fields/defaults are defined in audio task 3. `SyncAnchor={bar:number,occurrence:number,ratio:number,audioMs:number}`, ratio 0–1 and occurrence zero-based. `BackingSettings={assetId:string,offsetMs:number,anchors:SyncAnchor[],mix:ChannelMix}`. `PrintLayout={paper:'A4'|'Letter',orientation:'portrait'|'landscape',marginMm:number,scale:number,profile:'ScoreTab'|'Score'|'Tab'}`. `DocumentSettings={sounds:Record<string,TrackSound>,mixes:Record<string,ChannelMix>,backing:BackingSettings|null,print:PrintLayout}`. Default print: A4 portrait, 15 mm, scale 1, ScoreTab. Sound/mix defaults are automatic GM, bypassed effects, gain 1/pan 0/unmuted; imported native program mute/solo state is respected.

- [ ] Add `migrates_v1_without_music_change`, `v2_rejects_hash_missing_asset_unknown_field`, `asset_edit_failure_is_atomic`, `snapshot_omits_large_audio`, `settings_replay_tracks_structural_identity` and strict shared fixture tests: `assert_eq!(loaded.schema_version,2)`; `assert_eq!(source_before,source_after)`; `assert!(!snapshot_json.contains("bytesBase64"))` for an audio-only asset; failed transactions leave snapshot/history equal. Source base bytes remain present as before.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --test project_v2 --test protocol` and `npm test -- src/document-settings.test.ts src/controller.test.ts`; confirm intended red cases.
- [ ] Implement the DTOs/migration/staging/atomic session transaction, metadata-only views and settings replay. Validate pinned enums and finite values in both boundaries. Capture embedded audio before transient model JSON rebuild. Remove only orphaned helpers created by this extraction.
- [ ] Rerun the targeted tests, typecheck, Rust tests and formatting; require green. Verify a saved applied-history copy can compact assets without losing live redo assets.
- [ ] Commit `feat: add replayable v2 project settings and audio assets`.

### Task 3: All technique families and linked-note lifecycle (E1)

**Files:** Create `src/editor/links.ts`, `src/editor/techniques.ts`, `src/editor/techniques.test.ts`. Modify `src/engine.ts`, `src/engine.test.ts`.

**Interfaces:** `applyNoteTechniques(score:model.Score,target:NoteTarget,patch:NoteTechniques):void`, `applyBeatTechniques(score,target:BeatTarget,patch:BeatTechniques):void`, `applyNoteLink(score,from:NoteTarget,to:NoteTarget|null,kind:LinkKind):void`, `detachNote(note:model.Note):void`. `LinkKind` is task 2's three-value union. Apply through replay; public JSON rebuilding must not erase deliberate long slurs/links.

- [ ] Add parameterized `technique_family_roundtrip` cases for every task-2 field and public enum option. Assert `expect(reopenedNote.isPalmMute).toBe(true)`, matching curve points/harmonic pitch, linked endpoints, and cleared data on removal. Add `break_tie_allows_independent_pitch`, `reject_backward_or_wrong_string_link`, `delete_note_rest_beat_bar_repairs_both_ends`, `independent_chord_bend_curves` and native-history replay coverage.
- [ ] Run `npm test -- src/editor/techniques.test.ts src/engine.test.ts`; verify intended failures.
- [ ] Implement fields/enums/curve validation and relationship operations through public model APIs. Preserve imported techniques, validate real sounding pitches, and retain whole-tie-chain pitch changes until a tie is broken.
- [ ] Rerun targeted tests and typecheck. Generate MIDI in tests to assert bends/vibrato/slide/trill/tremolo timing and pitches; record per-field GP export/reimport coverage rather than hiding exporter omissions.
- [ ] Commit `feat: edit guitar techniques and note relationships`.

### Task 4: Existing tracks, voices/staves and layout (E2, E4)

**Files:** Create `src/editor/structure.ts`, `src/editor/structure.test.ts`, `src/midi-programs.ts`. Modify `src/engine.ts`, `src/TrackPanel.tsx`, `src/TrackPanel.test.tsx`, task-2 settings replay.

**Interfaces:** `applyStructureEdit(score:model.Score,command:EditCommand,editIndex:number):boolean` returns whether it handled the command. Produce all track/staff/voice/layout commands in task 2. Export `midiPrograms:readonly string[]` with all 128 standard names. Keep existing `trackIdentity(track)` for sounds/mixes; copy voice music through public transient cloning with reconstructed internal links.

- [ ] Add `rename_and_program_existing_imported_track`, `all_128_programs_are_selectable`, `one_to_four_voices_aligned`, `voice_copy_rebuilds_internal_links`, `remove_staff_voice_repairs_selection`, `track_undo_restores_identity_and_sound` and `layout_breaks_shift_on_bar_delete`: `expect(voicesPerBar).toEqual([2,2,2,2])`; copied links point into the copy; untouched tracks retain exact music; v2 save/reopen preserves settings.
- [ ] Run `npm test -- src/editor/structure.test.ts src/TrackPanel.test.tsx`; verify red.
- [ ] Implement existing-track names/programs, staff add/remove/settings, voice add/remove/range-copy and system layout. Keep one staff/voice and no more than four voices; explicitly empty carriers have no independent audible duration. Reject overflow before commit.
- [ ] Rerun targeted tests/typecheck and relevant history/native tests; verify MIDI program/pitches and selection after structural undo/redo.
- [ ] Commit `feat: configure existing tracks and manage staff voices`.

### Task 5: Rhythm, measures and notation (E3)

**Files:** Create `src/editor/notation.ts`, `src/editor/notation.test.ts`. Modify `src/engine.ts`, existing duration/measure tests.

**Interfaces:** `applyNotationEdit(score:model.Score,command:EditCommand,editIndex:number):boolean`. Implement the task-2 rhythm/measure/bar/annotation command payloads. Tuplet numerator/denominator are positive integers; durations are `[-4,-2,1,2,4,8,16,32,64,128,256]`, dots 0–3. Time denominator is a supported power of two; alternate ending numbers 1–8 map to the public bitmask. Validate all voices before changing meter.

- [ ] Add `duration_tuplet_grace_capacity`, `meter_change_rejects_other_voice_overflow`, `pickup_free_time_repeat_endings_tempo`, `key_clef_text_chord_reopen`, `measure_delete_preserves_initial_and_intra_bar_tempo` and `triple_dots_survive_new_rhythm_controls`: generated quarter-dot-dot-dot duration is 1800 ticks; 3:2 eighths total one quarter; rest/empty/grace cases are distinct; rejected changes leave history/music equal.
- [ ] Run `npm test -- src/editor/notation.test.ts src/engine.test.ts`; verify red.
- [ ] Implement public rhythm/measure/key/clef/text/chord operations and typed validation. Preserve the triple-dot fix and source properties; chord IDs are unique per creating edit, avoiding accidental mutation of another beat's diagram. Update structural settings/anchors consistently.
- [ ] Rerun targeted tests/typecheck; compare generated repeats, tempo ordering, sounding pitches and rendered notation. Export/reimport the supported fields and document mismatches.
- [ ] Commit `feat: edit complex rhythms measures and notation`.

### Task 6: Complete inspector integration and native regression

**Files:** Create `src/editor/TechniquePanel.tsx`, `CurveEditor.tsx`, `StructurePanel.tsx`, `MeasurePanel.tsx`, `ChordDialog.tsx`, their component tests, `tests/desktop/advanced-editor.mjs`. Modify `src/EditorPanel.tsx`, `src/App.tsx`, `src/TrackPanel.tsx`, `src/styles.css`, `docs/validation/2026-10-14-tabplayer-expansion.md` (create report if absent).

**Interfaces:** Panels consume `{score,target,string,busy,onEdit}` and task-2 DTOs; structure controls also consume `onSelect`. `CurveEditor` edits `PitchCurve|null`; `ChordDialog` edits `ChordDefinition|null`. Use existing controller and selected-note readback, no second history store.

- [ ] Write UI tests selecting each technique family, editing a curve, breaking a tie, adding/copying/removing a voice/staff, changing an existing program, and editing meter/chords. Assert dispatched exact payloads and rendered readback after undo/reopen; add keyboard/focus and disabled-busy checks.
- [ ] Run the new component tests and `npm test -- src/App.test.tsx`; verify intended red.
- [ ] Resume the existing approved Superdesign target through its skill and `.superdesign/resume.json`; use replace/targeted context for the new controls while retaining the approved shell. Implement the panels/dialogs and integrate finite command dispatch.
- [ ] Run the full frontend/Rust suites, typecheck/fmt/diff checks, then `scripts/build-desktop-test.ps1` and `node tests/desktop/advanced-editor.mjs`. Use the authorized private corpus locally; verify source hashes, save/restart/reopen, symbols, rapid deletion, mixer history and 100-bar/four-track performance. Record real results/GP limitations in the expansion report.
- [ ] Commit `feat: expose complete advanced editor controls` and continue into the native-audio plan; this is an intermediate deliverable.

# TabPlayer Native Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement realistic recorded guitar/bass voices, articulations, amps/effects, synchronized backing audio and native playback shared with offline export.

**Architecture:** Public alphaTab generation produces identity-preserving playback plans. A Rust renderer owns sample voices, backing time mapping, effects and one sample clock; CPAL consumes its preallocated blocks. Native assets stay outside webview snapshots.

**Tech Stack:** Add exact direct Cargo pins `cpal =0.18.2`, `symphonia =0.6.1` (PCM/WAV, FLAC, MP3, Ogg/Vorbis features), `rustysynth =1.3.7`, `ringbuf =0.5.3`. Preserve Rust floor 1.85 unless an actual selected dependency requires a documented change; test locked builds. No audio-plugin host or runtime network download.

**Spec:** [Native audio](../specs/2026-10-14-tabplayer-native-audio-design.md) and [shared expansion](../specs/2026-10-14-tabplayer-deferred-features-design.md). Consumes [editor task 2 contracts](2026-10-14-tabplayer-advanced-editor.md).

## Global Constraints

- Engine version remains exactly 1.8.4.
- Practice speed remains 25–200% and preserves pitch for both score and backing, including seeks/loops at non-default speed.
- The audio callback renders preallocated blocks; it performs no file I/O, decoding, blocking locks or Tauri calls.
- Live and offline rendering use the same Rust musical voices and effects.
- Shipping builds omit the existing desktop test commands.
- Private test music and extracted Guitar Pro application resources remain outside product/source releases.
- Sound sources and presets retain stable manifest identifiers across project replay.

## Review Focus

1. Same-pitch overlapping voices and different-string bends must remain independent — tasks 1, 3.
2. Grace/tremolo/brush/tied notes through repeats must agree with generated timing — tasks 1, 3.
3. Missing/corrupt licensed samples must fail preparation without replacing working playback — tasks 2, 5.
4. Nonzero offsets/drift anchors/repeats with speed changes must keep backing aligned — task 4.
5. Device errors and late async preparation must not leave false playing state or install stale music — task 5.

## File/contract map

Create `src/audio/plan.ts`, `types.ts`, `plan.worker.ts`, `bridge.ts`, `NativePlaybackController.ts`, `BackingPanel.tsx`, `SoundPanel.tsx`. Rust audio lives in `src-tauri/src/audio/{mod,plan,decode,resources,voices,dsp,renderer,backing,device}.rs`. The processing core remains callable without CPAL/Tauri. Only device/control code invokes platform APIs.

`PlaybackPlan={generation:number,ppq:960,durationTick:number,durationMs:number,tracks:PlanTrack[],tempos:PlanTempo[],occurrences:MeasureOccurrence[],notes:PlanNote[],midi:PlanMidiEvent[]}`. `PlanTrack={id:string,program:number,percussion:boolean}`. `PlanTempo={tick:number,bpm:number}`. `MeasureOccurrence={bar:number,occurrence:number,startTick:number,endTick:number,startMs:number,endMs:number}`. `PlanNote={id:string,trackId:string,source:NoteTarget,occurrence:number,startTick:number,endTick:number,key:number,velocity:number,articulation:Articulation,legatoFrom:string|null,pitch:PitchPoint[]}`. `PitchPoint={tick:number,semitones:number}`. Articulation is a finite union of `picked,fingered,muted,dead,ghost,staccato,legato,tapped,harmonic,feedback`. PlanMidiEvent is a tagged union of note-on/off, program, controller and channel/per-note bend with explicit trackId/tick/channel/key/value fields appropriate to each type. Convert MIDI pitch-wheel values to relative semitones with the generated pitch-range state. Validate sorted finite times, unique note IDs, existing track/source IDs and finite MIDI parameters before installation.

### Task 1: Identity-preserving note/event plans

**Files:** Create the three TS plan/type/worker files, `src/audio/plan.test.ts`, Rust `audio/mod.rs`, `audio/plan.rs`, `src-tauri/tests/audio_plan.rs`. Modify `src-tauri/src/lib.rs`, `src/engine.ts` only for public embedded-audio extraction and plan inputs.

**Interfaces:** `buildPlaybackPlan(score:model.Score,generation:number):PlaybackPlan`; `preparePlan(project:ProjectView,generation:number):Promise<PlaybackPlan>`. Rust `PlaybackPlan::validate(&self)->Result<(),String>` and `Timeline::tick_to_seconds(tick:f64)->f64` / `seconds_to_tick(seconds:f64)->f64`. Worker inputs are project views or transient public-model JSON plus original stable track IDs; never persist model JSON.

- [ ] Write `same_pitch_different_voice_keeps_identity`, `independent_string_bend_curves`, `repeats_endings_tempo_grace_brush_tremolo` and `tie_and_legato_voice_chain`. Assert `expect(noteIds.size).toBe(plan.notes.length)`, two simultaneous equal-pitch notes have distinct source voices/IDs, contrasting string bends have distinct curves, tied segments sustain one voice, and all event onsets/pitches match full-score public MIDI generation. Rust fixtures assert tick/seconds inversion and reject NaN/unsorted/unknown IDs.
- [ ] Run `npm test -- src/audio/plan.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml --test audio_plan`; verify intended red.
- [ ] Implement global occurrence/tempo data through public MidiFileGenerator/tick lookup. Generate transient per-staff/voice/string lanes for expressive guitar notes, preserving original rhythm/master-bar timing and a side map back to NoteTarget; associate note events within their unambiguous lane/beat occurrence. Use the complete original MIDI stream for GM/percussion. No private-method hooks or pitch-only matching. Build in the owned worker; discard stale generation results.
- [ ] Rerun targeted tests/typecheck/Rust fmt; compare public full-score and lane schedules on the 100-bar fixture and imported ties/tuplets. Resolve timing disagreements before claiming a valid plan.
- [ ] Commit `feat: prepare native playback plans with note identity`.

### Task 2: Pinned recorded assets and native decoding

**Files:** Create `assets/audio/sources.json`, `scripts/prepare-audio.mjs`, `scripts/prepare-audio.test.mjs`, Rust `audio/decode.rs`, `audio/resources.rs`, `src-tauri/tests/audio_resources.rs`. Modify `.gitignore`, `package.json`, `src-tauri/Cargo.toml`, lockfiles, `tauri.conf.json`, `scripts/copy-notices.mjs`, `THIRD_PARTY_NOTICES.md`.

**Interfaces:** `DecodedAudio={sampleRate:u32,channels:u16,frames:Arc<Vec<[f32;2]>>}`; `decode_audio(bytes:&[u8],hint:Option<&str>)->Result<DecodedAudio,String>`. `InstrumentManifest` has schema/version, stable instrument IDs, source revisions/licenses and regions `{sampleId,rootKey,keyLow,keyHigh,velocityLow,velocityHigh,articulation,variant,loopStart,loopEnd,attackSeconds,releaseSeconds,gainDb}`. `AudioResources::load(root:&Path)->Result<Self,String>` loads/hash-checks referenced samples and an Arc SoundFont. `prepare-audio.mjs` writes ignored `src-tauri/resources/audio/`, validates confined sample paths and produces the manifest; source hashes and license texts are committed separately from large generated assets.

Pin guitar repository `sfzinstruments/karoryfer.black-and-green-guitars` at `b3b3249d37dc977a1a297bd2dc053e6d9b6b805c`; bass `sfzinstruments/karoryfer.black-and-blue-basses` at `6e7d674cdb41be7a54dbccb15472401ad01099b9`. Preserve all ordinary/staccato/hammer/release/feedback regions used by chosen green/black guitar voices and regular/ghost/staccato regions for darkblack/babyblue basses, including all referenced velocity/variation layers. Resolve their includes/control defaults into explicit manifest values; fail for an unhandled mapping opcode affecting a chosen region. Record file SHA-256 inventory on the first pinned fetch, then verify later builds against it. Sonivox remains the separate Apache-2.0 GM bank.

- [ ] Add `pinned_manifest_keeps_velocity_variants`, `missing_corrupt_or_escape_sample_rejected`, `decode_wav_flac_mp3_vorbis` and `asset_hash_and_license_inventory`: assert each sample reference exists/matches SHA, velocity/variant sets retain source mapping coverage, decoded duration/rate/channels match known fixtures, unsupported/corrupt input returns an error. Script tests use small authored SFZ/WAV mappings, not private music.
- [ ] Run `node --test scripts/prepare-audio.test.mjs` and `cargo test --manifest-path src-tauri/Cargo.toml --test audio_resources`; verify red.
- [ ] Add the pinned dependencies, fetch/convert public sources, bundle curated manifest/referenced samples plus license/provenance, and implement decoding/hash validation. Decoder work runs off the audio callback; refresh notices and resource copy configuration.
- [ ] Rerun tests, locked Cargo build and offline resource loading. Verify actual region counts/coverage and license text; do not substitute one generic patch for the recorded engine.
- [ ] Commit `feat: bundle licensed guitar bass samples and decode audio`.

### Task 3: Shared sample voices, SoundFont fallback and DSP

**Files:** Create `audio/voices.rs`, `audio/dsp.rs`, `audio/renderer.rs`, `src-tauri/tests/audio_render.rs`, `audio_dsp.rs`; implement matching FxSettings in editor task 2's Rust/TS settings files.

**Interfaces:** `Renderer::new(plan:Arc<PlaybackPlan>,resources:Arc<AudioResources>,settings:DocumentSettings,sample_rate:u32)->Result<Renderer,String>`; `render_into(&mut self,output:&mut[[f32;2]])->RenderStatus`; `seek_tick(&mut self,tick:f64)`, `set_speed(&mut self,speed:f64)->Result<(),String>`, `set_mix(&mut self,settings:PreparedMix)`; `PreparedMix::prepare(settings:&DocumentSettings,plan:&PlaybackPlan,sample_rate:u32)->Result<Self,String>` allocates effects buffers off the callback. `RenderStatus={frames:usize,tick:f64,seconds:f64,ended:bool}`. `render_stems_into(&mut self,outputs:&mut[&mut[[f32;2]]])->RenderStatus` yields aligned post-track-effect/pan/gain, pre-master-limiter buffers. `AudioResources` owns decoded samples/SoundFont; multiple track voices share them.

FxSettings is a strict nested DTO; each block has `enabled:bool` and these named finite parameters:

| Block | Fields, bounds and bypass defaults |
| --- | --- |
| gate | `thresholdDb` -96..0 (-60), `releaseMs` 1..1000 (100) |
| compressor | `thresholdDb` -60..0 (-18), `ratio` 1..20 (4), `attackMs` .1..200 (10), `releaseMs` 1..2000 (100), `makeupDb` 0..24 (0) |
| amp | `model:'clean'|'crunch'|'lead'|'bass'`, `drive` 0..1 (.1), `gainDb` -24..24 (0) |
| cabinet | `model:'open'|'closed'|'bass'` (open); deterministic app-generated filters |
| eq | `lowDb,midDb,highDb` -24..24 (0), `midHz` 200..5000 (1000) |
| chorus | `rateHz` .1..8 (1), `depthMs` 0..20 (5), `mix` 0..1 (.15) |
| delay | `quarterNotes` one of .125/.25/.5/1/2/4 (1), `feedback` 0...9 (.25), `mix` 0..1 (.15) |
| reverb | `room,damping,mix` 0..1 (.5/.5/.12) |

All blocks default disabled for `gm`. Clean enables amp .1/open cabinet; crunch amp .4/closed cabinet and EQ mid +2 dB; lead amp .75/closed cabinet, delay .15 and reverb .12; bass amp .2/bass cabinet, compressor -18 dB/4:1/+3 dB makeup and EQ low +3/high -2 dB. Preset blocks otherwise use the table defaults. Fixed order is voice→gate→compressor→amp→cabinet→EQ→chorus→delay→reverb→pan/gain→master limiter. Ramp changed parameters over 10 ms. Use preallocated bounded render chunks (512 frames), deterministic variant selection, and validate/preallocate requested delay durations before installing configurations.

- [ ] Add `recorded_attack_velocity_round_robin`, `mute_dead_ghost_staccato_envelopes`, `tie_hammer_slide_harmonic_and_poly_bend`, `gm_and_percussion_fallback`, `dsp_bypass_response_delay_tail`, `preset_replay` and `stem_sum_matches_pre_limiter`. Assert frequencies/curve points, independent same-pitch voices, no tied/legato picked retrigger, shorter muted decay, distinct variants, finite bounded master samples, bypass identity and expected delay sample offset. Compare pre-limiter stem sum numerically.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --test audio_render --test audio_dsp`; verify red.
- [ ] Implement recorded voice resampling/envelopes/legato/pitch/articulation processing, per-track RustySynth fallback, reusable DSP and deterministic render/stem paths. Transport speed changes event timing, not oscillator/sample pitch. Buffer allocation and resource preparation occur outside render callbacks.
- [ ] Rerun targeted tests, full Rust tests/fmt and actual pinned-asset renders at 44.1/48 kHz. Produce clean/crunch/lead/bass demos with contrasting techniques, measure timing/pitch/output bounds and retain listening artifacts locally. Human review is auto-approved; distinguish this authorization from any claim of a listening observation.
- [ ] Commit `feat: render realistic instrument voices and native effects`.

### Task 4: Embedded/local backing, synchronization and stretch

**Files:** Create `audio/backing.rs`, `src/audio/backing.ts`, `src/audio/BackingPanel.tsx`, `src/audio/backing.test.ts`, `src-tauri/tests/audio_backing.rs`. Modify native candidate/asset commands, `src/bridge.ts`, `src/controller.ts`, settings replay and `src/App.tsx`.

**Interfaces:** `stageBacking():Promise<{token:string,assetId:string,info:AssetInfo,durationMs:number}|null>`; `stageEmbeddedBacking(bytes:Uint8Array):Promise<same candidate type>`. Rust `BackingMap::new(anchors:&[SyncAnchor],offset_ms:f64,plan:&PlaybackPlan)->Result<Self,String>` and `source_seconds(score_seconds:f64)->f64`; `BackingVoice::new(audio:Arc<DecodedAudio>,map:BackingMap,sample_rate:u32)->Result<Self,String>`. A null backing command overrides embedded playback to score-only; an absent backing command uses original embedded audio/sync points. Distinguish absence from explicit null during settings replay.

- [ ] Add `embedded_backing_survives_rebuild`, `backing_transaction_and_self_contained_reopen`, `anchor_occurrence_not_display_index`, `drift_offset_seek_loop_speed_pitch` and `deleted_music_moves_or_removes_anchors`. Use synthetic clicks/tones: `assert!(alignment_error_frames<=512)` and `assert!(relative_frequency_error<0.01)` at 25/100/200%; offset/drift/repeat seeks agree, bad anchor maps preserve previous project.
- [ ] Run targeted JS/Rust backing tests and project-v2/controller tests; verify red.
- [ ] Implement native import/decoding/asset staging, embedded extraction before JSON rebuilding, immutable asset references and backing inspector commands. Implement stereo phase-coherent WSOLA time stretching using preallocated overlap/search buffers and piecewise anchor mapping. Share clock/range/speed/mix/solo rules with synthesis. Handle before/after media bounds as silence; whole-song duration reaches the longer mapped source.
- [ ] Rerun tests and independently decode captured/offline output. Verify anchors after measure/staff/voice edits, undo/redo, replacing/removing backing, failed decode, save/restart/reopen, and metadata-only routine snapshots with a multi-minute file.
- [ ] Commit `feat: mix synchronized pitch-preserving backing audio`.

### Task 5: CPAL transport, public cursor and full sound UI

**Files:** Create `audio/device.rs`, `src/audio/bridge.ts`, `src/audio/NativePlaybackController.ts`, `src/audio/SoundPanel.tsx`, native controller/panel tests, `src-tauri/tests/audio_transport.rs`, `tests/desktop/native-audio.mjs`. Modify `src/playback.ts`, `src/ScoreView.tsx`, `src/TrackPanel.tsx`, `src/Transport.tsx`, `src/App.tsx`, `src-tauri/src/lib.rs`, capabilities and validation report.

**Interfaces:** `AudioService::prepare(plan:PlaybackPlan,settings:DocumentSettings)->Result<(),String>`, `command(command:TransportCommand)->Result<(),String>`, `devices()->Result<Vec<AudioDeviceInfo>,String>`. TransportCommand variants are play/pause/stop/seekTick/setSpeed/setLoop/clearLoop/setPreparedMix/selectDevice; bounded ringbuf holds controls, owned audio callback holds Renderer. Status publication uses an independent thread at 30 Hz and atomic/shared nonblocking status, not Tauri inside the callback. `NativePlaybackController` retains the UI-used PlaybackController methods/state/subscription shape while delegating to native bridge; persisted mixer/sound changes dispatch editor commands rather than a second history.

- [ ] Write `native_state_ack_not_button_intent`, `late_generation_cannot_replace_score`, `device_error_is_recoverable`, `inclusive_loop_seek_pause_resume`, `mix_undo_delete_new_document`, `external_cursor_has_one_audio_clock` and panel payload tests. Assert failed play does not set playing, stale prepare is ignored, loop repeats exact frame/tick interval, undo restores sound/mix and ordinary sound tweaks do not rebuild/stop score playback.
- [ ] Run controller/panel tests and `cargo test --manifest-path src-tauri/Cargo.toml --test audio_transport`; verify red.
- [ ] Implement default/selected output with CPAL sample-format/rate adaptation, lock-free callback controls and recoverable device reopening. Connect alphaTab `EnabledExternalMedia` through its documented external-media output/handler to native position; avoid recursive midiLoaded registration. Implement voice/preset/effect/device/backing controls in the approved shell using the existing Superdesign context.
- [ ] Run full suites/typecheck/fmt/diff, build desktop-test and run `node tests/desktop/native-audio.mjs`; capture actual Windows PCM, verify transport/backing/effects/offline assets, no second synth, no callback I/O/locks and 100-bar/four-track performance. Record native macOS/Linux work in the delivery task. Update validation with all articulation/effect results and demo paths.
- [ ] Commit `feat: play and configure the native audio engine`; continue to exports/delivery.

Registry pins and sample revisions were checked through primary crates.io/GitHub APIs on 2026-10-14. PDF dependencies are owned by the exports plan; do not add them here.

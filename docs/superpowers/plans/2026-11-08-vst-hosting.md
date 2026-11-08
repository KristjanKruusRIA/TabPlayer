# VST3 plug-in hosting on tracks Implementation Plan, Windows first (THE-71)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user loads one VST3 effect onto a track in place of the built-in drive, amp and cabinet. It plays live and in exports, its editor opens from the sound panel, and its settings are saved in the document. A crash, hang or missing plug-in never takes down the app or stops playback: the track falls back to the built-in tone with a notice. First version: Windows x64 only.

**Architecture:**
- A separate helper executable, `tabplayer-plugin-host`, runs exactly one plug-in. It ships as a Tauri `externalBin` and lives in a Job Object that kills it with the app.
- Audio crosses a shared-memory ring in blocks of 128 frames. Control messages cross the helper's stdin and stdout as bounded, length-prefixed JSON.
- On the app side, a realtime `PluginInsert` inside `TrackDsp` sends blocks and reads results `P` frames later (`P` = two device callbacks). The track's delay is `D = P + L`, and a `Compensation` stage delays every other stem by `D_max − D`.
- A supervisor thread watches heartbeats and exits. Faults crossfade the track to its built-in Drive, Amp and Cabinet.
- The document holds a `PluginSlot` naming the class ID and a content-addressed state asset, never a path. A per-user library maps class IDs to bundles the user chose.
- Exports use a fresh helper in offline mode, with the latency trimmed.

**Tech Stack:** Rust 1.90 (edition 2024) in a Cargo workspace under `src-tauri/`, with three new members: `plugin-protocol` (lib), `plugin-host` (bin) and `test-plugin` (cdylib). `windows-sys` 0.61 (already locked) handles Win32. The helper's hosting core is either the `vst3` 0.3.0 bindings with vendored Soundcraft FFI, or the VST3 SDK 3.8 C++ hosting classes; Task 1 decides. The UI is React 19, TypeScript and Vitest, and the shell is Tauri 2 commands and events.

**Spec:** `docs/superpowers/specs/2026-11-07-vst-hosting-design.md` (the authority) and Linear THE-71. This plan covers spec slices 1 (spikes) and 2 (first shippable slice). Slices 3 to 6 stay out.

**Branch:** `feature/vst-hosting` in `.worktrees/vst-hosting`. **Precondition before Task 5:** merge `develop` into `feature/vst-hosting` after `feature/nam-captures` has merged into `develop`. Line numbers cite `develop` at `10f4fa4`; those marked (NAM) cite `feature/nam-captures`. Where NAM moved code, find the symbol by name.

## Rulings made before planning

- **Toolchain.** `develop` now pins Rust 1.90.0 in CI, so Soundcraft's 1.90 MSRV no longer blocks us (the spec said 1.88). We still vendor Soundcraft's code rather than depend on it, for the spec's other reasons: it runs in-process only, needs Soundcraft's DSP `Plugin` trait, and keeps process-global state.
- **Workspace.**
  - `src-tauri/Cargo.toml` gains `[workspace] members = ["plugin-protocol", "plugin-host", "test-plugin"]`. Each member is added in the task that creates it.
  - The target folder stays `src-tauri/target`, with one `Cargo.lock`.
  - The app crate depends on `plugin-protocol` only. It never links plug-in code and never calls `LoadLibrary` on a plug-in.
- **Helper transport.**
  - The control channel is the helper's stdin and stdout. The helper reads nothing until the app's first message, so the app assigns it to the Job Object first.
  - The helper exits when stdin closes. That also covers the spec's Unix rule.
  - Shared memory is an unnamed file mapping. The app duplicates the mapping and two auto-reset events into the helper with `DuplicateHandle` and sends their values in `Load`.
- **Packaging.** `tauri-build` 2.7.4 copies every `externalBin` during `build.rs` and fails when the file is missing (`copy_binaries`, read from the local registry). The `bundle.externalBin` entry therefore lives in an overlay, `src-tauri/tauri.plugin-host.conf.json`, merged with `--config`. Plain `cargo test` never needs the helper. Without the overlay, the app finds the helper beside its own exe. A missing helper gives the status `hostMissing`.
- **Statuses.** The spec's nine (`ready`, `missing`, `unreadable`, `crashed`, `hung`, `needsConsent`, `unsupportedPlatform`, `tooMuchLatency`, `rejectedState`) plus five more:
  - `loading`, while a helper starts and the built-in tone plays;
  - `underrun` and `nonFinite`, so the spec's "reports the reason" is exact;
  - `tooMany`, for more than 8 active slots in a document;
  - `hostMissing`, when the helper exe is absent (development builds).
- **Faults.**
  - On underrun or a non-finite block there is no plug-in output to crossfade from. The last good plug-in sample is ramped to zero over 10 ms while the built-in chain ramps in. That is neither a click nor silence.
  - On a crash detected with data in hand, it is a normal 10 ms crossfade.
  - A fault holds until the sound is next prepared or the user picks "Try again".
  - A helper that crashes three times in one document session stays `crashed` until "Try again".
- **Fallback order.** While the plug-in is faulted or fading, the enabled built-in Drive, Amp and Cabinet run together, in their relative order, at the plug-in's position. Their input is delayed by the track's `D`, so the fallback stays aligned with the compensation. In the default effect order the three are adjacent, so nothing changes.
- **Backing compensation (spec conflict).** The spec reads the backing at `seconds − D/rate`. We delay the backing's output through a delay line instead, like the other stems. A read offset jumps back to the loop start at a wrap, while a delay line carries the previous pass's last `D_max` frames across it. This matters because the spec also rules the loop wrap seamless.
- **Offline export (interpreting "no pipeline").** Export exchanges each 128-frame block synchronously. The per-frame renderer still needs one block before a result exists, so `D_off = 128 + L`. That is trimmed exactly, so exports keep their length and alignment.
- **Consent (interpreting "per document and plug-in").** Consent is keyed by `(classId, state asset id)`, because the state blob is the untrusted input that reaches plug-in code.
  - States this machine produced, through choosing a plug-in or an editor save, are consented automatically.
  - "Allow plug-ins" grants every pair that the document names anywhere, history included.
  - A document ID can be forged and a state hash cannot, so this is stricter than a per-document flag.
- **Document details.**
  - `classId` is 32 uppercase hex characters.
  - `state` is required, because choosing a plug-in captures its default state at once.
  - `format` accepts only `"vst3"`. A future `"clap"` fails closed in this build.
  - Plug-in state assets total at most 64 MiB per project. The edit log keeps every state for undo, and the intake cap is 512 MiB (`intake.rs:29`). A save past the cap is refused with a "settings history full" notice. This is a recorded limit; Task 1 measures real state sizes to check it.
- **Seek and stop.** A flush makes the helper call `setProcessing(false)` then `setProcessing(true)` on its audio thread. That is VST3's light reset for delay lines and reverbs. Plug-ins that ignore it may bleed a pre-seek tail, which is a recorded limit.
- **Mono and layouts.** Plug-ins get a stereo main bus. A mono-only plug-in gets `(L+R)/2` and its output is duplicated to both channels. Any other layout gives `unreadable`.
- **Edit lock.** The editor opens, but on close the helper's state returns to the document's state, and nothing is staged.
- **Sound library and factory sounds** do not carry plug-ins: `repairSound` in `src/audio/sound-library.ts` already drops unknown keys. Applying one keeps the track's plug-in slot.
- **Line-In and auditions** use the built-in tone. Inserts are attached only for playback and export, through `PreparedMix::prepare_with_plugins`.
- **Cursor.** The visual cursor is not compensated: it runs `D_max` ahead of the audio. `NativeAudioStatus.pluginDelayFrames` reports the delay, so a later change can subtract it.
- **CI on three operating systems.** The spec asks for the end-to-end tests on all three. Under user decision 1, they run on Windows. macOS and Linux run everything that isn't hosting: schema, assets, caps, ring, fallback with a fake helper, notice text, and the stub.
- **Library intake.** v1 uses a file picker filtered to `.vst3`. The picker accepts the bundle's inner module (resolved to the bundle root) or a single-file module. Scanning is slice 3. A module whose size or modification time changed is re-probed before loading.

## Global Constraints

- **Licences, checked 2026-11-07 and 2026-11-08 from the sources named:**
  - **VST3 SDK.** MIT since 3.8.0 (2025-10-20), per the `steinbergmedia/vst3sdk` README and Steinberg's forum release post. Only 3.8.0 or later may be vendored or read. Older copies are GPLv3 or proprietary and must not be used. The `vst3` crate's bindings are generated from the SDK interface headers, so `THIRD_PARTY_NOTICES.md` gets Steinberg's MIT notice whichever core Task 1 picks. "VST3" appears as plain text with no logo, because the MIT licence does not cover the trademark or logo.
  - **`vst3` crate 0.3.0** (coupler-rs/vst3-rs). `license = "MIT OR Apache-2.0"`. Its manifest has no `rust-version`, no build dependencies and no bindgen.
  - **Soundcraft** (github.com/storytold/soundcraft at `b6f9f15`).
    - It is MIT OR Apache-2.0, per the root `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` and the workspace `Cargo.toml`. The `soundcraft-vst3-host` crate inherits that licence through `license.workspace`.
    - The copyright line is "Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors".
    - The `NOTICE` says the ArtCraft name, wordmark and logos are trademarks outside the licence, so we use none of them.
    - The third-party material listed in `NOTICE` and `ATTRIBUTION.md` is fonts and assets, none of it in `crates/vst3-host`.
    - These were read on 2026-11-08 from the existing read-only clone at `E:/claude-tmp/research/soundcraft`.
    - We take it under MIT. Every vendored file keeps that copyright and permission notice in its header, and the notice also goes into `THIRD_PARTY_NOTICES.md`. Task 8 checks that the pinned files still match.
  - **The test plug-in** derives from the `vst3` crate's `examples/gain.rs` (MIT OR Apache-2.0) and keeps that notice.
- **Isolation.** No plug-in code ever runs in the app process. One helper runs per plug-in instance, at most 8 per document. An editor window is never owned by or parented to the Tauri window.
- **Realtime.** `PluginInsert`, `Compensation` and the ring's host side must not allocate, lock, log, read files, panic or wait on the audio thread.
  - They touch only atomics and the mapped ring, plus at most one non-blocking `SetEvent` per block if Task 2 picks events.
  - The counting-allocator pattern in `tests/audio_tone.rs` proves this in Tasks 6, 11 and 12.
- **Untrusted inputs:** plug-in bundles, everything the helper sends (frames, ring indices, samples, names, latency, class lists) and the document's plug-in fields and state assets. The caps are below. A cap is enforced before allocating or decoding.

| Input | Cap |
|---|---|
| One state asset (container) | 8 MiB raw; base64 length checked before decoding |
| Plug-in state assets per project | 64 MiB in total |
| One control frame | 12 MiB, from the length prefix, before allocating |
| Plug-in name and vendor | 64 characters, XML-safe (the `CabinetIr` name rule) |
| Classes per bundle | 64 |
| Library | 256 entries; `library.json` read up to 1 MiB |
| Consent store | 4,096 pairs; file read up to 1 MiB |
| Active plug-in slots per document | 8 |
| Plug-in latency `L` | 100 ms (4,800 frames at 48 kHz) |
| Pipeline `P` | 8,192 frames |
| Delay-line capacity | `8,192 + ceil(0.1 × rate)` frames |
| Helper memory | 4 GiB, as a Job Object process limit |
| Timeouts | load or probe 60 s; request 5 s; hang 500 ms; supervisor tick 50 ms; offline block 10 s |

- **Documents.**
  - Old `.tabplayer` projects and edit logs replay unchanged. An absent `plugin` key round-trips byte-identically.
  - `TrackSound` stays `deny_unknown_fields`, so older builds refuse a document with a plug-in (documented fail-closed).
  - The document never holds a path or file name.
  - State bytes go only to the helper. The frontend sees only asset IDs and asset tokens.
  - A document naming a plug-in that this machine lacks opens normally, plays the built-in tone, shows a notice, and is never modified by that.
- **Determinism.**
  - With no plug-ins (`D_max = 0`), rendering is bit-identical to today, and the existing render-equals-playback tests pass unchanged. Plug-in tracks stay out of those tests (spec).
  - Exports with the test plug-in are byte-identical across runs.
- **Edits.** One gesture is one `SetTrackSound`, and choosing the current value records nothing. An editor session is one edit when it closes or on "Save plug-in settings", and a state with the same hash records nothing.
- **UI.**
  - New text goes through `src/i18n` with real `en`, `et` and `de` entries. Do not copy the cabinet IR UI's hard-coded English (`src/audio/cabinet-ir.ts`).
  - A control holding focus never gets `disabled` for busy (`src/ui/useBusyGuard.ts`).
- **Platforms.**
  - The implementation is Windows-only. On macOS and Linux the helper builds as a stub that answers `unsupportedPlatform`, the app reports the same without launching anything, and CI stays green on all three.
  - End-to-end tests are `#[cfg(windows)]`.
- **Build.**
  - Cargo output goes in the default `src-tauri/target`, never a scratchpad or a per-task folder. Prefer `--lib`, `-p` or a single `--test`.
  - End-to-end tests need the helper and the test plug-in built first, with `cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin`. They fail loudly naming that command when the binaries are missing.
- **Repo rules.** Do not retune `src-tauri/src/audio/tone.rs`. Do not hand-edit `src-tauri/gen/`, `src-tauri/resources/audio/` or `.analysis/compatibility/`.
- **Spike code and vendor files.**
  - Spike code stays in `.analysis/vst-spikes/`, which is ignored. Only the results doc is committed.
  - Never commit vendor plug-in binaries, their states or their screenshots. Name the plug-ins and versions in docs instead.
- **Hot-path review.** Tasks 6, 8, 9, 11, 12, 13 and 17 end with a review by a fresh-context, read-only reviewer briefed adversarially. Those tasks cover the bridge, new dependencies, process spawning, prepare and CI. Re-review fail-closed guards until approved (spec ruling and the global rule).

## Review Focus

1. **A document from elsewhere, or a hostile helper.**
   - No plug-in code may run before consent.
   - A crafted state, ring index or frame must not crash, stall or bloat the app.
   - Tests:
     - Task 13: `foreign_state_needs_consent_before_any_helper_launch`;
     - Task 5: `state_asset_over_cap_is_refused_before_decode` and `plugin_state_total_cap`;
     - Task 6: `ring_reader_refuses_hostile_indices` and `frame_over_cap_is_refused_before_allocation`.
2. **A plug-in that crashes, hangs or outputs NaN mid-note.** There must be no click, no silence and no app stall. Tests:
   - Task 11: `underrun_ramps_last_sample_and_fades_in_built_in` and `non_finite_block_falls_back`;
   - Task 13: `hang_falls_back_and_is_killed_within_one_second`;
   - Task 15: `hung_editor_does_not_block_app`.
3. **The device's callback grows while playing**, for example on a switch to a Bluetooth headset. `P` must be recomputed, and a pipeline over the cap refused. Tests: Task 13 `callback_size_change_reprepares_with_new_pipeline`, and Task 11 `pipeline_over_cap_is_refused`.
4. **Loop wrap, count-in between loops, and the end of the score.** There must be no gap, no cut and frame-exact alignment. Task 12 tests: `loop_wrap_keeps_streaming`, `count_in_between_loops_is_delayed_and_drains` and `end_of_score_plays_out_the_compensation_delay`.
5. **Undo or redo while the editor is open, and edit-locked documents.** No stray edit is recorded, and the helper follows the document. Task 15 tests: `undo_with_editor_open_sets_state_and_records_nothing_on_close` and `edit_locked_document_reverts_on_close`.
6. **Exports match playback and are deterministic.** The trim and tail must be exact. Task 14 tests: `export_trims_latency_and_keeps_length` and `export_is_deterministic`.

---

### Task 1: Spike — Rust or C++ hosting core, with real state sizes and latency (time box 2 days)

**Files:**
- Create: `.analysis/vst-spikes/host-rust/` and `.analysis/vst-spikes/host-cpp/` (ignored, not committed); `docs/validation/YYYY-MM-DD-vst-spikes.md`, dated the day it is written.

**Interfaces:**
- Produces: the hosting core choice, which Task 8 consumes, and the measured state sizes and latencies, which Task 5 consumes.

- [ ] **Step 1: Build two throwaway hosts.**
  - **Rust:** Soundcraft's `crates/vst3-host/src/ffi` and bundle resolution at `b6f9f15`, on `vst3 = "=0.3.0"`, under the MIT terms recorded in Global Constraints.
  - **C++:** the VST3 SDK 3.8.x hosting classes (`public.sdk/source/vst/hosting`: module loading, plug-in provider, host classes, process data), built with CMake and MSVC from the installed VS 2022 Build Tools. Record the exact SDK tag.
- [ ] **Step 2: Load each plug-in in both hosts:**
  - the unmodified `gain` example of `vst3` 0.3.0;
  - at least two real amp plug-ins installed on this machine.
  If fewer than two are installed, **stop and ask the user**. Do not download plug-ins.
- [ ] **Step 3: Pass criteria, per plug-in and host.** All of these must hold:
  - it loads at 48 kHz with 128-frame blocks and a stereo main bus;
  - 10 s of a 220 Hz sine at 0.3 peak comes out finite and non-silent (RMS above −60 dBFS);
  - getting the state, setting it, and getting it again gives identical bytes (or bytes that are stable after one round trip);
  - the latency is read at load, and read again after `kLatencyChanged` when the plug-in has a setting that changes it;
  - the editor opens and closes three times without leaving a top-level window behind.
- [ ] **Step 4: Record, per plug-in:** the component and controller state sizes, the latency, the load time, the process time per block, and any problem loading dependent DLLs.
- [ ] **Step 5: Decide.**
  - If both hosts pass, use Rust: there is no CMake in CI and a smaller build.
  - If only C++ passes, use C++.
  - If neither passes, stop and ask.
  - Raise these with the user before Task 5: a real state over 8 MiB or a latency over 100 ms. A state over 1 MiB means revisiting the 64 MiB history cap.
  - Past the time box, stop and report.
- [ ] **Step 6:** Commit only the doc, with the message `docs: VST spike 1, hosting core choice (THE-71)`.

### Task 2: Spike — IPC hand-off timing at blocks of 64, 128 and 256 (time box 1 day)

**Files:**
- Create: `.analysis/vst-spikes/ipc/` (ignored); append to the spike doc.

**Interfaces:**
- Consumes: Task 1's host, and the ring layout from Task 6's Interfaces, which is prototyped here.
- Produces: `BLOCK_FRAMES`, the pipeline depth (two or three callbacks) and the wake method (events or polling), all consumed by Tasks 6 and 11.

- [ ] **Step 1:** Build an echo helper (input copied to output, no plug-in) and Task 1's host running the gain example, both on the prototype ring.
- [ ] **Step 2: Run four helpers at once** against a callback thread at 48 kHz:
  - callbacks of 512 frames, paced by the real output device if practical, otherwise by a high-resolution waitable timer;
  - block sizes 64, 128 and 256 with `P` = 2 callbacks;
  - a 10-minute run each, plus a 10-minute run at 256-frame callbacks with block 128.
  Measure the hand-off time from input publish to output publish (p50, p99, max), underruns, and CPU use in the app and the helpers. Compare `SetEvent` wake-ups with helper-side polling.
- [ ] **Step 3: Pass:** at block 128 and `P` = 2 callbacks with four helpers, zero underruns in 10 minutes and a p99 hand-off of at most one callback.
- [ ] **Step 4: Decide.**
  - If 128 fails and 256 passes, `BLOCK_FRAMES = 256`.
  - If every block size fails at `P` = 2 and passes at `P` = 3, use three callbacks.
  - Otherwise stop and ask.
  - Pick the wake method with the lower p99 at equal underruns, and record its CPU cost.
- [ ] **Step 5:** Commit with the message `docs: VST spike 2, IPC hand-off timing (THE-71)`.

### Task 3: Spike — loop-wrap continuity with delay compensation (time box half a day)

**Files:**
- Create: `.analysis/vst-spikes/wrap/` (ignored); append to the spike doc.

**Interfaces:**
- Consumes: the real `Renderer` (`renderer.rs:415`), with a stub insert that is a fixed delay of `D` frames standing in for `P + L`.
- Produces: the list of the state that `Renderer::seek_tick` (`renderer.rs:1430-1607`) resets, each marked keep or reset for a wrap. Task 12 consumes it.

- [ ] **Step 1:** Model two tracks (one with the stub insert), a backing track with an impulse every beat, and the click. Loop one bar ten times, with the between-loops count-in off and then on.
- [ ] **Step 2: Pass criteria.** All of these must hold:
  - the output equals the continuous reference (the loop's audio concatenated ten times) delayed by exactly `D_max`;
  - there is no gap at any wrap;
  - backing and track impulses are frame-aligned on every pass;
  - with the count-in on, its clicks are delayed by `D_max`, and the previous pass's last `D_max` frames play out during it.
- [ ] **Step 3:** List every piece of state `seek_tick` resets, and mark what `wrap_to_tick` must keep: the bridge, the delay lines, and the plug-in insert. If the model fails, stop: the seamless-wrap ruling goes back to the user.
- [ ] **Step 4:** Commit with the message `docs: VST spike 3, loop-wrap continuity (THE-71)`.

### Task 4: Spike — cross-process editor focus on Windows (time box 1 day)

**Files:**
- Create: `.analysis/vst-spikes/editor/` (ignored); append to the spike doc.

**Interfaces:**
- Consumes: Task 1's host, with a real plug-in's editor and a test path that blocks the helper's UI thread for 10 s.
- Produces: the focus hand-off sequence and the DPI handling, which Task 15 consumes.

- [ ] **Step 1: Pass criteria.**
  - (a) The editor window is unowned and unparented: `GetWindow(GW_OWNER)` and `GetParent` both return null.
  - (b) During a 10 s helper UI hang, TabPlayer stays responsive: a CDP round trip takes under 200 ms and the window repaints.
  - (c) After the app calls `AllowSetForegroundWindow(helper pid)`, the editor comes to the front.
  - (d) Typing into a text field in the plug-in works, and TabPlayer shortcuts (Space for play) do not fire.
  - (e) After closing, focus returns to TabPlayer. The helper calls `AllowSetForegroundWindow(parent pid)`, then the app calls `SetForegroundWindow`.
  - (f) At 150% scaling with per-monitor DPI awareness v2, the editor's client area matches the plug-in's requested size with no clipping.
- [ ] **Step 2: Decide.** A failure of (a) to (c) stops the task: ask the user. Failures of (d) to (f) are recorded as limits, naming the plug-in.
- [ ] **Step 3:** Commit with the message `docs: VST spike 4, editor focus (THE-71)`.

### Task 5: Document field, state container and asset rules

**Files:**
- Modify:
  - `src-tauri/src/settings.rs`: `TrackSound` at `:339`; add `PluginSlot` and `PluginFormat`;
  - `src-tauri/src/edit_types.rs`: `asset_id` at `:1491` also returns the plug-in state of `SetTrackSound`;
  - `src-tauri/src/project.rs`: the asset checks in `validate` (`:319-327`) and in `apply_edit_with_asset` (`:584`);
  - `src-tauri/src/lib.rs`: add `mod plugins;`;
  - `src/edit-types.ts` (`TrackSound` at `:88`) and `src/document-settings.ts` (`soundProblem` at `:111`): their key sets gain `plugin`.
- Create: `src-tauri/src/plugins/mod.rs`, `src-tauri/src/plugins/state.rs`
- Test: `src-tauri/tests/plugin_document.rs` (new); unit tests in `plugins/state.rs` and `project.rs`; `src/document-settings.test.ts`

**Interfaces:**
- Consumes: Task 1's state sizes, as a check on the caps.
- Produces:
  - `pub struct PluginSlot { pub format: PluginFormat, pub class_id: String, pub name: String, pub vendor: String, pub active: bool, pub input_db: f32, pub output_db: f32, pub state: String }`, serialized as `camelCase` with `deny_unknown_fields`.
  - `pub enum PluginFormat { Vst3 }`, serialized as `"vst3"`.
  - `TrackSound.plugin: Option<PluginSlot>`, with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
  - `PluginSlot::validate`:
    - `class_id` is exactly 32 characters of `[0-9A-F]`;
    - `name` is 1 to 64 characters and `vendor` 0 to 64, both XML-safe;
    - the trims are finite and within −12..=12;
    - `state` is 64 characters of `[0-9a-f]`.
  - In `plugins/state.rs`:
    - `pub const STATE_MAGIC: &[u8; 8] = b"TPVST3ST"`, then a `u32` LE version (1), a `u32` LE component length, the component bytes, a `u32` LE controller length, and the controller bytes, with no trailing bytes;
    - `pub fn encode_state(component: &[u8], controller: &[u8]) -> Result<Vec<u8>, StateError>`;
    - `pub fn decode_state(bytes: &[u8]) -> Result<(&[u8], &[u8]), StateError>`;
    - `pub const STATE_FILENAME = "plugin-state.tpstate"` and `STATE_MEDIA_TYPE = "application/x-tabplayer-plugin-state"`;
    - `pub const MAX_STATE_BYTES = 8 << 20` and `MAX_PROJECT_STATE_BYTES = 64 << 20`.
  - TypeScript: `export interface PluginSlot { format: 'vst3'; classId: string; name: string; vendor: string; active: boolean; inputDb: number; outputDb: number; state: string }`, and `TrackSound.plugin?: PluginSlot`.

- [ ] **Step 1: Write the failing tests.**
  - `absent_plugin_round_trips_byte_identical`: every project fixture used by `tests/project_v2.rs` loads and serializes byte-identically, and a `TrackSound` without `plugin` serializes with no `plugin` key.
  - `plugin_slot_round_trips`: a full slot goes from JSON to struct and back to equal JSON.
  - `plugin_slot_refuses_bad_fields`: each of these is refused, by deserialization or by `validate`:
    - an unknown key, or `format: "clap"`;
    - a lowercase `classId`, a 31-character one, or one with non-hex characters;
    - a 65-character name, or a name with a control character;
    - `inputDb` of 12.5, or `NaN` written as `1e999`;
    - an uppercase `state`, or a 63-character one.
  - `unknown_sound_keys_stay_refused`: a sound carrying `"pluginX": {}` is refused, which keeps older builds failing closed.
  - `set_track_sound_names_its_state_asset`: `asset_id()` returns `plugin.state`.
  - `save_keeps_plugin_state_assets`: `saved_checkpoint` (`project.rs:513`) keeps the state asset of every saved edit, including one undone after the save.
  - `plugin_edit_without_its_asset_is_refused`, with the message "Plug-in settings are missing from this project."
  - `state_asset_over_cap_is_refused_before_decode` (a lib test in `project.rs`): an asset with `STATE_MEDIA_TYPE` and a base64 length over the cap is refused, with `assets::DECODES` still 0.
  - `plugin_state_total_cap`: once the distinct state assets total 64 MiB, `apply_edit_with_asset` refuses a new one with the message key `plugin.history_full`.
  - `container_round_trip`, and `container_refuses_bad_magic_version_lengths_trailing_bytes_and_oversize`.
  - In `src/document-settings.test.ts`: `soundProblem` accepts a valid `plugin`, and rejects a malformed one or an unknown key in it.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_document`, then `--lib plugins::state`, then `--lib project`, then `npx vitest run src/document-settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Check the base64 length against `ceil(MAX_STATE_BYTES / 3) × 4` before calling `StoredAsset::bytes()`. The asset rules apply only to assets that a plug-in slot names. Backing assets are unchanged.
- [ ] **Step 4:** Run the same commands, plus the regressions `--test project_v2 --test project_history --test project_files --test protocol`. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: plug-in slot in track sounds, with state as a capped asset (THE-71)`.

### Task 6: Workspace and the plug-in protocol crate

**Files:**
- Modify: `src-tauri/Cargo.toml` (`[workspace]` with the member `plugin-protocol`; a path dependency on it), `src-tauri/Cargo.lock`
- Create: `src-tauri/plugin-protocol/Cargo.toml` (`tabplayer-plugin-protocol`, `publish = false`, dependencies `serde`, `serde_json`, `base64`), `src/lib.rs`, `src/limits.rs`, `src/ring.rs`, `src/control.rs`, `tests/no_alloc.rs`

**Interfaces:**
- Consumes: Task 2's `BLOCK_FRAMES`, pipeline depth and wake method.
- Produces:
  - `limits.rs`: `BLOCK_FRAMES`, `RING_BLOCKS = 64`, `MAX_PIPELINE_FRAMES = 8192`, `MAX_LATENCY_SECONDS = 0.1`, `MAX_FRAME_BYTES = 12 << 20`, `MAX_CLASSES = 64`, `MAX_NAME_CHARS = 64`, `PROTOCOL_VERSION = 1`, and the timeouts from Global Constraints.
  - `ring.rs`, `#[repr(C)]` and 64-byte aligned:
    - `RingHeader { magic, version, block_frames, ring_blocks, sample_rate, input_write: AtomicU64, output_write: AtomicU64, heartbeat: AtomicU64, flush_epoch: AtomicU32 }`;
    - per block, `BlockHeader { sequence: u64, epoch: u32, flags: u32, tempo: f64, sig_num: u16, sig_den: u16, project_frame: i64, project_quarters: f64 }`;
    - input and output areas of `RING_BLOCKS × BLOCK_FRAMES × [f32; 2]`;
    - `pub const RING_BYTES: usize`;
    - `pub unsafe fn HostRing::from_raw(ptr, len) -> Result<HostRing, RingError>` and `HelperRing::from_raw`, which check the length, alignment, magic and version;
    - `HostRing`: `input_block_mut(seq)`, `publish_input(seq, &BlockHeader)`, `output_ready(seq, epoch) -> bool`, `output_block(seq) -> &[[f32; 2]]`, `heartbeat()`, `begin_flush() -> u32`;
    - `HelperRing`: the mirror operations;
    - `OwnedRing::new(rate)`, heap-backed with the same layout, for tests and the in-process fake helper.
  - `control.rs`:
    - `HostMessage`:
      - `Probe { bundle }`;
      - `Load { bundle, class_id, sample_rate, mode: Mode, ring: u64, input_event: u64, output_event: u64, component: Bytes, controller: Bytes }`;
      - `SetState { component, controller }`, `GetState`;
      - `OpenEditor { title, near: Option<Rect> }`, `CloseEditor`;
      - `Shutdown`;
      - `TestSetParameter { id, value }`, behind the feature `test-hooks`.
    - `HelperMessage`:
      - `Probed { classes: Vec<ClassInfo> }`;
      - `Loaded { latency: u32, class: ClassInfo, mono: bool }`;
      - `State { component, controller }`;
      - `LatencyChanged { latency }`;
      - `EditorOpened { window: u64 }`, `EditorClosed`, `StateDirty`;
      - `Error { code: ErrorCode, detail: String }`, with `detail` at most 256 characters.
    - Every message is `deny_unknown_fields`, and `Bytes` is base64.
    - `pub fn write_frame(w, &impl Serialize)` and `pub fn read_frame<T>(r) -> Result<T, FrameError>`: a `u32` LE length, refused over `MAX_FRAME_BYTES` before allocating, then a bounded read.
    - `ClassInfo { class_id, name, vendor, version, subcategories }`, with `validate()` applying the name and class ID rules.

- [ ] **Step 1: Write the failing tests:**
  - `ring_round_trips_blocks_in_order`;
  - `output_not_ready_until_published`;
  - `ring_reader_refuses_hostile_indices`: `output_write` of `u64::MAX`, or of `seq + RING_BLOCKS + 1`, a mismatched block `sequence`, or a stale `epoch`. Each gives `output_ready == false`, with no panic and no out-of-bounds read;
  - `ring_view_refuses_short_or_bad_magic_region`;
  - `frame_over_cap_is_refused_before_allocation`: a length prefix of `MAX_FRAME_BYTES + 1` returns `FrameError::TooLarge`, and the counting allocator saw no allocation of that size;
  - `messages_refuse_unknown_fields_and_long_names`, and `class_info_refuses_bad_class_ids`;
  - in `tests/no_alloc.rs`, `host_side_never_allocates`: 100,000 frames go through `input_block_mut`, `publish_input`, `output_ready` and `output_block` against an `OwnedRing` with a fake helper thread. Allocations are counted only on the host thread, through a thread-local flag, and the count is 0.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-protocol`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `Release` stores and `Acquire` loads on the indices. Treat every index read from the helper's side as untrusted: clamp it and check the sequence before indexing.
- [ ] **Step 4:** Run the same command, then `cargo check --locked --manifest-path src-tauri/Cargo.toml --workspace` to confirm the app still builds as a workspace member. Expected: PASS.
- [ ] **Step 5:** Hot-path review of the ring and the frame codec. Commit with the message `feat: plug-in protocol crate, with ring and bounded control frames (THE-71)`.

### Task 7: Test plug-in

**Files:**
- Modify: `src-tauri/Cargo.toml` (member `test-plugin`)
- Create: `src-tauri/test-plugin/Cargo.toml` (`tabplayer-test-plugin`, `crate-type = ["cdylib", "rlib"]`, `publish = false`, `vst3 = "=0.3.0"`), `src/lib.rs`, `src/view.rs` (Windows), `README.md` (its origin and licence)

**Interfaces:**
- Produces:
  - `pub const TEST_CLASS_ID: &str`, a fixed 32-character uppercase hex ID. The plug-in is named "TabPlayer Test Gain".
  - `pub struct TestState { pub gain: f32, pub latency: u32, pub mode: TestMode, pub padding: u32, pub edits: u32 }`, with `pub fn encode_test_state(&TestState) -> Vec<u8>` and `pub fn decode_test_state(&[u8]) -> Option<TestState>`.
  - `pub enum TestMode { Normal, Crash, Hang, Nan, Slow { ms: u32 }, HangOnLoad, RejectState }`.
  - `pub fn process_block(state: &TestState, delay: &mut DelayLine, input: &[[f32; 2]], output: &mut [[f32; 2]])`.
  - Parameters: gain (0), latency (1), mode (2), edits (3).
  - Behaviour:
    - The output is the input × `gain`, delayed by exactly `latency` frames, and `getLatencySamples` reports it.
    - Changing the latency calls `restartComponent(kLatencyChanged)`.
    - The component state is `encode_test_state` plus `padding` zero bytes.
    - `RejectState` makes `setState` return `kResultFalse`.
    - `setProcessing(false)` clears the delay line.
    - The editor (Windows) is an `IPlugView` holding a child static window, 300 × 200. On `attached` it bumps `edits` through `beginEdit`, `performEdit` and `endEdit`, unless `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1`. When `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS` is set, it blocks its UI thread for that many milliseconds after `attached`.
    - When `TABPLAYER_TEST_PLUGIN_HANG_FACTORY=1`, `GetPluginFactory` blocks forever.

- [ ] **Step 1: Write the failing unit tests:**
  - `test_state_round_trips`;
  - `delay_and_gain_are_exact`: an impulse at frame 0 with latency 480 and gain 0.5 gives 0.5 at frame 480 and 0 everywhere else;
  - `padding_sets_state_size`.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-test-plugin`. Expected: FAIL.
- [ ] **Step 3: Implement** from `vst3` 0.3.0's `examples/gain.rs`. Keep its MIT notice in the file header.
- [ ] **Step 4:** Run the same command and `cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-test-plugin`. Expected: PASS.
- [ ] **Step 5:** Commit with the message `test: VST3 test plug-in with state, latency and fault modes (THE-71)`.

### Task 8: Helper executable

**Files:**
- Modify: `src-tauri/Cargo.toml` (member `plugin-host`)
- Create:
  - `src-tauri/plugin-host/Cargo.toml` (`tabplayer-plugin-host`, a bin depending on `tabplayer-plugin-protocol` and `windows-sys` 0.61; the feature `test-hooks`);
  - `src/main.rs`, `src/core.rs`, `src/audio.rs`, `src/probe.rs`, `src/editor.rs`, `src/stub.rs`;
  - for Rust: `src/vst3/` (the vendored Soundcraft FFI, with an MIT header per file and `src/vst3/NOTICE.md`);
  - for C++: `cpp/`, `build.rs` (the `cmake` crate) and `vendor/vst3sdk/` at the pinned 3.8.x tag;
  - `tests/helper.rs`.

**Interfaces:**
- Consumes: Tasks 1 and 4 (core, focus and DPI), Task 6 (ring and messages) and Task 7 (the test plug-in).
- Produces:
  - A process protocol. The first stdin frame is either `Probe` (answered with `Probed`, then the helper exits) or `Load`. Stdin EOF means exit 0.
  - `pub trait PluginCore`:
    - `probe(bundle) -> Result<Vec<ClassInfo>, CoreError>`;
    - `load(bundle, class_id, rate, mode) -> Result<Self, CoreError>`;
    - `latency()`;
    - `set_state(component, controller)` and `state()`;
    - `processor() -> Box<dyn BlockProcessor + Send>`;
    - `open_editor(title, near)` and `close_editor()`.
  - `pub trait BlockProcessor { fn reset(&mut self); fn process(&mut self, input: &[[f32; 2]], output: &mut [[f32; 2]], ctx: &BlockHeader); }`
  - Main thread: the Win32 message loop, the controller and the editor. A reader thread forwards stdin frames to it with `PostThreadMessageW`.
  - Audio thread (`audio::run`):
    - joins MMCSS "Pro Audio";
    - waits on the input event with a 100 ms timeout, or polls, per Task 2;
    - processes every published block in order;
    - on a new `flush_epoch`, calls `BlockProcessor::reset` (`setProcessing(false)`, then `true`);
    - fills `ProcessContext` from `BlockHeader` (playing, tempo, time signature, project time in samples and quarters);
    - writes the output block header, publishes `output_write` and signals the output event;
    - bumps `heartbeat` per block and per wait timeout.
  - `IComponentHandler` edits from the editor reach the processor through a preallocated, lock-free parameter queue: the multi-point queue gap the spec names.
  - `restartComponent(kLatencyChanged)` sends `LatencyChanged`. Other restart flags are answered as a latency change, so the app re-prepares.
  - DLLs load with `LoadLibraryExW(LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)`.
  - The process sets per-monitor DPI awareness v2 at start.
  - Every call into the core is wrapped in `catch_unwind`. A panic sends `Error`, then exits with code 3.
  - A state whose container would exceed `MAX_STATE_BYTES` gives `Error { code: StateTooLarge }` and is never sent.
  - Probe lists audio-effect classes only, at most 64.
  - On non-Windows, `stub.rs` answers every request with `Error { code: UnsupportedPlatform }`.

- [ ] **Step 1: Write the failing tests** in `tests/helper.rs`, `#[cfg(windows)]`. They spawn `env!("CARGO_BIN_EXE_tabplayer-plugin-host")` and build a `.vst3` bundle layout from `target/debug/tabplayer_test_plugin.dll` in a temporary folder:
  - `probe_lists_test_class`: the classes are exactly `[TEST_CLASS_ID]`, named "TabPlayer Test Gain";
  - `probe_refuses_non_bundle`;
  - `load_reports_latency`: latency 480 gives `Loaded { latency: 480 }`;
  - `realtime_blocks_come_back_gained_and_delayed`: 100 blocks of a ramp come back as the input × 0.5, delayed by exactly 480 frames;
  - `state_round_trips_through_helper`;
  - `flush_resets_processing`: after a flush, no pre-flush sample appears in the new epoch's output;
  - `heartbeat_advances_while_idle`;
  - `stdin_close_exits_helper` within 1 s;
  - `crash_mode_exits_nonzero`, and `hang_mode_stops_heartbeat` within 500 ms;
  - `oversized_state_from_plugin_is_refused`: padding of 9 MiB gives `Error { code: StateTooLarge }`, and no frame over the cap is written;
  - `offline_mode_processes_synchronously`;
  - `latency_change_is_reported`: `TestSetParameter` on parameter 1 gives `LatencyChanged`;
  - `stub_reports_unsupported_platform`, `#[cfg(not(windows))]`.
- [ ] **Step 2:** Run `cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-test-plugin`, then `cargo test --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host --features test-hooks`. Expected: FAIL.
- [ ] **Step 3: Implement**, following Task 1's chosen core. Add the gaps the spec lists: the out-of-process ring and watchdog, DPI and size constraints, the DLL search path, restart flags, parameter queues and `catch_unwind`.
- [ ] **Step 4:** Run the same commands. Expected: PASS.
- [ ] **Step 5:** Hot-path review of the new dependencies, the audio thread and the vendored FFI. Commit with the message `feat: plug-in host helper, one VST3 per process (THE-71)`.

### Task 9: Helper client and supervisor in the app

**Files:**
- Create: `src-tauri/src/plugins/status.rs`, `src-tauri/src/plugins/helper.rs` (Windows, with a non-Windows stub), `src-tauri/src/plugins/supervisor.rs`
- Modify: `src-tauri/Cargo.toml` (the `windows-sys` features for job objects, memory, threading and pipes)
- Test: `src-tauri/tests/plugin_helper.rs` (new)

**Interfaces:**
- Consumes: Task 6 (protocol) and Task 8 (helper).
- Produces:
  - `pub enum PluginStatus { Ready, Loading, Missing, Unreadable, Crashed, Hung, NeedsConsent, UnsupportedPlatform, TooMuchLatency, RejectedState, Underrun, NonFinite, TooMany, HostMissing }`, serialized as `camelCase`.
  - `pub struct HelperProcess`:
    - `launch(exe: &Path, job: &HelperJob) -> Result<Self, HelperError>`;
    - `load(LoadRequest) -> Result<Loaded, HelperError>`, with a 60 s timeout;
    - `set_state`, `get_state` and `request(...)`, with a 5 s timeout;
    - `link() -> BridgeLink`, `heartbeat() -> u64`, `exited() -> Option<i32>` and `kill()`.
    - Dropping it kills the process and closes its handles.
  - `pub struct HelperJob`: one Job Object per app, with `KILL_ON_JOB_CLOSE` and a 4 GiB per-process memory limit.
  - `pub struct BridgeLink { ring: Arc<MappedRing>, input_event: Arc<EventHandle> }`, which is `Send + Sync`.
  - `BridgeLink::in_process(OwnedRing)`, so the audio tests in Tasks 11 and 12 can run a fake helper thread without a process.
  - `pub fn probe(exe, bundle, timeout) -> Result<Vec<ClassInfo>, HelperError>`.
  - `pub struct InsertShared { pub fault: AtomicU8, pub max_callback_frames: AtomicU32 }`: the audio thread writes it and the supervisor reads it.
  - `pub struct Supervisor`, a thread with a 50 ms tick:
    - a heartbeat stale for 500 ms while blocks are pending means kill, then `Hung`;
    - a process exit means `Crashed`;
    - the `InsertShared.fault` codes become `Underrun` or `NonFinite`;
    - it reports through `Fn(HelperKey, PluginStatus)`.
  - Everything the helper sends is checked: a latency over the cap gives `TooMuchLatency`, a class ID that differs from the request gives `Unreadable`, and a frame over the cap kills the helper and gives `Unreadable`.

- [ ] **Step 1: Write the failing tests** in `tests/plugin_helper.rs`, `#[cfg(windows)]`. They use `target/debug/tabplayer-plugin-host.exe` and the test plug-in, and fail loudly naming the build command when either is missing:
  - `launch_load_and_unload`: dropping the helper leaves no process within 1 s;
  - `helper_dies_with_the_job`: the test binary runs itself as a parent (`TABPLAYER_TEST_JOB_PARENT=1`) that launches a helper and prints its process ID. After the test kills the parent, the helper is gone within 1 s;
  - `supervisor_reports_hung_within_one_second_and_kills`;
  - `supervisor_reports_crashed`;
  - `load_timeout_kills_helper`: `HangOnLoad` with a 1 s test timeout;
  - `hostile_latency_is_too_much`: latency 4,801 at 48 kHz;
  - `missing_helper_exe_is_host_missing`;
  - `launch_reports_unsupported_platform`, `#[cfg(not(windows))]`.
- [ ] **Step 2:** Build the helper and the test plug-in, then run `cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_helper`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Spawn with piped stdin and stdout and `CREATE_NO_WINDOW`.
  - Assign the helper to the job before sending its first frame.
  - Create the mapping and events, and duplicate them into the helper.
  - A reader thread decodes helper frames into a bounded channel of 16 messages.
- [ ] **Step 4:** Run the same command and `--lib plugins`. Expected: PASS.
- [ ] **Step 5:** Hot-path review of process spawning, handle duplication and the job limits. Commit with the message `feat: launch, watch and kill plug-in helpers (THE-71)`.

### Task 10: Plug-in library

**Files:**
- Create: `src-tauri/src/plugins/library.rs`, `src-tauri/src/plugins/commands.rs`, `src/audio/plugin-host.ts`
- Modify: `src-tauri/src/lib.rs` (register the commands in both `generate_handler!` lists, `:1149` and `:1251`)
- Test: unit tests in `library.rs`; `src-tauri/tests/plugin_library.rs` (Windows)

**Interfaces:**
- Consumes: Task 9's `probe`.
- Produces:
  - `pub struct LibraryEntry { class_id, name, vendor, version, bundle: PathBuf, module_len: u64, module_modified: i64 }`.
  - `PluginLibrary`:
    - `open(dir)` reads up to 1 MiB. A corrupt or oversized file reads as empty and is replaced only by the next successful add.
    - `add(picked, probe) -> Result<Vec<LibraryEntry>, LibraryError>` accepts a `.vst3` bundle folder, the inner `Contents/x86_64-win/*.vst3` module (resolved to the bundle root) or a single-file module. It canonicalizes the path, caps the library at 256 entries, replaces a re-added class, and writes atomically (temporary file, then rename).
    - `resolve(class_id) -> Resolved::{Found(entry), Changed(entry), Missing}`.
    - `remove(class_id)`.
  - The library lives in `<app_data>/plugins/library.json`. The test override `TABPLAYER_TEST_APP_DATA_DIR` follows `cabinet_ir::library_directory` (`cabinet_ir.rs:1054`).
  - Commands:
    - `plugin_library_list() -> Vec<LibraryEntry>`;
    - `plugin_library_add() -> Option<Vec<LibraryEntry>>`: the dialog is filtered to `vst3`. Under `desktop-test`, `TABPLAYER_TEST_PLUGIN_BUNDLE` replaces the dialog, like `cabinet_ir.rs:1035`;
    - `plugin_library_remove(class_id)`.
  - Matching wrappers and types in `src/audio/plugin-host.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `resolves_inner_module_to_bundle_root`;
  - `accepts_single_file_module`;
  - `refuses_non_vst3_paths`;
  - `caps_library_at_256`;
  - `corrupt_library_reads_empty_and_is_not_overwritten_on_read`;
  - `oversized_library_file_is_not_read_past_cap`;
  - `changed_module_is_reprobed`;
  - `class_missing_after_reprobe_is_missing`;
  - `failed_probe_leaves_library_unchanged`;
  - `probe_names_are_sanitised`;
  - in the Windows file, `adds_test_bundle_through_probe_helper`;
  - also in the Windows file, `probe_timeout_kills_probe_helper`, with `TABPLAYER_TEST_PLUGIN_HANG_FACTORY=1` and a 1 s test timeout.
- [ ] **Step 2:** Run `--lib plugins::library` and `--test plugin_library`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same commands. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: per-user plug-in library from chosen files (THE-71)`.

### Task 11: `PluginInsert` in `TrackDsp`

**Files:**
- Create: `src-tauri/src/audio/plugin_insert.rs`
- Modify:
  - `src-tauri/src/audio/mod.rs`;
  - `src-tauri/src/audio/dsp.rs`: on `TrackDsp` (NAM `:1673`), `new` (NAM `:1795`), `set_settings` (NAM `:1969`), `transition_from` (NAM `:2048`), `never_rest` (NAM `:2237`), `process_board` (NAM `:2304`) and `reset` (NAM `:3373`).
- Test: `src-tauri/tests/audio_plugin_insert.rs` (new, with the counting allocator copied from `tests/audio_tone.rs` and an in-process `FakeHelper` thread on `OwnedRing`)

**Interfaces:**
- Consumes: Task 6's ring, Task 9's `BridgeLink` and `InsertShared`, and Task 2's pipeline depth.
- Produces:
  - `pub enum InsertMode { Realtime { pipeline_frames: usize }, Offline { timeout: Duration } }`.
  - `pub enum FaultReason { Underrun = 1, NonFinite = 2, Disconnected = 3 }`.
  - `PluginInsert::new(link, mode, latency, input_db, output_db, rate, shared) -> Result<PluginInsert, InsertError>` allocates the input delay line and the scratch, off the audio thread. Its errors are `TooMuchLatency` and `PipelineTooLong`.
  - Methods:
    - `delay_frames() -> usize`, which is `P + L` in realtime and `BLOCK_FRAMES + L` offline;
    - `process(x, ctx, built_in: &mut dyn FnMut([f32; 2]) -> [f32; 2]) -> [f32; 2]`;
    - `flush()`, `faulted() -> Option<FaultReason>` and `same_link(&other) -> bool`.
  - `TrackDsp::attach_plugin(&mut self, insert: Box<PluginInsert>)` and `TrackDsp::plugin_delay() -> usize`.
  - The board splits at the first of Drive, Amp and Cabinet in the effective order. The stages before it feed the insert, its output feeds the stages after it, and the other two of the three are skipped in place. The `second` board never gets an insert.
  - Output:
    - `out = built_in(x delayed by D) × (1 − g) + plugin × g`;
    - the built-in chain is skipped while `g == 1`, and its three stages are reset when `g` leaves 1;
    - the input trim is applied before sending, and the output trim to the plug-in's output.
  - At every block boundary the next result block is checked whole for readiness, sequence, epoch and finite samples before any of it plays.
  - At each input block's start, the insert writes its `BlockHeader` from `ctx`: the renderer's per-frame BPM, meter, playing state and position. That is what the helper turns into `ProcessContext`.
  - `transition_from`:
    - with the same link, it moves the running insert by swapping boxes, so streaming continues;
    - with another link, it runs both inserts through the 10 ms crossfade;
    - the leaving insert drops off-thread through `Retired` (`device.rs:1664`).
  - A track with an insert never rests.

- [ ] **Step 1: Write the failing tests:**
  - `insert_output_is_plugin_output_delayed_by_d`: with the fake helper at gain 0.5 and `L` = 0, every frame after `D` plus the ramp equals 0.5 × the input `D` frames earlier, within 1e-6;
  - `delay_d_is_pipeline_plus_latency`: `L` = 480 gives `delay_frames() == P + 480`;
  - `underrun_ramps_last_sample_and_fades_in_built_in`: the fake helper stops publishing.
    - The maximum step between samples in the 10 ms after the fault stays under the threshold of the amp-change tests (`tests/audio_tone.rs:423`).
    - No 64-frame window has an RMS below 10% of the lower steady level.
    - `faulted()` stays `Underrun` after the helper resumes.
  - `non_finite_block_falls_back`: a block holding one NaN never reaches the output, and the fault is `NonFinite`;
  - `hostile_indices_never_index_out_of_bounds`;
  - `pipeline_over_cap_is_refused`, and `latency_over_cap_is_refused`;
  - `input_and_output_trims_apply`;
  - `stages_before_feed_the_plugin_and_after_follow_it`:
    - a pre-stage with a known gain scales what the fake helper receives;
    - a post-stage processes the fake helper's constant output;
  - `fallback_runs_built_in_drive_amp_cabinet_at_plugin_position`: after the ramp, the output equals a plug-in-free `TrackDsp` fed the same input delayed by `D`, within 1e-6;
  - `transition_with_same_link_keeps_streaming`, and `transition_to_other_plugin_crossfades`: no step over the threshold;
  - `insert_process_stays_off_the_heap`: 48,000 frames plus a fault plus a transition, with an allocation count of 0;
  - `block_header_carries_tempo_meter_and_position`: across a tempo change, the fake helper sees the BPM and meter of each block's first frame;
  - `second_board_has_no_insert`, and `track_with_insert_never_rests`.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_plugin_insert`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it, plus `--test audio_tone --test audio_amp --test audio_cabinet_ir --test audio_effect_order --test audio_second_pedalboard --test audio_drive --test audio_nam --test audio_render`. Expected: PASS.
- [ ] **Step 5:** Hot-path review. Commit with the message `feat: pipelined plug-in insert with 10 ms fallback to the built-in tone (THE-71)`.

### Task 12: Delay compensation, wrap, seek, count-in and end

**Files:**
- Create: `src-tauri/src/audio/compensation.rs`
- Modify:
  - `src-tauri/src/audio/renderer.rs`: `PreparedMix` (`:109`) carries `compensation: Option<Box<Compensation>>`; the track loop, backing and click in `frame` (`:1219-1297`); the stem renders (`:1403`); `install_mix` (`:1754`); add `wrap_to_tick`, `count_in_frame`, `drain_frame` and `plugin_delay_frames`;
  - `src-tauri/src/audio/device.rs`: `wrap` (`:1390`) calls `wrap_to_tick`; the count-in (`:1439-1456`) goes through `count_in_frame`; the end of the score (`:1474-1515`) drains `D_max` frames before `Ended`; `NativeAudioStatus` (`:121`) gains `plugin_delay_frames`;
  - `src-tauri/src/audio/midi_out.rs`: `MidiTap` (`:637`) gains `set_delay_frames`, added to the stamps in `stage_for` (`:827`);
  - `src-tauri/src/audio/dsp.rs`: add `reset_for_wrap`;
  - `src/audio/bridge.ts`: the status gains `pluginDelayFrames`.
- Test: `src-tauri/tests/audio_plugin_compensation.rs` (new)

**Interfaces:**
- Consumes: Task 3's keep/reset list and Task 11's `plugin_delay`.
- Produces:
  - `Compensation::new(track_delays: &[usize], capacity)`, built off-thread;
  - `d_max()`, `track(i, x)`, `backing(x)`, `click(x)`, `flush()`;
  - `transition_from(&mut old)`: copies the running lines into preallocated memory and crossfades taps over 10 ms when a delay changes;
  - `Renderer::wrap_to_tick(tick)`: everything `seek_tick` does except keeping the inserts, the bridge and the delay lines streaming;
  - `Renderer::count_in_frame(click: f32) -> [f32; 2]`: advances the bridge and the lines with silent input, and with no compensation returns `[click, click]` exactly;
  - `Renderer::drain_frame() -> [f32; 2]`;
  - `MidiTap::set_delay_frames(u64)`.

- [ ] **Step 1: Write the failing tests** (fake inserts as in Task 11):
  - `no_plugin_mix_has_no_compensation`: `PreparedMix::compensation` is `None`, and nothing allocates for it;
  - `impulse_aligns_across_tracks_backing_and_click`: track A has `D` = 1,024 + 480 and track B none. Impulses on both tracks, the backing and a click pulse at the same score time all land on the same output frame;
  - `stems_are_aligned`;
  - `midi_out_stamps_are_delayed_by_d_max`;
  - `loop_wrap_keeps_streaming`: ten wraps of a one-bar loop match Task 3's reference, delayed by `D_max`. No run of 32 or more zero frames appears where the reference has signal, and the plug-in track stays frame-aligned with a dry track on every pass;
  - `seek_flushes_lines_and_bridge`: no pre-seek sample appears after a seek (the fake helper tags epochs);
  - `count_in_between_loops_is_delayed_and_drains`;
  - `end_of_score_plays_out_the_compensation_delay`: the last note's audio is complete, and the transport reports `Ended` only after `D_max` more frames;
  - `changing_d_max_while_playing_crossfades_taps`: no step over the threshold;
  - `status_reports_plugin_delay_frames`;
  - `compensation_stays_off_the_heap`: 48,000 frames plus a wrap, a seek and a change of `D` through `install_mix`, with an allocation count of 0.
- [ ] **Step 2:** Run `--test audio_plugin_compensation`. Expected: FAIL.
- [ ] **Step 3: Implement.** The cursor stays uncompensated; that is a ruling.
- [ ] **Step 4:** Run it, plus `--test audio_render --test audio_transport --test audio_practice_transport --test audio_practice --test audio_backing --test audio_midi_out --test audio_selection_playback --test audio_tempo_sync` and `--lib export`. Expected: PASS, with the existing tests unchanged.
- [ ] **Step 5:** Hot-path review. Commit with the message `feat: plug-in delay compensation with seamless loop wraps (THE-71)`.

### Task 13: Plug-in service, prepare, consent and statuses

**Files:**
- Create: `src-tauri/src/plugins/service.rs`, `src-tauri/src/plugins/consent.rs`
- Modify:
  - `src-tauri/src/runtime.rs`: `prepare` (`:137`) calls `plugins.ensure` before the access lock, as MIDI ports are opened before it at `device.rs:2386`;
  - `src-tauri/src/audio/renderer.rs`: add `PreparedMix::prepare_with_plugins` next to `prepare` (`:127`);
  - `src-tauri/src/audio/device.rs`: publish the largest callback seen (`:1757`);
  - `src-tauri/src/workspace.rs`: a document switch shuts its helpers down;
  - `src-tauri/src/plugins/commands.rs` and `src-tauri/src/lib.rs`: the service in managed state, the commands, and the event `plugin-status`.
- Test: unit tests in `service.rs` (with a fake launcher) and `consent.rs`; `src-tauri/tests/plugin_playback.rs` (Windows, with paced 512-frame callbacks at 48 kHz); `src-tauri/tests/audio_audition.rs` and `src-tauri/tests/audio_line_in.rs` (one test each)

**Interfaces:**
- Consumes: Tasks 5 and 9 to 12.
- Produces:
  - `PluginService::new(PluginPaths { helper, library_dir, consent_file }, events: Box<dyn Fn(PluginEvent) + Send + Sync>) -> Arc<PluginService>`.
  - `ensure(document_id, &[SlotRequest { track_id, slot, state: Arc<[u8]> }]) -> Vec<(String, Result<InsertPlan, PluginStatus>)>` never waits for a launch.
  - `InsertPlan { link, latency, input_db, output_db, shared }`, and `PreparedMix::prepare_with_plugins(.., plans, callback_frames)`, which builds the inserts and the compensation off-thread.
  - `statuses(document_id) -> Vec<TrackPluginStatus { track_id, class_id, name, vendor, status }>`, plus `retry`, `grant_consent`, `default_state(class_id)` and `shutdown_document`.
  - `ConsentStore::open(path)`, `allowed(class_id, state_id)` and `grant(pairs)`: at most 4,096 pairs with the oldest dropped first, a bounded read, and atomic writes.
  - Commands:
    - `plugin_choose(document_id, track_id, class_id) -> { slot, assetToken }`: loads the default state, stages it with `workspace.stage_asset` (`:919`) and records consent;
    - `plugin_status(document_id)`;
    - `plugin_consent_grant(document_id)`;
    - `plugin_retry(document_id, track_id)`.
  - Event: `plugin-status { documentId }`, after which the frontend calls `refreshSounds()` (`NativePlaybackController.ts:237`).
  - Per slot, the checks run in order:
    1. inactive: nothing happens;
    2. not Windows: `UnsupportedPlatform`;
    3. beyond the 8th active slot in track order: `TooMany`;
    4. `library.resolve`: `Missing`, or a re-probe when the module changed;
    5. consent: `NeedsConsent`;
    6. the helper exe: `HostMissing`;
    7. launch or reuse: `Loading`, then `Ready`, `Unreadable`, `RejectedState`, `TooMuchLatency` or `Crashed`.
  - Helpers are keyed by (document, track, class ID). A changed state sends `SetState`. A larger callback or a `LatencyChanged` triggers a re-prepare. A crash relaunches at most three times per session.

- [ ] **Step 1: Write the failing tests:**
  - consent: `local_states_are_consented`, `foreign_pairs_need_consent`, `grant_covers_all_pairs_in_the_document_history`, `consent_file_is_capped_and_bounded`;
  - service, with a fake launcher:
    - `ninth_active_slot_reports_too_many`;
    - `inactive_slot_launches_nothing`;
    - `foreign_state_needs_consent_before_any_helper_launch`: the launcher is called 0 times;
    - `missing_library_entry_is_missing_and_launches_nothing`;
    - `same_slot_reuses_helper`;
    - `changed_state_sends_set_state_not_relaunch`;
    - `document_switch_shuts_helpers`;
    - `crash_relaunch_stops_after_three`;
    - `prepare_does_not_wait_for_a_launch`;
  - Windows end-to-end:
    - `plays_test_plugin_with_delay_alignment`;
    - `crash_falls_back_within_one_callback_and_reports_crashed_within_one_second`;
    - `hang_falls_back_and_is_killed_within_one_second`;
    - `rejected_state_reports_rejected_state`;
    - `too_much_latency_is_refused`;
    - `missing_bundle_reports_missing_and_document_unchanged`;
    - `callback_size_change_reprepares_with_new_pipeline`;
    - `latency_change_from_plugin_reprepares`;
  - `audition_ignores_plugin_slot`, and `line_in_ignores_plugin_slot`.
- [ ] **Step 2:** Build the helper and the test plug-in. Run `--lib plugins::service`, `--lib plugins::consent`, `--test plugin_playback`, `--test audio_audition` and `--test audio_line_in`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same commands plus `--test document_workspace --test document_workspace_protocol`. Expected: PASS.
- [ ] **Step 5:** Hot-path review of prepare ordering and consent. Commit with the message `feat: load plug-ins for playback, with consent, statuses and fallback (THE-71)`.

### Task 14: Export through offline helpers

**Files:**
- Modify:
  - `src-tauri/src/runtime.rs`: `export_audio` (`:999-1152`) opens offline sessions before `Renderer::new` and returns plug-in warnings with the result;
  - `src-tauri/src/export/audio.rs`: `AudioExportRender` (`:126-327`) trims `D_max` at the start, renders `D_max` more frames after the tail, and treats segment joins as wraps;
  - `src-tauri/src/plugins/service.rs`: add `offline_inserts`.
- Test: `src-tauri/tests/plugin_export.rs` (Windows); `--lib export` unit tests with a fake offline insert

**Interfaces:**
- Consumes: Tasks 11 to 13.
- Produces:
  - `PluginService::offline_inserts(document_id, slots, rate) -> Result<OfflinePlugins, ExportPluginError>`.
  - `OfflinePlugins { inserts: Vec<(String, Box<PluginInsert>)>, warnings: Vec<TrackPluginStatus> }`.
  - `ExportPluginError::Failed { name, status }`.
  - Each export launches fresh helpers in offline mode and shuts them down at the end.
  - A crash, hang or block timeout fails the export, naming the plug-in. A missing plug-in, or one without consent or support, exports the built-in tone with a warning.

- [ ] **Step 1: Write the failing tests:**
  - `export_trims_latency_and_keeps_length`: with the test plug-in at `L` = 480, the frame count equals the built-in export's, and an impulse lands on the same frame as on a dry track;
  - `export_flushes_tail`: the last note comes out complete;
  - `stems_are_aligned_in_export`;
  - `export_is_deterministic`: two WAV exports are byte-identical;
  - `crash_during_export_fails_naming_the_plugin`: no output file is left behind;
  - `missing_plugin_exports_built_in_with_warning`;
  - `needs_consent_exports_built_in_with_warning`: no helper is launched;
  - `segments_keep_streaming`: no gap at segment joins;
  - `export_uses_a_fresh_offline_helper`: the playback helper's state is untouched.
- [ ] **Step 2:** Run `--test plugin_export` and `--lib export`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same commands, plus `--test audio_render` and the existing export tests (`--lib export`). Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: export plug-in tracks through offline helpers (THE-71)`.

### Task 15: Editor sessions

**Files:**
- Modify: `src-tauri/plugin-host/src/editor.rs`, `src-tauri/src/plugins/service.rs`, `src-tauri/src/plugins/commands.rs`, `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/plugin_editor.rs` (Windows)

**Interfaces:**
- Consumes: Task 4's focus sequence, and Tasks 8 and 13.
- Produces:
  - Commands:
    - `plugin_editor_open(document_id, track_id, title)`;
    - `plugin_editor_save(document_id, track_id) -> Option<{ state, assetToken }>`;
    - `plugin_editor_close(document_id, track_id)`.
  - Event: `plugin-editor-closed { documentId, trackId, state: string | null, assetToken: string | null }`.
  - The app calls `AllowSetForegroundWindow(helper pid)` before `OpenEditor`.
  - The window is a top-level, unowned window placed near TabPlayer's window.
  - A save encodes the container and stages it only if its hash differs from the slot's. In an edit-locked document it stages nothing, and on close it sends `SetState` with the document's state. Past the history cap it returns the error key `plugin.history_full`.
  - A slot state change while the editor is open (undo or redo) sends `SetState`, and the plug-in's controller updates the editor.

- [ ] **Step 1: Write the failing tests:**
  - `editor_session_is_one_edit`: the view bumps `edits`; on close the event carries a state and a token, and applying it adds one undo step;
  - `unchanged_editor_session_records_nothing`: with `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1`, `state` is null;
  - `save_mid_session_then_close_is_one_edit_per_change`;
  - `edit_locked_document_reverts_on_close`: `state` is null, and the helper's `GetState` equals the document's;
  - `undo_with_editor_open_sets_state_and_records_nothing_on_close`;
  - `history_full_refuses_save`;
  - `editor_window_is_unowned`: the window handle from `EditorOpened` has no owner and no parent;
  - `hung_editor_does_not_block_app`: with `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=10000`, `plugin_status` answers within 100 ms and the heartbeat keeps advancing, so the helper is not killed.
- [ ] **Step 2:** Run `--test plugin_editor`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same command and `--test plugin_playback`. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: plug-in editor window with one edit per session (THE-71)`.

### Task 16: Sound panel, notices and i18n

**Files:**
- Create: `src/audio/PluginSlotPanel.tsx`, `src/audio/PluginNotices.tsx`, `src/audio/usePluginStatus.ts`, `src/audio/plugin-slot.test.tsx`
- Modify:
  - `src/audio/plugin-host.ts`: the remaining wrappers and the `PluginStatus` union;
  - `src/audio/SoundPanel.tsx`: the plug-in block before the effect blocks at `:41`;
  - `src/rig/BlockStage.tsx` and `src/rig/SignalChain.tsx`: Drive, Amp and Cabinet are marked as replaced;
  - `src/App.tsx`: `PluginNotices` and the consent prompt next to `CabinetNotices` (`:851`); the `plugin-status` listener calls `refreshSounds`; `plugin-editor-closed` commits;
  - `src/export/ExportDialog.tsx` (`:107`);
  - `src/audio/useSoundEditing.ts`: applying a library or factory sound keeps `plugin`;
  - `src/i18n/en.ts`, `et.ts` and `de.ts`.

**Interfaces:**
- Consumes: the commands and events of Tasks 10 and 13 to 15, and Task 5's types.
- Produces:
  - `<PluginSlotPanel trackId slot status busy onChange={(slot | undefined, assetToken?) => void}/>`;
  - `usePluginStatus(documentId)`;
  - `<PluginNotices statuses trackNames onAllow onRetry className?/>`;
  - i18n keys under `plugin.*`: a status text and a notice per status, plus the editor focus hint and `plugin.history_full`.

- [ ] **Step 1: Write the failing tests:**
  - the library list shows entries, and "Add plug-in…" calls `plugin_library_add` and refreshes the list;
  - choosing a plug-in calls `plugin_choose` and writes one `setTrackSound` with `plugin` and the asset token;
  - choosing the current plug-in records nothing;
  - "Built-in tone" removes `plugin` in one edit;
  - the active toggle and the input and output trims commit once on blur or Enter, and only when changed;
  - "Edit plug-in" calls `plugin_editor_open` with a localized title, and the hint says the plug-in window has its own focus and shortcuts;
  - `plugin-editor-closed`:
    - with a token, it writes one edit;
    - with null, it writes nothing;
    - if the track's plug-in changed meanwhile, it cancels the token and writes nothing;
  - each status shows its localized notice, naming the plug-in and saying the built-in tone plays and the document is unchanged:
    - `needsConsent` offers "Allow plug-ins", which calls `plugin_consent_grant`;
    - `crashed`, `hung`, `underrun` and `nonFinite` offer "Try again";
  - the export dialog lists plug-in warnings;
  - applying a library or factory sound keeps the track's plug-in;
  - the rig marks Drive, Amp and Cabinet as replaced;
  - busy goes through `busyGuard`, never `disabled` on a focused control;
  - "VST3" is plain text with no logo;
  - the i18n catalog test passes for the new keys in `en`, `et` and `de`.
- [ ] **Step 2:** Run `npx vitest run src/audio/plugin-slot.test.tsx src/rig src/export/ExportDialog.test.tsx src/i18n src/audio/sound-library-ui.test.tsx src/audio/factory-sounds.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same command, then `npm run typecheck` and `npx vitest run src/App.test.tsx src/audio/SoundPanel.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: plug-in slot in the sound panel, with notices in en, et and de (THE-71)`.

### Task 17: Packaging, CI, notices and docs

**Files:**
- Create: `scripts/build-plugin-host.mjs`, `scripts/build-plugin-host.test.mjs`, `src-tauri/tauri.plugin-host.conf.json`
- Modify:
  - `package.json`: `prepare:plugin-host`, and the new script test in `test`;
  - `.gitignore`: `src-tauri/binaries/`;
  - `scripts/build-desktop-test.ps1`: build the helper (with `test-hooks`) and the test plug-in in release, and copy the helper beside `.analysis/desktop-smoke/tabplayer.exe`;
  - `scripts/verify-packaged-resources.mjs` and its test: the MSI and NSIS packages contain `tabplayer-plugin-host.exe`;
  - `scripts/copy-notices.mjs`: collect the licences of every workspace member's dependencies;
  - `.github/workflows/desktop.yml`, `THIRD_PARTY_NOTICES.md` and `CLAUDE.md`.

**Interfaces:**
- Produces:
  - `node scripts/build-plugin-host.mjs [--debug]`: builds `-p tabplayer-plugin-host` and copies it to `src-tauri/binaries/tabplayer-plugin-host-<host triple>.exe`.
  - The overlay `{ "build": { "beforeBuildCommand": "npm run build && node scripts/build-plugin-host.mjs" }, "bundle": { "externalBin": ["binaries/tabplayer-plugin-host"] } }`.
  - In CI, on all three operating systems:
    1. build the helper and the test plug-in;
    2. `cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace`;
    3. `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`;
    4. on Windows only, `npm run tauri -- build --config src-tauri/tauri.plugin-host.conf.json -- --locked`;
    5. the packaged-resources check.
  - If Task 1 chose C++, the Windows job needs CMake and MSVC, which `windows-latest` provides; pin them by version in the workflow.

- [ ] **Step 1: Write the failing script tests:**
  - `build-plugin-host` names the target-triple file and refuses a missing build;
  - `verify-packaged-resources` fails a package without the helper.
- [ ] **Step 2:** Run `node --test scripts/build-plugin-host.test.mjs scripts/verify-packaged-resources.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `THIRD_PARTY_NOTICES.md` gains Steinberg's VST3 SDK MIT notice, the `vst3` crate's notice and, if Rust was chosen, Soundcraft's MIT notice with its copyright line.
  - `CLAUDE.md` gains:
    - the workspace members, and `--workspace` and `--all`;
    - `npm run prepare:plugin-host` before `npm run tauri -- dev --config src-tauri/tauri.plugin-host.conf.json` for plug-in work;
    - the end-to-end build prerequisite;
    - the fact that the desktop test build copies the helper.
- [ ] **Step 4:** Run the script tests, `npm test`, and a local Windows `npm run tauri -- build --config src-tauri/tauri.plugin-host.conf.json -- --locked` followed by the packaged check. Expected: PASS.
- [ ] **Step 5:** Hot-path review of the CI and packaging changes. Commit with the message `build: ship the plug-in host helper, with CI and notices (THE-71)`.

### Task 18: Desktop proof, acceptance script and validation doc (controller)

- [ ] **Step 1:** Add `tests/desktop/parity-vst-plugin.mjs`, based on `tests/desktop/parity-cabinet-ir.mjs`. It uses `TABPLAYER_TEST_PLUGIN_BUNDLE`, pointing at a test plug-in bundle laid out under `.analysis/desktop-smoke/plugins/`, and `TABPLAYER_TEST_APP_DATA_DIR`. It must:
  - add the plug-in and choose it on a track;
  - play, and check that the status is `ready` and `pluginDelayFrames > 0`;
  - open and close the editor, and check that exactly one undo step was added;
  - undo and redo, then save and reopen;
  - use `TestSetParameter` to set crash mode, and check the `crashed` notice, the built-in tone (the output peak stays above zero) and an unchanged document; then "Try again" gives `ready`;
  - use hang mode, and check that the UI answers a CDP evaluate within 200 ms;
  - clear the consent file and reopen, check the `needsConsent` notice, allow, and check `ready`;
  - remove the library entry and reopen, and check the `missing` notice with an unchanged document;
  - export WAV, and check that it is not silent and has the same frame count as a built-in-only export.
- [ ] **Step 2:** Add `tests/desktop/acceptance-vst-real-plugin.mjs`. It is not run in CI. It reads `TABPLAYER_ACCEPT_PLUGIN_BUNDLE` for a real amp plug-in installed locally, then loads it, plays, opens the editor, saves, reopens and exports. It prints the results for the doc.
- [ ] **Step 3:** Build with `scripts/build-desktop-test.ps1`, run both drivers from the checkout root, and keep their outputs.
- [ ] **Step 4:** Write `docs/validation/YYYY-MM-DD-vst-hosting.md` with the behaviour, the evidence (commands, outputs, spike numbers and the real plug-ins tested, by name and version) and these limits:
  - Windows x64 and VST3 only; one plug-in per track; none on the second board;
  - a file picker only, with no scanning;
  - the cursor is not compensated;
  - a plug-in that ignores `setProcessing` may bleed a pre-seek tail;
  - changing the delay while playing dips the affected tracks for up to `D`;
  - the fallback runs Drive, Amp and Cabinet together at the plug-in's position;
  - Line-In and auditions use the built-in tone;
  - plug-ins are not exported to GP files and are not kept in sound presets;
  - plug-in settings history is capped at 64 MiB per document;
  - consent is per (plug-in, state);
  - older builds refuse documents with a plug-in;
  - CI cannot test vendor plug-ins, real devices or cross-process focus.
- [ ] **Step 5:** Update `docs/backlog.md` ("Load VST plug-ins on a track") to point at the spec and this doc, keeping slices 3 to 6 open.
- [ ] **Step 6:** Run the full checks:
  - `npm test` and `npm run typecheck`;
  - the build of the helper and the test plug-in;
  - `cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace`, in the background;
  - the ignored `selected_real_100bar_fourtrack_resource_budget` test in `audio_resources`;
  - `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`.
  Commit with the message `docs: VST hosting desktop proof and validation (THE-71)`.

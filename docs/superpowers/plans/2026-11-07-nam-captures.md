# NAM amp captures Implementation Plan (THE-182)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A track's Amp stage can play a Neural Amp Modeler capture (`.nam`) chosen by the user, live and in exports, falling back to the built-in amp with a notice when the capture is missing.

**Architecture:** In-process Rust inference, ported from NAM Core (MIT), behind a bounded parser. Captures live in a per-user library keyed by content hash, exactly like cabinet IRs. The document holds only `{id, name, levelDb}`. The model is parsed and built off the audio thread inside `PreparedMix::prepare`, and per-instance state is preallocated. The Amp stage runs the capture in place of the built-in circuit, then the existing gain and tone stack.

**Tech Stack:** Rust 1.88 (edition 2024), `serde_json` (already a dependency), React 19 and TypeScript, Vitest, Tauri commands. `nam-rs` 0.4 (MIT) is a **dev-dependency only**, used as a parity oracle.

**Spec:** `docs/superpowers/specs/2026-11-07-vst-hosting-design.md` ("Decisions by the user", item 2) and Linear THE-182. Research: session scratchpad `nam-format.md` (file format, forward pass, weight order) and `nam-research.md` (code map with file:line). The facts this plan relies on are restated here.

**Branch:** `feature/nam-captures`, cut from `feature/vst-hosting` (which carries the design doc) into `.worktrees/nam-captures`.

## Rulings made before planning

- **Port rather than depend.** We write our own inference in `src-tauri/src/audio/nam/` and do not take `nam-rs` as a runtime dependency. The reasons:
  - the renderer is per-frame (`TrackDsp::process([f32;2])`, `dsp.rs:1974`), while `nam-rs` is block-oriented;
  - the audio thread must provably not allocate (counting-allocator tests);
  - untrusted files must be bounded before any allocation.
  `nam-rs` stays a dev-dependency so the tests can compare our output with it. Cost if wrong: a slower engine than `nam-rs`, fixable later behind the same `NamModel` interface.
- **Architectures:** WaveNet A1 and LSTM, which cover practically all captures in use. Every other architecture (ConvNet, Linear, A2 features such as FiLM, groups, bottleneck ≠ channels, `gating_mode` blended, a nested `head`, `condition_dsp`, Sequential and Slimmable) is refused at import as "unsupported capture type". Accepted file versions are 0.5.0 to 0.7.x, provided the config uses only A1 fields.
- **Storage follows the cabinet IR, not project assets.**
  - The library lives at `<app_data>/nam-captures/<id>.nam`, with a `<id>.json` sidecar holding the name and the model rate.
  - `id` is the first 32 lowercase hex characters of the file's SHA-256.
  - The library holds at most 256 entries.
  - The document never holds the file or a path. Another machine without the file falls back with a notice.
- **Document field:** `Amp.capture?: { id, name, levelDb }`.
  - `name` is at most 64 characters and XML-safe, with the same rule as `CabinetIr`.
  - `levelDb` runs from −12 to +12.
  - It is omitted when absent, so old projects and edit logs replay byte-identically, and older builds refuse a document that has it.
  - When `capture` is set, the amp `model` and `drive` are kept but not played. `gainDb` and the 4-band tone stack still apply after the capture.
- **Mono.** The capture runs on `(L+R)/2` and writes the same value to both channels. Pan comes after the track DSP, as today.
- **Level.** At build time, the capture's output level is calibrated the same way the built-in driven amps are (`tone.rs:351-367`):
  - run 50 ms of a 220 Hz sine at 0.1 peak through it;
  - scale it so the steady peak is `AMP_TARGET = 0.078` (`tone.rs:623`);
  - then apply `levelDb`.
  The file's `loudness` metadata is not used, because its meaning changed between trainer versions. The input is fed as is: sample voices peak near 1, which is the DI level captures are trained on.
- **Sample rate.**
  - The model rate is `sample_rate` from the file. When it is absent, or outside 8,000–192,000 Hz, the rate is 48,000.
  - If the device or export rate differs, the capture runs inside a streaming windowed-sinc resampler: device rate to model rate, then back. It uses 16 taps per side at the lower of the two rates.
  - The added latency on that track is reported in samples and recorded as a limit. It is not compensated.
  - When the rates are equal there is no resampler and no added latency.
- **Silence and rest.** After the capture comes a 5 Hz one-pole DC blocker, because the model settles to a DC offset with zero input. The stage counts as at rest only after both of these:
  - the input has been exactly zero for at least the model's receptive field plus 1 sample;
  - every DC-blocker output sample since then has been below `FLUSH = 1e-20`, and is flushed to exactly 0.
  - On waking, the state is restored from the prewarmed snapshot taken at build. That is a copy into preallocated buffers, with no allocation.
  - Rested and never-rested output must stay bit-identical. This is the existing rule (`tests/audio_tone.rs:927`).
- **Crossfades.** A NAM state is heap-backed and cannot be `Copy`d like `tone::Chain`. The amp stage therefore holds two boxed states, current and leaving, and `transition_from` moves them by pointer swap. The displaced state drops with the old `TrackDsp` off the audio thread (`dsp.rs:1807-1808` precedent).
- **Line-In, auditions and the second board** get the capture automatically through `TrackDsp::new`. The master board has no amp.

## Global Constraints

- Old `.tabplayer` projects and edit logs replay unchanged. An absent `capture` loads as none and serializes without the key, so the amp wire format stays byte-identical (`tests/audio_amp.rs:43-84`, `tests/audio_cabinet_ir.rs:317`).
- No allocation, lock, file read or panic on the audio thread. Everything that allocates happens in `NamModel::build` or `NamState::new`, off the audio thread.
- `.nam` files are untrusted. The caps are:
  - file size ≤ 8 MiB, read through a bounded reader that checks the length and then uses `take(MAX+1)`;
  - JSON depth ≤ 32;
  - ≤ 4 layer arrays, ≤ 32 layers per array;
  - `channels` and `head_size` ≤ 64;
  - `kernel_size` 1..=8, each dilation 1..=4096;
  - total ring-buffer floats ≤ 4,000,000;
  - weights ≤ 2,000,000, with the count matching the config exactly;
  - every weight finite;
  - LSTM `num_layers` ≤ 4 and `hidden_size` ≤ 64.
  Any violation refuses the file with no partial allocation beyond the parse.
- Do not retune `src-tauri/src/audio/tone.rs`. Read its constants; don't change them.
- New UI text goes through `src/i18n` with real `en`, `et` and `de` entries. Do not copy the cabinet IR UI's hard-coded English. A control holding focus never gets `disabled` for busy (`useBusyGuard`).
- One gesture is one `SetTrackSound`. Choosing the current capture or the current level records nothing.
- `THIRD_PARTY_NOTICES.md` gains NAM Core's MIT notice (Steven Atkinson), because our port derives from it.
- Cargo output goes in the default `src-tauri/target`, never a scratchpad or a per-task target. Prefer `--lib` or a single `--test`.
- The test fixtures are NAM Core's `example_models/wavenet.nam` and `lstm.nam` (MIT repository). Commit them under `src-tauri/tests/fixtures/nam/` with a `README.md` giving the source URL, the commit and the MIT licence text. Build every other test model synthetically in code.

## Review Focus

1. **A crafted `.nam` with huge dilations or weight counts.** It must be refused before allocation. Task 1 gets a test per cap, plus a test with a 1-billion dilation that must not allocate.
2. **A capture at a device rate other than the model's** (44.1 kHz device, 48 kHz model). It must sound the same as at 48 kHz, apart from small resampling error. Task 3 gets a test: a 440 Hz sine through an identity-like synthetic model at 44.1 kHz comes out at 440 Hz, within 0.1 dB of the 48 kHz level.
3. **Switching a capture during a held note.** There must be no click. Task 6 gets a test that the maximum sample-to-sample step during the 10 ms ramp stays under the threshold the existing amp-change tests use (`tests/audio_tone.rs:423`).
4. **Undo after choosing a capture, while it is playing.** The built-in amp returns smoothly, and the leaving state is freed off the audio thread. Task 6 gets a test: transition back to no capture, with the heap counter at zero.
5. **A capture file deleted while its document is open.** It keeps playing from memory until the sound is next prepared; after that it falls back with a "missing" notice, and the document stays unchanged. Task 4 (status) and Task 7 (notice) get tests.

---

### Task 1: Bounded `.nam` parser

**Files:**
- Create: `src-tauri/src/audio/nam/mod.rs`, `src-tauri/src/audio/nam/file.rs`, `src-tauri/src/audio/nam/tests.rs`
- Modify: `src-tauri/src/audio/mod.rs` (add `pub mod nam;`)
- Create: `src-tauri/tests/fixtures/nam/{wavenet.nam,lstm.nam,README.md}`

**Interfaces:**
- Produces:
  - `pub enum NamSpec { WaveNet(WaveNetSpec), Lstm(LstmSpec) }`
  - `pub struct WaveNetSpec { pub arrays: Vec<LayerArraySpec>, pub head_scale: f32 }`
  - `pub struct LayerArraySpec { input_size, condition_size, channels, head_size: usize, kernel_size: usize, dilations: Vec<usize>, gated: bool, head_bias: bool, activation: Activation }`
  - `pub enum Activation { Tanh, Hardtanh, Fasttanh, ReLU, Sigmoid }`
  - `pub struct LstmSpec { num_layers, input_size, hidden_size: usize }`
  - `pub struct NamFile { pub spec: NamSpec, pub weights: Vec<f32>, pub model_rate: u32, pub receptive_field: usize }`
  - `pub fn parse_nam(bytes: &[u8]) -> Result<NamFile, NamError>`
  - `pub enum NamError { TooLarge, NotJson, TooDeep, UnsupportedVersion(String), UnsupportedArchitecture(String), Invalid(&'static str), WeightCount { expected: usize, found: usize }, NonFinite }`
  - The caps are `pub const`s in `file.rs`, using the Global Constraints values.

- [ ] **Step 1: Fetch the fixtures.** Download `wavenet.nam` and `lstm.nam` from `https://github.com/sdatkinson/NeuralAmpModelerCore/tree/main/example_models` at a pinned commit into a new empty directory, then copy them into `src-tauri/tests/fixtures/nam/`. Write `README.md` with the URL, the commit SHA and the MIT licence text.
- [ ] **Step 2: Write the failing tests** in `nam/tests.rs`:
  - `parses_core_wavenet_fixture`: 2 arrays, sum of dilations × (k−1) per array as `receptive_field − 1`, weight count equal to the computed count.
  - `parses_core_lstm_fixture`.
  - `refuses_each_cap`: one synthetic JSON per cap (size, depth 33, 5 arrays, 33 layers, channels 65, kernel 9, dilation 4097, weights +1 and −1, `NaN` written as a string-free huge number such as `1e999`, unknown architecture `"ConvNet"`, version `"0.4.0"` and `"0.8.0"`, `gating_mode: "blended"`, `bottleneck` ≠ channels). Each returns the specific `NamError`.
  - `huge_dilation_does_not_allocate`: dilation `1000000000` is refused as `Invalid` before any buffer sizing.
  - `missing_sample_rate_means_48000`, and `sample_rate: 7000` also means 48000.
- [ ] **Step 3:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib audio::nam`. Expected: fail to compile or FAIL.
- [ ] **Step 4: Implement `parse_nam`.**
  - Check `bytes.len()` against the cap first.
  - Measure depth with a cheap byte scan of brackets outside strings before `serde_json::from_slice::<serde_json::Value>`. serde_json's own limit is 128.
  - Validate the config fields and their caps, and compute the expected weight count from the config (formula in `nam-format.md` §"WaveNet weight order" and §LSTM) **before** converting `weights` into a `Vec<f32>`.
  - The receptive field is `1 + Σ_arrays Σ_layers d·(k−1)`.
- [ ] **Step 5:** Run the same command. Expected: PASS.
- [ ] **Step 6:** Commit with the message `feat: bounded NAM capture parser (THE-182)`.

### Task 2: Inference engine

**Files:**
- Create: `src-tauri/src/audio/nam/model.rs`, `src-tauri/src/audio/nam/wavenet.rs`, `src-tauri/src/audio/nam/lstm.rs`
- Modify: `src-tauri/Cargo.toml` (dev-dependency `nam-rs = "=0.4.0"` with `--locked` lockfile update; check its MSRV is ≤ 1.88)
- Test: `src-tauri/src/audio/nam/tests.rs`, `src-tauri/tests/audio_nam.rs` (new, with the counting allocator copied from `tests/audio_tone.rs`)

**Interfaces:**
- Consumes: `NamFile` from Task 1.
- Produces:
  - `pub struct NamModel` holds immutable weights laid out per layer and is shared as `Arc<NamModel>`. It has `pub fn build(file: &NamFile) -> NamModel`, `pub fn receptive_field(&self) -> usize` and `pub fn model_rate(&self) -> u32`.
  - `pub struct NamState` holds all ring buffers and scratch, allocated once. It has `pub fn new(model: &NamModel) -> NamState`, `pub fn process(&mut self, model: &NamModel, x: f32) -> f32`, `pub fn snapshot_from(&mut self, other: &NamState)` (copy, no allocation) and `pub fn prewarm(&mut self, model: &NamModel)` (feeds `receptive_field` zeros, or 0.5 × model rate zeros for LSTM).

- [ ] **Step 1: Write the failing tests:**
  - `wavenet_matches_reference_on_fixture` and `lstm_matches_reference_on_fixture`: feed 4,096 samples of a fixed 220 Hz plus 1,370 Hz chirp at 0.3 peak through ours and through `nam-rs` loading the same fixture, both after prewarm. The maximum absolute difference must be ≤ 1e-5.
  - `synthetic_identity_wavenet`: a single-layer model whose weights make output = input × head_scale reproduces the input within 1e-6.
  - In `tests/audio_nam.rs`, `process_stays_off_the_heap`: `NamState::new` and `prewarm` outside the counted region, then 48,000 `process` calls inside it. Allocation count = 0.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib audio::nam` and `--test audio_nam`. Expected: FAIL.
- [ ] **Step 3: Implement the forward pass** exactly as `nam-format.md` §"WaveNet forward pass (A1)" describes. Store each causal dilated conv as a ring buffer of length `(k−1)·d + 1` per channel. Use f32 throughout, and write the inner products as fixed-length loops over contiguous slices so they autovectorize. LSTM gate order is i, f, g, o, and the initial h and c come from the weights.
- [ ] **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5: Add a bench**, `examples/tone_ab` subcommand `nam-bench <file>`. Release build: report µs per sample at 48 kHz for the fixture and for a synthetic standard-size A1 model (channels 16/8, head 8/1, dilations 1..512 twice). Record the numbers in the Task 8 validation doc. The target is ≤ 3 µs/sample for standard; missing it is a recorded limit, not a failure.
- [ ] **Step 6:** Commit with the message `feat: WaveNet A1 and LSTM inference for NAM captures (THE-182)`.

### Task 3: Capture stage (rate, level, DC, rest)

**Files:**
- Create: `src-tauri/src/audio/nam/stage.rs`, `src-tauri/src/audio/nam/resample.rs`
- Test: `src-tauri/src/audio/nam/tests.rs`

**Interfaces:**
- Consumes: `NamModel`, `NamState` and `tone::AMP_TARGET` (read only; make it `pub(crate)` if it isn't).
- Produces:
  - `pub struct CaptureStage` covers the resampler pair, the state, the DC blocker, the gain and the rest counter.
  - `pub fn new(model: Arc<NamModel>, device_rate: u32, level_db: f64) -> CaptureStage`. It allocates, prewarms, takes the snapshot and calibrates.
  - `pub fn process(&mut self, x: f32) -> f32`
  - `pub fn at_rest(&self) -> bool`
  - `pub fn reset(&mut self)`: restores the snapshot, with no allocation.
  - `pub fn latency_frames(&self) -> u32`: 0 when the rates match.

- [ ] **Step 1: Write the failing tests:**
  - `calibrated_to_amp_target`: the steady peak for a 220 Hz sine at 0.1 peak is 0.078 within 0.5 dB, at `level_db` 0. At +6 it is ×2 within 0.5 dB.
  - `other_device_rate_keeps_pitch_and_level`: an identity synthetic model at model rate 48,000 with device rate 44,100. A 440 Hz input comes out with its spectral peak at 440 ± 2 Hz and a level within 0.1 dB of the same run at 48,000 device rate. `latency_frames() > 0`, and it is 0 at 48,000.
  - `silent_input_rests_and_matches_never_rested`: a burst, then silence. Once `at_rest()` is true, the outputs from this point equal, bit for bit, those of a twin that was forced to keep processing. The rest point comes no earlier than receptive field + 1 samples of zeros.
  - `reset_restores_prewarmed_state`: after a burst and `reset()`, the output for a fixed input equals that of a fresh stage.
  - `dc_settles_to_zero`: with zero input after prewarm, the output is exactly 0.0 within 1 s.
- [ ] **Step 2:** Run the `--lib audio::nam` tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The resampler is a streaming polyphase windowed-sinc: 16 taps per side at the lower rate, a Kaiser window with β = 8, and phase tables precomputed in `new`. When the rates are equal it is bypassed entirely.
  - The DC blocker is a one-pole high-pass at 5 Hz at the device rate. Flush any output with `|y| < 1e-20` to 0.
  - Calibrate by running the stage on a scratch copy, so the live state keeps only its prewarmed snapshot.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: NAM capture stage with rate adaptation, calibration and rest (THE-182)`.

### Task 4: Capture library and commands

**Files:**
- Create: `src-tauri/src/audio/nam_library.rs`, `src-tauri/src/audio/nam_library/tests.rs`
- Modify: `src-tauri/src/lib.rs` (install the library at startup next to `cabinet_ir::install`, `lib.rs:1074-1084`; register the commands in **both** handler lists, `lib.rs:1210-1213` and `:1312-1315`)

**Interfaces:**
- Consumes: `parse_nam` and `NamModel::build`.
- Produces:
  - `pub struct CaptureRef { pub id: String, pub name: String, pub level_db: f64 }` lives in `dsp.rs` (Task 5); the library uses only its `id`.
  - `pub fn resolve(id: &str) -> Option<Arc<NamModel>>`. It is a cache keyed by (id, file size + mtime) holding 12 entries, and it caches failures too. Unlike `IrLibrary::kernel` (`cabinet_ir.rs:916`), it must not record a device rate globally.
  - `pub struct CaptureStatus { id, state: "ready"|"missing"|"unreadable"|"unsupported", message }`
  - Tauri commands:
    - `nam_capture_import`: native dialog, `nam` filter, `spawn_blocking`; the path never reaches JS.
    - `nam_capture_list`
    - `nam_capture_remove`
    - `nam_capture_status(ids: Vec<String>)`, with ≤ 64 ids.
    - `nam-capture-library` event on change.
  - The desktop test override is the env var `TABPLAYER_TEST_NAM_CAPTURE`, read only under the `desktop-test` feature, as `cabinet_ir.rs:1034-1050` does.

- [ ] **Step 1: Write the failing tests**, modelled on `src/audio/cabinet_ir/tests.rs`:
  - an import stores `<id>.nam` and the sidecar, and a second import of the same bytes is not rewritten;
  - a 257th entry is refused;
  - an oversized file is refused through the bounded read;
  - a hostile file is refused with its `NamError` mapped to a message;
  - `resolve` returns the same `Arc` on a cache hit;
  - a file changed on disk after import resolves to `None`, with status `unreadable`, because the hash is checked;
  - a deleted file gives status `missing`;
  - an unsupported architecture gives status `unsupported`.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib nam_library`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing `crate::files::write_bytes` and the cabinet IR's `read_bounded` pattern. Write files atomically, and resolve paths only inside the library directory, using ids validated as 32 lowercase hex.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: per-user NAM capture library and commands (THE-182)`.

### Task 5: Document field `Amp.capture` (Rust and TS)

**Files:**
- Modify: `src-tauri/src/audio/dsp.rs:39-49` (replace the `block!`-made `Amp` with a hand-written struct that keeps the exact wire format, like `Cabinet` at `:89-106`), `dsp.rs:1054-1206` (validation)
- Modify: `src/edit-types.ts:64`, `src/document-settings.ts:75-109` (rule, `laterFields`, `fits`)
- Test: `src-tauri/tests/audio_amp.rs`, `src-tauri/tests/audio_nam.rs`, `src/document-settings.test.ts`

**Interfaces:**
- Produces: `pub struct CaptureRef { id: String, name: String, level_db: f64 }` with serde `levelDb`, `deny_unknown_fields` and a `validate()` copied from `CabinetIr::validate` (`dsp.rs:63-87`). `Amp.capture: Option<CaptureRef>` uses `#[serde(default, skip_serializing_if = "Option::is_none")]`. The TS type is `AmpCapture = {id: string; name: string; levelDb: number}`.

- [ ] **Step 1: Write the failing tests:**
  - every amp JSON in `tests/audio_amp.rs:43-84` round-trips byte-identically;
  - an amp with a capture round-trips;
  - a bad id, a 65-character name and `levelDb` 12.5 are each refused, in both Rust and TS;
  - an old edit log with `SetTrackSound` replays unchanged, beside one with a capture (copy `tests/audio_cabinet_ir.rs:317`);
  - TS `soundProblem` rejects an unknown key inside `capture`.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_amp --test audio_nam` and `npx vitest run src/document-settings.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: amp capture reference in the document (THE-182)`.

### Task 6: Play the capture in the Amp stage

**Files:**
- Modify: `src-tauri/src/audio/dsp.rs`: `TrackDsp` fields (`:1444-1456`), `new` (`:1550-1600`), `set_settings` (`:1720-1779`), `transition_from` (`:1781-1915`), `driven_at_rest`/`never_rest` (`:1949-1973`), the `Stage::Amp` branch (`:2360-2479`)
- Test: `src-tauri/tests/audio_nam.rs`

**Interfaces:**
- Consumes: `nam_library::resolve`, `CaptureStage`, `Amp.capture`.
- Produces: `TrackDsp` plays the capture when `amp.enabled && amp.capture` resolves. Otherwise it plays the built-in circuit, bit-identical to a sound without `capture`.

- [ ] **Step 1: Write the failing tests:**
  - `unresolved_capture_plays_builtin_bit_identical` (copy `tests/audio_cabinet_ir.rs:253-298`);
  - `capture_plays_and_repeats_exactly`: render twice, then `reset` equals fresh;
  - `blocks_do_not_matter`: block sizes 64 and 512 give the same bits;
  - `rested_equals_never_rested`;
  - `capture_switch_is_smooth`: Review Focus 3;
  - `undo_capture_frees_off_thread`: Review Focus 4, with the counting allocator over the callback side;
  - `stays_off_the_heap`: through `transition_from`, rest and wake, and `reset`, at 44.1 and 48 kHz;
  - `second_board_capture_independent`;
  - `export_render_equals_playback`: following `src/export/audio.rs:455-474`, through `Renderer::new` at 48,000.
- [ ] **Step 2:** Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --test audio_nam`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Hold `amp_capture: [Option<Box<CaptureStage>>; 2]` (current and leaving) beside `amp_chain`.
  - Build `CaptureStage` in `new` and `set_settings` off-thread.
  - Run the capture where the circuit runs and keep `gain_db` and the tone stack after it.
  - `transition_from` swaps boxes. It never clones or allocates.
  - `driven_at_rest` includes the capture's `at_rest`.
- [ ] **Step 4:** Run the new test file plus the regression set: `--test audio_tone --test audio_amp --test audio_cabinet_ir --test audio_effect_order --test audio_render --lib export`. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: play NAM captures in the amp stage (THE-182)`.

### Task 7: Capture picker and notices

**Files:**
- Create: `src/audio/amp-capture.ts` (invoke wrappers and the status type, like `src/audio/cabinet-ir.ts`), `src/audio/AmpCapture.tsx`, `src/audio/AmpCapture.test.tsx`, `src/audio/CaptureNotices.tsx`
- Modify:
  - `src/rig/BlockStage.tsx` (`AmpStage` `:81-89`): add an `ampCapture(board)` slot `data-slot="amp-capture"`, like `cabinetResponse` at `:108`;
  - `src/rig/SoundRig.tsx`;
  - `src/audio/SoundPanel.tsx` (after the amp select, `:49`);
  - `src/App.tsx`, where the cabinet slot and notices are mounted (`:842`, `:870-878`);
  - `src/export/ExportDialog.tsx:107`;
  - `src/i18n/en.ts`, `et.ts`, `de.ts`.

**Interfaces:**
- Consumes: Task 4's commands and event, and Task 5's `AmpCapture` type.
- Produces: `<AmpCapture value={capture|undefined} busy onChange={(c|undefined)=>void}/>`, plus `useCaptureNotices(settings)`.

- [ ] **Step 1: Write the failing tests** (follow the cases in `src/audio/cabinet-ir.test.tsx`):
  - the list shows the library entries;
  - picking one writes one `setTrackSound` with `amp.capture`;
  - picking the current one records nothing;
  - "Built-in amp" removes `capture`;
  - the level trim commits on blur or Enter, only if changed;
  - import refreshes the list and writes only if the track scope is unchanged;
  - remove is available for library entries;
  - a missing or unsupported status shows the notice naming the capture and saying the built-in amp plays;
  - the export dialog shows the notice;
  - busy uses `busyGuard`;
  - the i18n catalog test passes for the new keys.
- [ ] **Step 2:** Run `npx vitest run src/audio/AmpCapture.test.tsx src/rig src/export/ExportDialog.test.tsx src/i18n`. Expected: FAIL.
- [ ] **Step 3: Implement.** The panel names the drive knob as not used while a capture plays, using the i18n key `sound.capture_drive_unused`, rather than hiding the knob.
- [ ] **Step 4:** Run the same command, then `npm run typecheck` and `npx vitest run src/App.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Commit with the message `feat: amp capture picker and notices (THE-182)`.

### Task 8: Desktop proof, notices and docs (controller)

- [ ] **Step 1:** Add `tests/desktop/parity-nam-capture.mjs`, based on `tests/desktop/parity-cabinet-ir.mjs` and using `TABPLAYER_TEST_NAM_CAPTURE` pointed at the fixture. It must:
  - import the capture and choose it on a track;
  - play, and check that the native status has no non-finite count;
  - undo and redo;
  - save and reopen;
  - delete the library file and reopen, checking the missing notice and that the document is unchanged;
  - export WAV and check it isn't silent.
- [ ] **Step 2:** Add the NAM Core MIT notice to `THIRD_PARTY_NOTICES.md`.
- [ ] **Step 3:** Write `docs/validation/2026-11-07-nam-captures.md` with the behaviour, the evidence (commands and outputs, the bench numbers from Task 2) and the limits:
  - mono only;
  - A1 WaveNet and LSTM only;
  - resampling latency not compensated;
  - no loudness metadata use;
  - no automatic cabinet bypass for full-rig captures;
  - not in GP export;
  - older builds refuse documents that use it.
- [ ] **Step 4:** Run the full checks: `npm test`, `npm run typecheck`, `cargo test --locked --manifest-path src-tauri/Cargo.toml` (in the background) and `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`.

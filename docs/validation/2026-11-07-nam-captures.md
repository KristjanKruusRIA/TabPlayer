# NAM amp captures (THE-182) - validation, 2026-11-07

Branch `feature/nam-captures`. A track's Amp stage can play a Neural Amp Modeler capture (`.nam`) that the user imported, live and in exports. This records what was built, what was measured and what is not covered.

## Behaviour

- The Sound task's Amp block has an "Amp capture" picker, "Import capture…", "Remove capture from library" and a "Capture level (dB)" trim (-12 to +12).
- Importing copies the file into `<app data>/nam-captures/<id>.nam` with a `<id>.json` sidecar. `id` is the first 32 hex characters of the file's SHA-256, so importing the same file again is the same capture. The library holds at most 256 entries and files up to 8 MB.
- The document stores only `amp.capture = { id, name, levelDb }`. It never holds the file or a path. The field is omitted when absent, so old projects and edit logs replay byte for byte, and older builds refuse a document that uses it.
- Inference is TabPlayer's own Rust port (WaveNet A1 and LSTM), run as dual mono: the left and right channels each have their own stage, so a stereo track whose channels differ runs the model twice. While both channels carry bit-identical input (a signed zero counts as zero) the right stage is not run, and the left stage's output goes to both channels. The capture is calibrated once to the same steady level as the built-in amps (`AMP_TARGET`), then `levelDb`, `gainDb` and the four-band tone stack apply after it. The amp model and drive are kept in the document but not played while a capture plays.
- When the library lacks the capture (missing, unreadable, an unsupported kind of model, too heavy to play, or a capture that reads but produces non-finite sound when its level is measured) the built-in amp plays, a notice says so, and the document is unchanged. The measuring failure has its own state, `uncalibrated`, in `nam_capture_status`; the picker names the capture and hides the drive note, as for the other states that are not ready.
- A capture is refused at import, with "This capture is too heavy to play in real time", when its estimated multiply-adds per second (per-sample multiply-adds times the model's own sample rate) are over 4 times those of the standard official A1 WaveNet at 48 kHz (`MAX_MACS_PER_SECOND` = 2,557,440,000). The caps in the parser bound memory; this one bounds time.
- Untrusted input is bounded before any allocation; the audio thread allocates nothing (counting-allocator tests). Output is checked for finiteness after every gain, including the calibration, level and amp gains: a product past the `f32` range silences the stage until the next reset, like any other non-finite output.

## Evidence

### Desktop proof

Driver `tests/desktop/parity-nam-capture.mjs`, run against a `desktop-test` build of HEAD 7aa4122 plus the driver:

```
powershell -File scripts/build-desktop-test.ps1      # exit 0, release build in 3m 41s
node tests/desktop/parity-nam-capture.mjs
```

Result line:

```
NAM capture passed: {"peakLive":0.44669222831726074,"export":{"builtin":{"rms":0.04613715995521517,"peak":0.206024169921875},"capture":{"rms":0.04619097536452777,"peak":0.291412353515625},"missing":{"rms":0.04613715995521517,"peak":0.206024169921875}},"notice":"The capture “wavenet” is not in this computer's capture library, so the built-in amp plays instead. Import the file to use it; the document is unchanged.","missingEqualsBuiltin":true}
```

Rerun after the final-review fixes (HEAD 36f4b84 plus the driver edit that now asserts `missingEqualsBuiltin`, built with `scripts/build-desktop-test.ps1`, binary copied to `.analysis/desktop-smoke`, port 9223 free): the same result line, with the same numbers to the last digit.

What it asserts, in one run of the real app over CDP, with the NAM Core fixture `wavenet.nam` supplied through `TABPLAYER_TEST_NAM_CAPTURE` in place of the file dialog:

1. The built-in amp's WAV export is not silent. The capture is imported and chosen; the document gets `{id (32 hex), name "wavenet", levelDb 0}`; the library holds exactly `<id>.nam` and `<id>.json`; no notice shows.
2. Playing reaches a finite output peak above 0.001 with no native error (0.447 here).
3. The export with the capture is not silent, every sample is finite, and the bytes differ from the built-in export (rms 0.0462, peak 0.291, against 0.0461 and 0.206 built in).
4. Undo removes the capture and the picker returns to the built-in amp; Redo restores the identical reference and the export is byte-identical to before.
5. Save writes a document that names the capture and contains no model weights. Reopening it in a fresh process names the same capture, shows no notice and exports byte-identical audio.
6. With the library folder deleted, reopening shows the missing notice quoted above, keeps the document's reference, leaves the project and the saved file unchanged, plays, and exports sound. That export is byte-identical to the built-in amp's.

Limit of this run: the audio status has no non-finite counter. The live output peak cannot see a NaN (it is a running maximum that skips NaN), so it proves only that sound reached the output. The real guard against non-finite output is the WAV writer, which refuses to write a non-finite sample and so fails the export (`export/wav.rs`); the driver also checks every exported sample. The run used one fixture (`wavenet.nam`, a small two-array WaveNet) and one machine, and did not use stereo-different channels, an LSTM, a standard-size model or a device rate other than the one the machine chose.

### Engine parity against nam-rs 0.4.0 (dev-dependency only)

4,096-sample 220 Hz plus 1,370 Hz chirp at 0.3 peak, both sides prewarmed identically:

| Model | Max abs difference | Reference peak |
|---|---|---|
| `wavenet.nam` (Core, 2 arrays) | 1.23e-7 | 0.139 |
| `lstm.nam` (Core) | 0 | 0.023 |
| `wavenet_standard.nam` (trainer) | 0 | 0.299 |
| `wavenet_minimal.nam` (trainer) | 0 | 0.299 |
| random-weight standard-size A1 (16/8, dilations 1..512 twice) | 4.8e-7 | 0.309 |
| random-weight gated Tanh, 2 arrays | 7.5e-9 | 0.023 |
| random-weight ReLU, 2 arrays | 3.7e-9 | 0.010 |
| random-weight Sigmoid | 4.5e-8 | - |
| random-weight 3-layer LSTM, hidden 8 | 0 | 0.109 |

The two trainer fixtures are identity models, so they prove plumbing, not arithmetic. Hardtanh and Fasttanh cannot be compared with nam-rs 0.4.0 (it does not support them); Hardtanh is covered by synthetic tests and Fasttanh only by a closeness-to-tanh test.

### Bench (Task 2)

the `nam-bench <file>` subcommand of `src-tauri/examples/tone_ab`; release, 48 kHz, best of 5 over 10 s of audio, engine only, one thread, shared development machine:

| Model | us/sample | Real time |
|---|---|---|
| `wavenet_standard.nam` | 2.00 (2.04 in the later run) | 10.4x |
| synthetic random-weight standard-size A1 | 2.55 | 8.2x |
| `lstm.nam` | 0.065 | 321x |
| `wavenet.nam` (tiny) | 0.143 | 146x |

The target was 3 us/sample or less for a standard model, and it is met. The figures exclude resampling and calibration, and cover one voice (one channel); a stereo track with different channels runs two stages. These are the Task 2 figures; the final-review run below repeats them.

### CPU cost budget (final-review fix)

The parser's caps bounded memory only. A 64-channel, kernel 3, 32-layer WaveNet fits every cap (about 530,000 weights) and has about 40 times the standard model's multiply-adds per sample (the review measured about 115 times its time); a 4 x 64 LSTM has about 8.6 times. `parse_nam` now estimates multiply-adds per sample (`audio/nam/cost.rs`, a pure function with unit tests: products of the convolutions, mixins, 1x1s, heads and LSTM gates; biases and activations not counted) and refuses a model whose multiply-adds per second are over 4 times the standard A1 WaveNet's at 48 kHz.

- Standard A1 (`wavenet_standard.nam`, 13,802 weights): 13,321 multiply-adds per sample, 639,408,000 per second. Budget: 2,557,440,000 per second. The constant is pinned to the estimator and the fixture by a test.
- The budget is per second of the model's own rate, so a 96 kHz standard model (2x) passes and a 384 kHz one (8x) does not.
- Admitted by tests: standard, lite, feather and nano WaveNet (the standard through the fixture and the real parser; the smaller three as the trainer's presets with channels 12/6, 8/4 and 4/2, through the parser with random weights, each costing less than the standard one), the Core LSTM fixture, and LSTMs of 1 to 3 layers of 24 units. The lite, feather and nano shapes are written from the trainer's published presets as I know them; only the standard one has a fixture here, so those three are not checked against a file. Because each is narrower than the standard model with no more layers, the margin to the budget is large whatever their exact dilations.
- Refused by tests: the 64-channel, 32-layer case (with the exact weight count, so only the budget can be the reason), 3 x 64 and 4 x 64 LSTMs. The largest LSTM the budget admits is 2 x 64 (49,472 multiply-adds per sample).
- History cap `MAX_RING_FLOATS`: 4,000,000 -> 131,072 floats. The standard A1 needs 49,104 (the others fewer), so the cap is 2.7 times the largest official need. Prewarm feeds the receptive field of zeros through the model, so its work is receptive field x multiply-adds per sample. A search over every width, kernel, gating and array count at the longest dilations the cap allows found the worst admitted WaveNet at 1.16 billion multiply-adds to prewarm (4 arrays of 4 channels, kernel 8, gated, dilation 36), about 0.17 s at the standard model's 6.8 GMAC/s, off the audio thread, once per stage. The old cap allowed about 36 billion (over 5 s). LSTM prewarm is half a second of the model rate, so its work is half the multiply-adds per second the budget allows: at most 1.28 billion.

Measured with the same bench after the change (`nam-bench`, release, 48 kHz, best of 5 over 10 s, engine only, one thread, shared development machine; the models above the first two are random-weight files made for this run and not kept):

| Model | Multiply-adds/sample | us/sample | Real time | GMAC/s |
|---|---|---|---|---|
| `wavenet_standard.nam` | 13,321 | 1.95 | 10.7x | 6.8 |
| synthetic standard-size A1 | 13,321 | 2.59 | 8.0x | 5.1 |
| largest admitted WaveNet: channels 32 then 16, head 16, dilations 1..512 twice (3.96x the standard) | 52,753 | 6.44 | 3.2x | 8.2 |
| largest admitted LSTM: 2 x 64 (3.7x the standard) | 49,472 | 12.94 | 1.6x | 3.8 |

What that means for a session, with the sample period at 48 kHz being 20.8 us. Four tracks each playing the largest admitted capture, with the two channels of each track different (dual mono, so 4 x 2 = 8 voices):

| Capture on every track | One voice | 4 tracks, channels mirrored (x4) | 4 tracks, channels different (x8) |
|---|---|---|---|
| standard A1 | 1.95 us (9%) | 7.8 us (37%) | 15.6 us (75%) |
| largest admitted WaveNet | 6.44 us (31%) | 25.8 us (124%) | 51.5 us (247%) |
| largest admitted LSTM | 12.94 us (62%) | 51.8 us (249%) | 103.5 us (497%) |

Percentages are of one sample period on one thread, engine only, excluding resampling, calibration and the rest of the chain. So the ruled budget keeps one capture playable on one track, and four tracks of standard captures fit, but four tracks of captures at the budget do not. The budget is a per-capture guard against the pathological cases (115x), not a guarantee for a full session. If a tighter bound is wanted, the factor is the single constant `BUDGET_FACTOR`; 2x would put four mirrored tracks of the largest WaveNet at about 62%. An LSTM costs about twice as much per multiply-add as a WaveNet here (3.8 against 8 GMAC/s), which the estimator does not model.

Calibration runs one second of audio through the stage when a stage is first built for a capture and rate, off the audio thread (the library status measures at the capture's own rate and the amp reuses that unless the device rate differs): about 0.3 s for the largest admitted WaveNet and 0.6 s for the largest LSTM, and 0.1 s for the standard model. The result is kept per capture and rate.

### Automated checks

Run on the worktree (Rust 1.88.0 via `RUSTUP_TOOLCHAIN`), after the desktop proof:

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: exit 0; 70 test binaries, 1,423 passed, 0 failed, 16 ignored.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: clean.
- `npm run typecheck`: clean.
- `npm test`: first run 20 failed of 5,493 (4 files named in its output, then a JSON run showed 22 failed across 5 files: `App.test.tsx`, `midi-import.test.ts`, `library/content.test.ts`, `WorkspaceApp.test.tsx`, `TrackSettingsPanel.test.tsx`). Every failure there was a 5 s test timeout under the load of the whole suite, and a different set failed in each run. Rerunning those five files together left one failure, `App.test.tsx` "Ctrl+Home pressed while an entry edit is in flight…", which passed alone with `-t`. `App.test.tsx` "turns an instrument click into one native edit…" passed alone too. So no run was fully green in one pass: this is partial evidence, the failures were load flakes and not caused by this slice (no source under `src/` changed in this task), but they were not individually diagnosed.
- `plan.test.ts` did not appear among the failures in these runs.

## Limits

- Dual mono, not a stereo model: each channel runs through its own stage, so a stereo track whose channels differ pays for the model twice (a second voice). While the channels carry the same input the second stage is not run and the left output goes to both. The plan said "mono", meaning a one-channel model; the code never mixed the channels down to `(L+R)/2`, and this document had said so wrongly. CPU doubles for differing stereo input (see the four-track table above).
- Only WaveNet A1 and LSTM are played. ConvNet, Linear, A2 features (FiLM, groups, bottleneck different from channels, blended gating, nested heads with `condition_dsp`), Sequential and Slimmable models are refused at import as an unsupported capture type. Accepted file versions are 0.5.0 to 0.7.x.
- Resampling latency is not compensated. When the capture's rate differs from the device rate, the resampler adds about 0.7 to 0.8 ms that no stage corrects, so the capture track sits that much later than the backing and other tracks, live and in export.
- The file's `loudness` metadata is not used. Level is set by measuring the model (a 220 Hz sine at 0.1 peak) and then the `levelDb` trim. A capture whose measured peak is 40 to 60 dB under target is clamped to +40 dB of make-up gain and may still play quietly.
- There is no automatic cabinet bypass for full-rig captures. A capture that already includes a cabinet is still followed by the track's cabinet if that is on; the user turns it off.
- Not in Guitar Pro export: the GP file is generated by alphaTab and carries no capture.
- Older builds refuse documents that name a capture (the new `amp.capture` field), by design.
- The LSTM runs on every silent sample: its state need not settle exactly, so there is no silence skip, and a track with an LSTM capture keeps paying for the model while it is silent. WaveNet captures rest after silence.
- The library is checked by size and modification time on a cache hit; its content hash is verified only when a file is first read. A same-size, same-timestamp edit of a library file is not noticed until the app restarts.
- An imported cabinet response is silently not applied when the dialog closes during an edit. This is a pre-existing cabinet picker gap in `App.tsx` (`cabinetResponse` with `!editBusy`), not changed here. The amp capture picker handles that case and says so in its own notice.
- The desktop proof covers one WaveNet fixture on one machine. An LSTM capture, a standard-size model, 44.1 kHz and non-48 kHz devices, and a stereo track with different channels are covered by Rust tests only, not by the real app. No listening check was done by ear.
- The calibration cache can see a duplicate insert under a race, and evicts first in, first out. This does not affect correctness as reviewed. (The copy guard now also requires the same model by `Arc`.)
- The `uncalibrated` status is measured at the capture's own rate and the amp measures at the device rate; a model that faults at one and not the other would show the wrong state. No such model is known.
- The detail of a refusal or unsupported capture (`{detail}` in the notices) is the native English message, also in the Estonian and German texts. The rest of those notices is translated.
- The cost budget is per capture. It does not bound a session: see the four-track table above.
- The cabinet picker has no busy note like the amp capture picker's (it has no busy path of its own); it is left for its own follow-up.

## Environment notes

- The worktree's `src-tauri/resources/library` was a junction to the main checkout, which `scripts/prepare-library.mjs` refuses. It is an ignored folder; it was replaced by a real folder filled by `node scripts/prepare-library.mjs` so the build could run. Nothing tracked changed.
- `.analysis/compatibility` is absent in a worktree, so tests that read those fixtures (`plan.test.ts`, some audio tests in Rust) can fail here for that reason alone. None of the runs above failed for that reason.

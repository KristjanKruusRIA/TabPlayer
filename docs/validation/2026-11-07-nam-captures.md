# NAM amp captures (THE-182) - validation, 2026-11-07

Branch `feature/nam-captures`. A track's Amp stage can play a Neural Amp Modeler capture (`.nam`) that the user imported, live and in exports. This records what was built, what was measured and what is not covered.

## Behaviour

- The Sound task's Amp block has an "Amp capture" picker, "Import capture…", "Remove capture from library" and a "Capture level (dB)" trim (-12 to +12).
- Importing copies the file into `<app data>/nam-captures/<id>.nam` with a `<id>.json` sidecar. `id` is the first 32 hex characters of the file's SHA-256, so importing the same file again is the same capture. The library holds at most 256 entries and files up to 8 MB.
- The document stores only `amp.capture = { id, name, levelDb }`. It never holds the file or a path. The field is omitted when absent, so old projects and edit logs replay byte for byte, and older builds refuse a document that uses it.
- Inference is TabPlayer's own Rust port (WaveNet A1 and LSTM), run as dual mono: the left and right channels each have their own stage, so a stereo track whose channels differ runs the model twice. While both channels carry bit-identical input (a signed zero counts as zero) the right stage is not run, and the left stage's output goes to both channels. The capture is calibrated once to the same steady level as the built-in amps (`AMP_TARGET`), then `levelDb`, `gainDb` and the four-band tone stack apply after it. The amp model and drive are kept in the document but not played while a capture plays.
- When the library lacks the capture (missing, unreadable, an unsupported kind of model, too heavy to play, or a capture that reads but produces non-finite sound when its level is measured) the built-in amp plays, a notice says so, and the document is unchanged. The measuring failure has its own state, `uncalibrated`, in `nam_capture_status`; the picker names the capture and hides the drive note, as for the other states that are not ready.
- A capture is refused at import, with "This capture is too heavy to play in real time", when its estimated multiply-adds per second (per-sample cost times the model's own sample rate) are over 2 times those of a standard-size A1 WaveNet with Tanh at 48 kHz (`MAX_COST_PER_SECOND` = 2,108,256,000). The estimate counts multiply-adds, a cost per layer, a cost per tanh or sigmoid and a cost per kernel tap on narrow layers, and weights an LSTM by 5/4; a WaveNet whose receptive field is over 0.6 s of its own rate is refused too (see the cost budget section). The caps in the parser bound memory; this one bounds time.
- Untrusted input is bounded before any allocation; the audio thread allocates nothing (counting-allocator tests). Output is checked after every gain, including the calibration, level and amp gains: a value that is not finite, or whose size is over 1e4 (`OUTPUT_CEILING`; the amps peak near 0.1), silences the stage until the next reset, like any other non-finite output. The ceiling keeps a finite but huge value from overflowing later in the tone stack or the crossfade.

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

Limit of this run: the audio status has no non-finite counter. The live output peak cannot see a NaN (it is a running maximum that skips NaN), so it proves only that sound reached the output. The real guard against non-finite output is the WAV writer, which refuses to write a non-finite sample and so fails the export (`export/wav.rs`); samples read back from a 16 or 24 bit WAV are always finite, so the driver's per-sample check only confirms that the files decode. The run used one fixture (`wavenet.nam`, a small two-array WaveNet) and one machine, and did not use stereo-different channels, an LSTM, a standard-size model or a device rate other than the one the machine chose.

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

### CPU cost budget (final-review fix, tightened three times)

The parser's caps bounded memory only. A 64-channel, kernel 3, 32-layer WaveNet fits every cap (about 530,000 weights) and has about 40 times the standard model's multiply-adds per sample (the review measured about 115 times its time); a 4 x 64 LSTM has about 8.6 times. `parse_nam` therefore estimates a cost per sample from the architecture (`audio/nam/cost.rs`, pure functions with unit tests) and refuses a model whose cost per second is over 2 times that of a standard-size A1 WaveNet with Tanh at 48 kHz. It also refuses a WaveNet whose receptive field is longer than 0.6 s of its own rate.

The budget went through four versions, each after a measurement showed the last too loose:

1. 4 times the standard model's multiply-adds, alike for WaveNet and LSTM. The largest admitted models took 31% (WaveNet) and 62% (LSTM) of a sample period.
2. 2 times, with LSTM multiply-adds weighted by 2.1. A re-review then ran a 128-layer, 6-channel gated Tanh model with fewer multiply-adds than the standard one that takes 10.1 us per sample, about four times as long: per-layer overhead and the cost of tanh and sigmoid were missing.
3. Those two terms added (110 per layer, 26 per tanh or sigmoid), LSTM gates counted. Measuring the models that version admitted found narrow, deep models with a kernel above 1 at twice their estimate: 4 x 32 layers of 6 channels, kernel 5, ReLU took 12.9 us for 42,725 units.
4. The present estimator, in multiply-add units:
   - multiply-adds as before (convolutions, mixins, 1x1s, heads, LSTM gate products; biases not counted);
   - plus 120 per layer (`LAYER_COST`; 110 fitted to the reviewer's runs, raised to 120 so that 4 x 32 layers of 10 channels, kernel 1, ReLU, measured at 6.8 us, is estimated at 91% of its time instead of 88%);
   - plus 26 per tanh or sigmoid evaluation (`NONLINEAR_COST`): an ungated layer with Tanh, Sigmoid or Fasttanh has one per channel, a gated layer has one more (the gate), ReLU and Hardtanh have none. Fasttanh is counted like Tanh because it was not measured;
   - plus 26 per kernel tap beyond the first, per layer and convolution output channel (a gated layer has twice the channels), on layers narrower than 8 channels (`TAP_COST`, `NARROW_CHANNELS`). Each tap is its own small matrix-vector product; below the width of a SIMD register the call costs far more than its multiply-adds. The standard model's 16 and 8 channel layers are untouched, so the reference does not move because of this term. The rule is a threshold at 8 channels, and it is not right above it: output widths that are not a multiple of 8 also run slower than estimated (see the limit on widths below), which the final re-review measured;
   - for an LSTM, five evaluations per unit and layer (three sigmoids, two tanh), and the sum weighted by 5/4 (`LSTM_COST_NUM / LSTM_COST_DEN`).

   `TAP_COST` was fitted to the narrow runs with a kernel above 1, taking the smallest value that puts every one at 90% or more of its measured time at 0.145 ns per unit: 24.6 for 6 channels, kernel 3, 128 layers (11.5 us); 12.2 for 6 channels, kernel 5 (12.9 us); 19.5 for 4 channels, kernel 3, 64 layers; 19.4 for 7 channels, kernel 4, 64 layers; 12.8 for 3 channels, kernel 7; 8.2 for 2 channels, kernel 5, gated; 4 for 3 channels, kernel 3, gated. 26 leaves the 6 channel, kernel 3 run at 92%. It over-estimates the others, by up to 65%. A first form that charged every layer, wide ones too, was tried and dropped: it was fitted to the same two runs, raised the reference by a third and so loosened the budget for everything.

   The reference is a standard-size A1 with Tanh: 13,321 multiply-adds + 20 x 120 + 240 x 26 = 21,961 units. (The trainer fixture `wavenet_standard.nam` is a ReLU model and costs 15,721; the constant is pinned to the Tanh shape by a test.) Budget: 43,922 units per sample at 48 kHz, 2,108,256,000 per second (`MAX_COST_PER_SECOND`).

**The estimator is a model fitted on one machine, not a law.** It is a release build, one thread, on a shared development machine. The 0.145 ns per unit that every comparison uses is the figure the terms were fitted at; the standard model itself runs at 0.115 ns per unit, so the budget is up to about 3.6 times the standard model's time (the slowest admitted shape found, below), not 2.

The LSTM weight was re-checked with the gate cost included. Measured on LSTMs of 1 x 24 to 2 x 46, time per estimated unit at weight 1.1 ran 0.115 to 0.156 ns (the 2 x 46 the worst), against the fit of 0.145. At 5/4 the largest admitted, 2 x 44 and 3 x 33, come to 0.14 and 0.13, and every measured LSTM is estimated at or above its time (a test checks the measured times against the estimates).

Tests (written before the term, and seen to fail first): the reviewer's table below, with multiply-adds, estimated cost and admission per row; the estimate is at least 90% of the measured time at 0.145 ns per unit for every measured model (the reviewer's eight and twelve further models, 20 in all, plus six LSTMs); 6 x 128 gated Tanh and 4 x 32 layers of 6 channels, kernel 5, ReLU (123,877 units) refused through the parser with exact weights, 3 x 128 gated Tanh admitted; the tap term applies below 8 channels and not at 8 or 12; standard, lite, feather and nano with Tanh admitted (96 kHz standard exactly at the budget); the Core LSTM fixture and 1 to 3 x 24 admitted; the largest LSTMs and WaveNets by estimated cost pinned with each neighbour refused; the 64-channel, 32-layer case refused with an exact weight count. The lite, feather and nano shapes are written from the trainer's published presets as I know them; only the standard one has a fixture here. The standard LSTM's size is not known to me: 1 x 24 uses 16% of the budget and 3 x 24 uses 60%.

| Reviewer's run | Multiply-adds | Estimated cost | Measured us | Admitted |
|---|---|---|---|---|
| standard ReLU | 13,321 | 15,721 | 1.93 | yes |
| standard Tanh | 13,321 | 21,961 | 2.58 | yes |
| 6 x 128 gated Tanh | 15,589 | 70,885 | 10.13 | no |
| 8 x 124 gated Tanh | 26,193 | 92,657 | 9.15 | no |
| 8 x 124 gated Sigmoid | 26,193 | 92,657 | 8.10 | no |
| 5 x 128 gated Tanh | 11,041 | 59,681 | 7.12 | no |
| 3 x 128 gated Tanh | 4,285 | 39,613 | 5.59 | yes |
| 1 x 128 ReLU | 393 | 15,753 | 2.11 | yes |

(N x 128 means four arrays of N channels, kernel 1, with 32 layers per array, 128 in all.)

**History cap and prewarm.** `MAX_RING_FLOATS` went from 4,000,000 to 131,072 floats: the standard A1 needs 49,104 (the others fewer), so the cap is 2.7 times the largest official need. It bounds memory, not time. Prewarm feeds the receptive field of zeros through the model, so its work is receptive field x cost per sample, and the cost terms alone did not bound it: a thin model with a long field (1 channel, kernel 8, dilation 146, 130,817 samples) prewarmed for about 0.44 s of estimated time. The new cap is on the receptive field itself: **0.6 s of the model's own rate** (`MAX_FIELD_NUM / MAX_FIELD_DEN` = 3/5, `max_receptive_field`: 28,800 samples at 48 kHz, 4,800 at 8 kHz), refused with the same "too heavy" message. It is in seconds, not samples, so that it holds at every model rate: the budget is per second, so prewarm work is at most 0.6 x 2,108,256,000 = 1.26 billion units, about 0.18 s at 0.145 ns per unit, at any rate. Every official preset has a field of 4,093 samples (0.085 to 0.09 s at 44.1 and 48 kHz), so the cap is seven times what they need. An LSTM prewarms for half a second of its rate, which is at most 1.05 billion units. A search over every width, kernel, gating and array count at the longest dilations both caps allow found the worst admitted WaveNet at 1.24 billion units (4 arrays of 32 layers, 1 channel, kernel 8, Tanh, dilation 32, field 28,673), and the prewarm of that model, timed in the bench, is 176 ms; the worst LSTM, 2 x 44, is 144 ms. Both are under the 0.25 s asked for.

**Largest admitted by estimated cost, measured** with `nam-bench` (release, 48 kHz, best of 5 over 10 s, engine only, one thread, shared development machine; run alone, as two runs overlapping other builds were not used; the files other than the first are random-weight files made for this run and not kept). All are Tanh unless stated:

| Model | Multiply-adds | Estimated cost | us/sample |
|---|---|---|---|
| standard A1 (synthetic weights) | 13,321 | 21,961 | 2.51 |
| largest A1 by estimated cost: channels 25 then 12, head 12, dilations 1..512 twice | 31,768 | 43,788 | 5.46 |
| largest thin model by estimated cost: 4 x 32 layers, 1 channel, kernel 4, gated | 1,417 | 43,401 | 4.29 |
| thin, most expensive in time among those admitted: 4 x 32 layers, 10 channels, kernel 1, ReLU | 27,501 | 42,861 | 6.8 |
| thin, kernel above 1: 4 x 32 layers, 5 channels, kernel 2, ReLU | 10,401 | 42,401 | 6.5 |
| largest LSTM by estimated cost: 2 x 44 | 23,452 | 43,615 | 6.09 |
| LSTM 3 x 33 | 21,945 | 43,518 | 5.62 |
| (refused now) 4 x 32 layers, 6 channels, kernel 5, ReLU | 28,645 | 123,877 | 12.9 |
| (refused now) 4 x 32 layers, 3 channels, kernel 3, gated | 8,893 | 84,157 | 7.4 |

The slowest admitted model found is not in this table: the final re-review measured ungated ReLU models at the most layers the budget allows, and the slowest was 12 channels, kernel 8, 30 layers at 9.09 us, about 3.6 times the standard model's 2.51 us (the 10 channel, kernel 1 model above is the slowest of those I timed, at 6.8 us). Their table is under the limits.

What that means for a session, with the sample period at 48 kHz being 20.8 us. Four tracks each playing the same capture, with the two channels of each track mirrored (4 voices) or different (dual mono, 8 voices):

| Capture on every track | One voice | 4 tracks, channels mirrored (x4) | 4 tracks, channels different (x8) |
|---|---|---|---|
| standard A1 with Tanh | 2.51 us (12%) | 10.0 us (48%) | 20.1 us (96%) |
| largest A1 by estimated cost | 5.46 us (26%) | 21.8 us (105%) | 43.7 us (210%) |
| largest thin model (1 channel, kernel 4, gated) | 4.29 us (21%) | 17.2 us (82%) | 34.3 us (165%) |
| slowest admitted model found by the re-review (12 channels, kernel 8, 30 layers, ReLU) | 9.1 us (44%) | 36.4 us (175%) | 72.8 us (350%) |
| largest LSTM by estimated cost (2 x 44) | 6.09 us (29%) | 24.4 us (117%) | 48.7 us (234%) |

Percentages are of one sample period on one thread, engine only, excluding resampling, calibration and the rest of the chain. The standard model with Tanh itself uses 96% of a thread for four tracks with differing stereo channels. Four tracks of captures at the budget do not fit, mirrored or not, and the budget does not try to make them: it guards each capture, and captures on several tracks together are not budgeted.

Calibration runs one second of audio through the stage when a stage is first built for a capture and rate, off the audio thread (the library status measures at the capture's own rate and the amp reuses that unless the device rate differs): about 0.12 s for the standard model, 0.26 s for the largest A1, 0.29 s for the largest LSTM and about 0.45 s for the slowest admitted model (9.1 us). The result is kept per capture and rate.

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
- The cost budget is per capture. Captures on several tracks together are not budgeted: even the standard model with Tanh takes 96% of a thread for four tracks with differing stereo channels, and larger admitted captures take more (see the four-track table), and the estimator ignores resampling and the rest of the chain.
- The cost estimator is a model fitted on one machine (release build, one thread, 0.145 ns per unit); another CPU will scale it, and it is not a law. It is conservative on most shapes and tight or low on others: a 4 x 32 layer, 10 channel, kernel 1 ReLU model is estimated at 91% of its time (the tests require 90% of every model I measured). Fasttanh is counted like Tanh without a measurement. The estimator was closed after the last round on the ruling that anything left goes here.
- Output widths that are not a multiple of 8 run slower than estimated, above the narrow-layer threshold as well as below it: `matvec_acc` handles the remainder of each output row one value at a time, and the tap term is charged only below 8 channels. The final re-review measured these admitted models, ungated ReLU at 48 kHz, each at the most layers the budget allows, with the estimate as a share of the measured time:

  | Model | Budget used | us per sample | Estimate / measured |
  |---|---|---|---|
  | 12 channels, kernel 8, 30 layers | 98% | 9.09 | 68% |
  | 15 channels, kernel 8, 20 layers | 98% | 9.12 | 69% |
  | 13 channels, kernel 8, 26 layers | 98% | 8.87 | 70% |
  | 12 channels, kernel 5, 43 layers | 98% | 8.89 | 70% |
  | 11 channels, kernel 2, 87 layers | 99% | 7.90 | 80% |
  | 9 channels, kernel 8, 50 layers | 98% | 7.47 | 84% |
  | 8 channels, kernel 8, 62 layers | 100% | 7.06 | 90% |

  The slowest, about 9.1 us, is about 3.6 times the standard model's 2.51 us and takes 175% of a sample period for four tracks with mirrored channels and 350% with differing ones. My own timings at 8, 9, 10 and 26 channels did not show this because they used few layers or small kernels; the 12 and 16 channel kernel-3 models I tried were refused by the budget before they could be timed.
- The cabinet picker has no busy note like the amp capture picker's (it has no busy path of its own); it is left for its own follow-up.

## Follow-ups

- Charge the tap cost on the convolution's output width modulo 8 instead of only below 8 channels (for example per tap, layer and remainder value), and re-fit against the table in the limits. Possible future fix; the estimator is unchanged here.
- A cap on the total number of layers or taps, if a bound on time that does not depend on the fit is wanted.
- The cabinet picker's busy note.

## Environment notes

- The worktree's `src-tauri/resources/library` was a junction to the main checkout, which `scripts/prepare-library.mjs` refuses. It is an ignored folder; it was replaced by a real folder filled by `node scripts/prepare-library.mjs` so the build could run. Nothing tracked changed.
- `.analysis/compatibility` is absent in a worktree, so tests that read those fixtures (`plan.test.ts`, some audio tests in Rust) can fail here for that reason alone. None of the runs above failed for that reason.


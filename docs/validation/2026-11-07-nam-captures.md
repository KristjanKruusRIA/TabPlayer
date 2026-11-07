# NAM amp captures (THE-182) - validation, 2026-11-07

Branch `feature/nam-captures`. A track's Amp stage can play a Neural Amp Modeler capture (`.nam`) that the user imported, live and in exports. This records what was built, what was measured and what is not covered.

## Behaviour

- The Sound task's Amp block has an "Amp capture" picker, "Import capture…", "Remove capture from library" and a "Capture level (dB)" trim (-12 to +12).
- Importing copies the file into `<app data>/nam-captures/<id>.nam` with a `<id>.json` sidecar. `id` is the first 32 hex characters of the file's SHA-256, so importing the same file again is the same capture. The library holds at most 256 entries and files up to 8 MB.
- The document stores only `amp.capture = { id, name, levelDb }`. It never holds the file or a path. The field is omitted when absent, so old projects and edit logs replay byte for byte, and older builds refuse a document that uses it.
- Inference is TabPlayer's own Rust port (WaveNet A1 and LSTM), run on the mono mix `(L+R)/2` and written to both channels. The capture is calibrated once to the same steady level as the built-in amps (`AMP_TARGET`), then `levelDb`, `gainDb` and the four-band tone stack apply after it. The amp model and drive are kept in the document but not played while a capture plays.
- When the library lacks the capture (missing, unreadable or an unsupported kind of model) the built-in amp plays, a notice says so, and the document is unchanged.
- Untrusted input is bounded before any allocation; the audio thread allocates nothing (counting-allocator tests).

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

What it asserts, in one run of the real app over CDP, with the NAM Core fixture `wavenet.nam` supplied through `TABPLAYER_TEST_NAM_CAPTURE` in place of the file dialog:

1. The built-in amp's WAV export is not silent. The capture is imported and chosen; the document gets `{id (32 hex), name "wavenet", levelDb 0}`; the library holds exactly `<id>.nam` and `<id>.json`; no notice shows.
2. Playing reaches a finite output peak above 0.001 with no native error (0.447 here).
3. The export with the capture is not silent, every sample is finite, and the bytes differ from the built-in export (rms 0.0462, peak 0.291, against 0.0461 and 0.206 built in).
4. Undo removes the capture and the picker returns to the built-in amp; Redo restores the identical reference and the export is byte-identical to before.
5. Save writes a document that names the capture and contains no model weights. Reopening it in a fresh process names the same capture, shows no notice and exports byte-identical audio.
6. With the library folder deleted, reopening shows the missing notice quoted above, keeps the document's reference, leaves the project and the saved file unchanged, plays, and exports sound. That export is byte-identical to the built-in amp's.

Limit of this run: the audio status has no non-finite counter, so "no non-finite" is shown by no native error, a finite live output peak and finite samples in every exported file. The run used one fixture (`wavenet.nam`, a small two-array WaveNet) and one machine, and did not use stereo-different channels, an LSTM, a standard-size model or a device rate other than the one the machine chose.

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

The target was 3 us/sample or less for a standard model, and it is met. The figures exclude resampling and calibration, and cover one voice (one channel); a stereo track with different channels runs two stages. These are not re-measured in this task.

### Automated checks

Run on the worktree (Rust 1.88.0 via `RUSTUP_TOOLCHAIN`), after the desktop proof:

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: exit 0; 70 test binaries, 1,423 passed, 0 failed, 16 ignored.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: clean.
- `npm run typecheck`: clean.
- `npm test`: first run 20 failed of 5,493 (4 files named in its output, then a JSON run showed 22 failed across 5 files: `App.test.tsx`, `midi-import.test.ts`, `library/content.test.ts`, `WorkspaceApp.test.tsx`, `TrackSettingsPanel.test.tsx`). Every failure there was a 5 s test timeout under the load of the whole suite, and a different set failed in each run. Rerunning those five files together left one failure, `App.test.tsx` "Ctrl+Home pressed while an entry edit is in flight…", which passed alone with `-t`. `App.test.tsx` "turns an instrument click into one native edit…" passed alone too. So no run was fully green in one pass: this is partial evidence, the failures were load flakes and not caused by this slice (no source under `src/` changed in this task), but they were not individually diagnosed.
- `plan.test.ts` did not appear among the failures in these runs.

## Limits

- Mono only: the capture runs on `(L+R)/2` and the output is the same on both channels. A stereo track whose channels differ runs a second stage, but the capture itself never sees stereo input.
- Only WaveNet A1 and LSTM are played. ConvNet, Linear, A2 features (FiLM, groups, bottleneck different from channels, blended gating, nested heads with `condition_dsp`), Sequential and Slimmable models are refused at import as an unsupported capture type. Accepted file versions are 0.5.0 to 0.7.x.
- Resampling latency is not compensated. When the capture's rate differs from the device rate, the resampler adds about 0.7 to 0.8 ms that no stage corrects, so the capture track sits that much later than the backing and other tracks, live and in export.
- The file's `loudness` metadata is not used. Level is set by measuring the model (a 220 Hz sine at 0.1 peak) and then the `levelDb` trim. A capture whose measured peak is 40 to 60 dB under target is clamped to +40 dB of make-up gain and may still play quietly.
- There is no automatic cabinet bypass for full-rig captures. A capture that already includes a cabinet is still followed by the track's cabinet if that is on; the user turns it off.
- Not in Guitar Pro export: the GP file is generated by alphaTab and carries no capture.
- Older builds refuse documents that name a capture (the new `amp.capture` field), by design.
- The LSTM model never rests: there is no silence skip, so a track with an LSTM capture keeps running the model even when silent, and stays out of the renderer's rest path. WaveNet captures do rest.
- The library is checked by size and modification time on a cache hit; its content hash is verified only when a file is first read. A same-size, same-timestamp edit of a library file is not noticed until the app restarts.
- An imported cabinet response is silently not applied when the dialog closes during an edit. This is a pre-existing cabinet picker gap in `App.tsx` (`cabinetResponse` with `!editBusy`), not changed here. The amp capture picker handles that case and says so in its own notice.
- The desktop proof covers one WaveNet fixture on one machine. An LSTM capture, a standard-size model, 44.1 kHz and non-48 kHz devices, and a stereo track with different channels are covered by Rust tests only, not by the real app. No listening check was done by ear.
- The calibration cache and the leaving-stage handling carry two minor items parked by review: the copy guard does not also require the same model by `Arc`, and the calibration cache can see a duplicate insert under a race, with first-in-first-out eviction. Neither affects correctness as reviewed.

## Environment notes

- The worktree's `src-tauri/resources/library` was a junction to the main checkout, which `scripts/prepare-library.mjs` refuses. It is an ignored folder; it was replaced by a real folder filled by `node scripts/prepare-library.mjs` so the build could run. Nothing tracked changed.
- `.analysis/compatibility` is absent in the worktree, so the fixture-dependent tests listed below fail here for that reason alone.

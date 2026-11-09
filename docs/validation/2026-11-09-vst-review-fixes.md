# VST3 plug-in hosting (THE-71): review fixes, 2026-11-09

Branch `feature/vst-hosting`. A review of the first version (Tasks 12 to 18) found problems in the plug-in service, the delay compensation, export, the UI, the build and the validation doc. Three fix branches answered it (`fix/vst-a`, `fix/vst-b`, `fix/vst-c`) and were merged into `feature/vst-hosting`. An integration pass then did the work each branch could not do inside its own files. This document says what changed, what the tests show and what is still not known.

All runs were on Windows. Unless a line says otherwise, nothing here was checked in the running app.

## What changed

### Plug-in service and editor (`fix/vst-a`)

- **Helpers run at the device's sample rate.** A helper started at another rate is shut down and started again at the new one, and that is not counted as a crash. Before a stream is open, nothing starts. A rate mismatch inside the mix is now an error, not a `debug_assert` that could panic while the audio service holds its lock.
- **The mix is built again when it needs to be:** when the device's largest callback grows past the pipeline the mix was sized for, when the device rate changes, when a helper becomes ready or faults, and when a plug-in announces a new latency. An unchanged latency does nothing. A thread checks for this every 100 ms.
- **Helpers that are no longer wanted are shut down**: a deactivated slot, a removed track, or another plug-in chosen on the track. They get a graceful shutdown and are kept until the process has ended, instead of being killed at once.
- **An insert the mix would refuse is reported** before the mix is built: too much latency shows as `tooMuchLatency`, and a pipeline over the cap shows as `underrun`.
- **A plug-in that does not take new settings in time** (a `SetState` that times out or stays `Busy`) keeps playing the settings it had. The user is told once (`plugin.busy`), and the same state is sent again only after a back-off of 1 s, doubling to 30 s. The policy is recorded in the design spec, under "Fallback and notices".
- **A newer state is never lost or undone.** A state that arrives while another is being sent is kept and sent after it. A mix lock makes an undo during a re-prepare win over the re-prepare.
- **Consent** is read and written under one lock, with a unique temporary file per write. A damaged or unreadable consent file asks for consent again, instead of panicking, and the damaged file is kept aside.
- **Closing the editor when the changes cannot be saved** (for example the undo history is full) still closes it, puts the plug-in back to the score's settings, records no edit, and tells the user (`plugin.history_full` or `plugin.save_failed`).
- **The helper's latency reports** are rate limited with a back-off. An unchanged latency is announced only on the first reconfigure of a run.
- **The library** checks `previous_bundle` like any other untrusted file data, and a full library still fits its file.
- An export fault names its status (crashed, hung or non-finite). The offline export waits the offline block timeout (10 s).

### Delay compensation and export (`fix/vst-b`)

- **Without plug-ins, playback is as before, bit for bit.** A loop wrap and a range-export join are plain seeks when no plug-in is active, as they were before plug-ins existed.
- **An edit while playing keeps the compensation and the plug-in running.** The running insert and the delay lines are handed to the new renderer, so the plug-in track does not go silent for the delay after an edit. The hand-off does not allocate. It takes nothing when the tracks differ.
- **Removing the last plug-in returns to the plain path** once the compensation has glided to zero.
- The count-in and the drain keep the per-track MIDI-out fade. A seek clears all of the delay history the line can read.
- The tests for the wrap, count-in, MIDI delay, export segments, export tail and the fresh offline helper now fail when the behaviour they name is broken (see the mutation checks below).

### UI, build and docs (`fix/vst-c`)

- **The plug-in protocol's build id is a fingerprint** of the helper's and the protocol's sources, so a helper built from other sources is refused.
- The plug-in host build script passes `--locked`, honours `CARGO_TARGET_DIR` and finds Cargo outside `PATH`.
- **The plug-in panel shows every error.** Library failures, consent and retry failures, and the history-full message are shown in en, et and de. A "Save plug-in settings" button commits the editor's state while the editor stays open. One gesture is one edit, and an unchanged state records nothing.
- Moved plug-ins are named per track. Two open editors are tracked apart. The live regions and the "Replaced" labels were fixed for screen readers. Trims and saving a named sound were fixed.
- The desktop drivers were changed to check what they claim (the export changes the sound by a known gain, the hang check goes through the Rust side, the editor window and its state are checked). The 2026-11-08 validation doc was corrected against the code.

### Integration (this pass)

- **A refusal at mix build time reaches the user.** The renderer used to drop an insert it refused without a word. The mix now names each refused track and why. The audio service keeps what its last build refused, and the runtime tells the slot, as it already does for refusals it finds before the build: too much latency shows as `tooMuchLatency`, a pipeline over the cap shows as `underrun`, and a helper at another rate asks for the mix to be built again at the device's rate. This covers a device change between the runtime's check and the build.
- **`Renderer::attach_offline_plugins` is deleted.** Nothing called it.
- **Plug-in notices are shown.** The app listens for the `plugin-notice` event and shows `plugin.busy`, `plugin.save_failed` and `plugin.history_full` in the document's plug-in notices, named by track, until the user dismisses them. The `error` field of an editor close joins the same list. The same notice for the same track appears once, so a close whose error comes both ways shows one notice. Unknown keys are not shown raw. New text (`plugin.busy`, `plugin.save_failed`, `plugin.dismiss`) is in en, et and de; `plugin.history_full` was already there.
- `plugin-host/README.md` now says that an unchanged latency is announced only on the first reconfigure of a run, with the back-off.
- The design spec records the stuck-main-thread policy and the busy retry policy.

## Test evidence

From the three fix reports (`fix-a`, `fix-b`, `fix-c`, run on their own branches before the merge):

| Area | Runs | Result |
|---|---|---|
| Plug-in service (fix-a, last round) | `--lib` | 877 passed, 7 ignored |
| Plug-in e2e with the real helper and test plug-in (fix-a, round 2) | `plugin_editor`, `plugin_playback`, `plugin_export`, `plugin_rate`, `plugin_helper`, with `--include-ignored` | 8, 10, 9, 5 and 40 passed |
| Helper crate (fix-a) | `-p tabplayer-plugin-host --include-ignored` | 43 unit and 29 helper tests passed |
| Compensation and export (fix-b, round 2) | `audio_plugin_compensation` | 23 passed |
| | `audio_transport`, `audio_practice_transport`, `audio_plugin_insert`, `audio_render`, `audio_master`, `audio_midi_out` | 7, 15, 37, 38, 20, 14 passed |
| | `plugin_playback --include-ignored`, `plugin_export --ignored` | 8 and 9 passed |
| Protocol and build (fix-c) | `-p tabplayer-plugin-protocol` | 43 lib tests, frame and no-alloc passed |
| | `node --test scripts/build-plugin-host.test.mjs` | 6 passed |
| UI (fix-c) | Vitest on `src/audio`, `src/rig`, `src/i18n`, `src/workspace` and others | 1848 passed; the 7 `plan.test.ts` failures are the known missing fixtures in a worktree |

**Mutation checks.** fix-a ran 23 mutations of its fixes, and fix-b ran 20. Each was caught by the test named for it, with these exceptions:
- fix-a's mutation 7 survived at first, and the test was strengthened until it was caught.
- fix-a's mutation 20 was not run by the script; its test failed before the fix instead.
- Three of fix-b's single mutations survive, because the no-plug-in path has two independent guards; with both removed, every test fails.

**Test-first.** fix-a's first round wrote some fixes before their tests. For those, the mutation table is the evidence that the tests can fail. Its second round and fix-b's tests failed before their fixes.

Integration pass, on the merged branch:

| Check | Result |
|---|---|
| `cargo check --locked --workspace --all-targets` right after the merge | clean (two old `unused_mut` warnings in `audio_wah` and `audio_tempo_sync`) |
| `npx tsc --noEmit` after the merge and after the changes | clean |
| New Rust tests, before the change | failed to compile (the methods did not exist) |
| `--test plugin_rate` | 6 passed, including `a_mix_names_every_insert_it_refused_and_why` |
| New lib tests `a_mix_change_reports_the_inserts_it_refused_once`, `a_rebuilt_renderer_reports_the_inserts_it_refused`, `an_insert_the_audio_service_refused_reaches_the_slot_status` | passed |
| New Vitest file `src/audio/plugin-notice.test.tsx`, before the change | 8 failed |
| `cargo fmt --all -- --check` | clean |

| `cargo test --lib` after the changes | 881 passed, 0 failed, 7 ignored |
| `npx vitest run` on `src/audio/plugin-notice.test.tsx`, `src/audio/plugin-slot.test.tsx`, `src/i18n`, `src/export/ExportDialog.test.tsx` and `src/App.test.tsx` | 7 files, 407 tests passed |
| Mutation: the renderer drops a refusal instead of naming it | `a_mix_names_every_insert_it_refused_and_why` failed |
| Mutation: a mix change does not keep its refusals | `a_mix_change_reports_the_inserts_it_refused_once` failed |

Not rerun in this pass: the ignored e2e targets with the real helper (`plugin_editor`, `plugin_playback`, `plugin_export`, `plugin_helper`), the other integration targets, and a full `--workspace` test run. The merged branch was only type-checked across all targets.

## Limits

- **The Gojira X click timing was not measured.** That needs the real plug-in. The earlier report's capacity figure (it should be 13,056 frames at 48 kHz) and its `ClearLoop` claim were not corrected either.
- **MIDI stamps jump to the new delay on a mix change**, while the audio glides to it over 10 ms.
- **Growth of the device callback is polled every 100 ms**, not signalled from the callback thread. A re-prepare can lag by up to 100 ms plus the build. No test drives the device's real callback size.
- **A pipeline over the cap shows as `underrun`.** There is no status of its own for it.
- **`DocumentWorkspace::add_document` does not shut down the previous document's helpers**, unlike `activate_document`. They run until that document is activated and switched away from again, or closed. (Fixed later: final review M1, `2026-11-09-vst-final-review-fixes.md`.)
- **The desktop drivers and the packaged Tauri build were not run again after the fixes.** The drivers were changed and have never run in their new form, so their new checks are untested. No `tauri build` with the plug-in overlay or packaged-resource check was run.
- **macOS and Linux are untested.** Every run was on Windows. On non-Windows, `offline_inserts` has an unreachable loop body (T14-M5, not fixed). (Fixed later, reviewed but not compiled: final review L4, `2026-11-09-vst-final-review-fixes.md`.)
- **The wiring of a build-time refusal is tested in parts.** The renderer, the audio service and the runtime's reporting each have a test, but no test drives a real stream through the runtime's `prepare` or `set_mix` to the slot status, because that needs an open device.
- A notice stays until the user dismisses it. A `plugin.busy` notice is not cleared when the plug-in later takes the settings, because nothing reports that.
- Other open items from the fix reports: the built-in synth tail does not sound through the count-in or the drain; an edit while playing still cuts sounding sample notes (now D frames later on every stem); export fails as a whole on `hostMissing`, `tooMuchLatency` or a missing state asset (T14-M1, needs a product decision); the library list cannot mark Missing entries; nothing tests that the copy notices ship the VST texts (17-5); the `checkPluginHost` platform default (17-6); the device-fault `pause()` (18-5) and the meter (18-8) are not covered further; display scaling of the editor is untested; and the low-severity findings L1 to L3 of Task 13 and L1, L2, L3 and L5 of Task 15 are open.

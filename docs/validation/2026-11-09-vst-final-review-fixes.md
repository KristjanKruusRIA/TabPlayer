# VST hosting: final review fixes (THE-71)

Branch `fix/vst-d`, from `feature/vst-hosting` at `5852a0e`. Fixes M1, M2, L1, L2 and L4 of the final whole-branch review. L3 (spawn the helper suspended before the job assignment) is not part of this pass.

## What changed

- **M1. Opening a document ends the helpers of the one left.** `DocumentWorkspace::add_document` now calls `plugins.shutdown_document` for the outgoing document, as `activate_document` does. It does so only after the new document's entry is built, so a failed open leaves the old helpers running.
- **M2. An editor save moves the baseline only once the document holds the state.**
  - `editor_save` no longer sets `state_asset_id` and `baseline_state_id` to the state it hands out. It keeps it as `saved_state_id` on the slot.
  - The slot takes it as its state and baseline once the document is seen to hold it:
    - by the next `ensure` whose slot names it, which then sends the helper nothing, because the helper already holds it;
    - or, at the next save or close, by the track's last `SetTrackSound` in the active history. The save's own edit is one of those, so this holds for a duplicated track as well.
  - Until then the slot's state stays the document's. So a save whose edit was refused is offered again by the next save and by the close, and a revert goes back to what the document really holds.
  - An `ensure` that names a different state sends it, which also clears `saved_state_id`. That covers an undo of a committed save before any prepare.
  - `editor_open` does not take the plug-in's state as the baseline while an unconfirmed save is held, because that state is not the document's.
- **L1.** A save that returns the state the slot already has cancels its staged asset (`pluginCancelAsset`, which is `cancel_asset`). Before, the token was dropped and up to 8 MiB stayed staged until the document closed.
- **L2.** In `2026-11-08-vst-hosting.md`, the Spike 2 bullet now gives `P` from `limits::pipeline_frames` rather than a fixed 256 frames. Limit 20 no longer says `previous_bundle` is unchecked: commit 19fd9c2 fixed that.
- **L4. Non-Windows paths.** Every `#[cfg(windows)]` and `#[cfg(not(windows))]` boundary in `src-tauri/src/plugins`, `src-tauri/plugin-host` (with `tests/helper.rs`), `src-tauri/test-plugin`, `src-tauri/src/audio` and the `src-tauri/tests/plugin_*.rs` targets was read by hand.
  - `ensure` and `offline_inserts` ended a `#[cfg(not(windows))]` block with `continue`, so off Windows the rest of each loop body was unreachable. Both now ask the launcher (`Launcher::hosts_plugins`, whose default is `cfg!(windows)`).
  - That also fixes test failures, not just warnings. The service and runtime unit tests that wait for a ready helper run over a fake launcher, but on Linux and macOS `ensure` refused them with `UnsupportedPlatform`. The fake now hosts on every platform, and a new test runs the unsupported path on every platform.
  - `editor_open` left `pid` unused off Windows. It now calls `allow_foreground`, which does nothing off Windows, on every platform.
  - `library::simplify` used `#[cfg(windows)]`, which left `plain_drive_path` and `reserved_device` as dead code off Windows. It now uses `cfg!(windows)`.
  - Nothing else was found:
    - `helper.rs` allows dead code and unused imports off Windows for the whole module, and its `#[cfg(not(windows))]` arms consume their arguments with `let _ = (..)`.
    - `bridge.rs` has a condvar event and a heap-only `Owner` off Windows. Its Windows-only items (`raw`, `create_shared`, `mapping_handle`) are used only from Windows code.
    - `commands.rs` names the helper per platform.
    - The plug-in host builds only `stub` off Windows, under a crate-wide `allow(dead_code)`. Its shared modules do not reference the Windows modules.
    - The test plug-in marks its editor-only items `allow(dead_code)` off Windows.
    - `src-tauri/src/audio` has no platform gates.
- **CI.** `.github/workflows/desktop.yml` sets no `RUSTFLAGS` and passes no `-D warnings`, and no crate denies warnings. A warning off Windows would not fail CI. A failing test would, which the L4 test fix addresses.

## Evidence

All runs on Windows 11, x86_64-pc-windows-msvc, `CARGO_TARGET_DIR=E:/cargo-target/slot-1`, `-j 4`.

| Check | Result |
| --- | --- |
| M1 test `opening_another_document_shuts_down_the_helpers_of_the_one_left`, before the fix | failed: the helper was not shut down |
| M2 test `a_save_the_document_refused_is_offered_again_on_the_next_save_and_the_close`, before the fix | failed: the second save returned nothing |
| Mutation: `ensure` never takes the saved state | `the_prepare_after_a_committed_save_takes_it_without_sending_it_again` failed |
| Mutation: the save and the close never take a committed save | `a_committed_save_is_not_offered_again` failed |
| L4 test `a_launcher_that_cannot_host_here_reports_every_active_slot_unsupported`, before the service asked the launcher | failed: `Loading`, not `UnsupportedPlatform` |
| L1 vitest `cancels the staged state when the same state comes back…`, before the fix | failed: no `cancel_asset` call |
| `cargo test -p tabplayer --lib` after all changes | 887 passed, 0 failed, 7 ignored |
| `cargo test --test plugin_editor -- --ignored --test-threads=1` (real helper and test plug-in) | 8 passed |
| `cargo test --test plugin_playback --test plugin_export -- --ignored --test-threads=1` | 10 and 9 passed |
| `cargo fmt --all -- --check` | clean |
| `npx vitest run src/audio/plugin-slot.test.tsx src/audio/plugin-host.test.ts src/audio/plugin-notice.test.tsx` | 3 files, 57 tests passed |
| `npm run typecheck` | clean |

## Limits

- **L4 was reviewed, not compiled.** Only the `x86_64-pc-windows-msvc` target is installed here, and nothing could be installed. The non-Windows code has never been built. The first CI run on Linux and macOS is the real check, for warnings and for the tests.
  - Other unit tests may still fail off Windows for other reasons. One example is the library's handling of the fake `.vst3` files the rigs write. Only the platform gate in the service was looked at.
- **M2 relies on the track's last `SetTrackSound`.** A committed save that is undone before any prepare is not taken as the baseline. The next `ensure` sends the document's state back to the helper, as it did before.
- **Not rerun:** `plugin_helper` and `plugin_library` ignored targets, the full `--workspace` test run, the desktop drivers, and the packaged Tauri build.

### Re-review of these fixes

A fresh re-review approved M1, M2, L1, L2 and L4. It found three low-severity edge cases in the pending save (M2):

- **Fixed:** a Save that found nothing new left an old pending save behind. The next `ensure` then sent that state again, and a later redo naming it could be adopted while the helper held another. Save now drops the pending save when there is nothing to save.
- **Limit:** a Save whose edit is refused, followed by any `ensure` (for example the mix change a revision conflict brings), loses the change made in the editor. `ensure` sends the document's state, and the next Save then offers nothing. The code before these fixes did the same. The check that causes it is needed for undo, so it stays.
- **Limit:** after undoing a committed save, a close or Save in the few milliseconds before the undo's mix change runs records the undone state again.

## Real-app run (2026-11-09)

The desktop test app was built with `scripts/build-desktop-test.ps1`, which also built the helper and the test plug-in, and `node tests/desktop/parity-vst-plugin.mjs` was run on Windows.

- **First run:** steps 1 to 5 passed. Step 6 failed: a plug-in that hung during playback never reported `hung`.
  - Its first underrun was reported as `underrun` before the 500 ms heartbeat rule could act.
  - The helper was shut down gracefully and relaunched, so the status went back to `ready`. Nothing killed it.
  - The Rust test of this case rendered too few callbacks to reach that path.
- **Fix (`207ccfd`, `0ec2d2e`):** the supervisor holds an underrun while a helper still owes blocks and its heartbeat has not moved.
  - A stuck helper is then reported `hung` and killed.
  - A slow helper still reports `underrun`.
  - New tests cover a hang during playback, a hung helper's underrun and a slow helper's underrun. Each failed under the matching mutation.
- **Driver fix:** step 6 had never been run before.
  - It now loops the score and clicks Play once.
  - It sets the hang on each relaunched helper until `hung` holds for 2 s.
  - It times each command inside the page against 200 ms.
- **Final run:** all 9 steps passed, with 0 page errors and 0 fallbacks (run folder `vst-plugin-VToelJ`, not committed). In step 6:
  - the first `hung` came 4.5 s after the hang began;
  - the slowest command answered in 9 ms;
  - the hung helper was killed;
  - the built-in tone kept playing.
- **Limit:** if a re-prepare for another reason lands inside the hold window (up to 500 ms), a hung helper's underrun is still reported as `underrun` and the helper is relaunched.
- **Not run:** the real-plug-in acceptance driver, a packaged `tauri build` with the plug-in overlay, and Linux or macOS.

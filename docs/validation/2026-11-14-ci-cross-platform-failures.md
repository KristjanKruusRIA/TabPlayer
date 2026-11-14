# CI cross-platform failures after the VST3 hosting work (2026-11-14)

Source: the failed-step log of CI run 43199416608 (12 November). All failures are in `cargo test --lib` of `tabplayer`; the step stops there, so later steps (including the ignored `selected_real_100bar_fourtrack_resource_budget` test) did not report in that log. Vitest and Node tests did not fail (the AlphaTab "Score import failed" lines are expected output of negative tests). Nothing else failed: no build or packaging error appears in the failed-step log.

| Test | Linux | macOS | Windows |
|---|---|---|---|
| `export::audio::tests::missing_plugin_exports_built_in_with_warning` | fail | fail | pass |
| `export::audio::tests::needs_consent_exports_built_in_with_warning` | fail | fail | pass |
| `plugins::library::tests::caps_library_at_256` | fail | fail | pass |
| `plugins::library::tests::previous_bundle_is_checked_as_untrusted_file_data` | fail | fail | pass |
| `plugins::library::tests::a_full_library_of_moved_classes_still_fits_the_file` | fail | fail | pass |
| `plugins::library::tests::a_class_moved_to_another_bundle_records_previous_bundle` | pass | fail | fail |

Totals in the log: Linux 5 failed, macOS 6, Windows 1.

## Causes and changes

1. **Export tests (Linux, macOS).** Plug-in hosting is Windows-only by design: `Launcher::hosts_plugins` defaults to `cfg!(windows)` (`src/plugins/service.rs:282`) and `launch_with`/`probe_with` return `UnsupportedPlatform` off Windows (`src/plugins/helper.rs:891`, `:1515`; see `2026-11-09-vst-final-review-fixes.md`, L4). The tests used the real launcher, or a fake that kept the default, so off Windows `offline_inserts` warned `UnsupportedPlatform` before reaching the library or consent rules (`src/export/audio.rs:771`, `:875`). Change: both tests now use a launcher that hosts everywhere (`HostsNothingLaunched`; the consent test's `CountingLauncher` overrides `hosts_plugins`), so `Missing` and `NeedsConsent` are asserted on every system. A new test, `real_launcher_exports_built_in_with_warning_for_a_plugin_it_cannot_host`, uses the real launcher and expects `Missing` on Windows and `UnsupportedPlatform` elsewhere. Every test still asserts no inserts (built-in sound) and exactly one warning.
2. **Library tests with Windows paths (Linux, macOS).** The tests built bundle paths as `C:\...`, which is not absolute off Windows, so `valid_bundle` (correctly) rejects them (`src/plugins/library.rs:912`, `:1341`, `:1375`). Product validation is unchanged. Tests now build paths from `ABS_ROOT`/`plain_bundle` (drive root on Windows, `/` elsewhere); the `\.\` device-path case is Windows-only, and the relative, `..`, wrong-extension and too-long cases run everywhere. Backslash filler still runs everywhere (legal in Unix names).
3. **Moved-class test (Windows, macOS).** `add` stores the canonical path (`locate`, `library.rs:447`), the test expected the temp dir's spelling (`RUNNER~1`, `/var`). The stored form is right; the test (`:1395`) now compares with `canon(...)`.
   Mirror-image check: every path entering the library goes through `locate`, which canonicalises first, and the move test compares canonical with canonical (`library.rs:603-628`). No product defect. New test `a_bundle_added_again_by_another_spelling_of_its_path_is_not_a_move` adds a bundle, then adds it through a `..` spelling and through an alias (Unix symlink, Windows 8.3 short name) and requires one entry and no `previous_bundle`.

## Verified

- Windows: `cargo fmt --check` clean; `cargo test --locked --lib` 993 passed, 0 failed, 7 ignored, both with the normal TEMP and with TEMP set to a short-name directory (`...\Temp\CI-LON~1`).
- Reproduced: with the original code and the short TEMP, the moved test failed exactly as in CI (`...\ci-long-directory-name\...` vs `...\CI-LON~1\...`); it passes with the fix. The new alias test ran with a real 8.3 alias (it asserts the alias differs from the canonical path).
- `npm run typecheck` clean; `node scripts/secret-scan.mjs` 0 findings. No TypeScript changed.

## Inferred, not run

- Linux and macOS were not built: only `x86_64-pc-windows-msvc` is installed, so no `cargo check --target x86_64-unknown-linux-gnu` was possible. The Unix-only branches (`alias_of` symlink) and the non-Windows path assertions are reasoned from the code and the CI messages. Their first real check is the next CI run.
- The ignored `selected_real_100bar_fourtrack_resource_budget` test was not run locally and not seen in the failed-step log.

## Second wave: run 43590469111 (head e4d4404, 14 November)

Windows is green. The failed-step log holds three failures, all in `cargo test --workspace`, which stops at the first failing test binary. Frontend tests and `tsc` passed on Linux (406 files); the macOS log holds only the cargo step.

| Test | System | Cause | Change |
|---|---|---|---|
| `midi_in::tests::the_test_port_is_listed_and_fed_only_when_asked_for` (`src/midi_in.rs:2265`) | Linux | The runner has no `/dev/snd/seq`, so `midir::MidiInput::new` fails and `SystemMidiIn::ports` returns `Err("MIDI support could not be initialized")`. The test also called `SystemMidiIn::default().ports().unwrap()` on the real system. | `SystemMidiIn::list_with` (new, `src/midi_in.rs:~383`): a build with the test port enabled (`test_port`, so only the test and `desktop-test` builds) lists the injection port even when the system client cannot be made, because that port needs no system client. Without the test port a failed client is still an `Err`, never an empty list. The system failure is not reported alongside the test port. The plain-listing half of the old test no longer needs hardware. New test `the_test_port_needs_no_system_midi_client_but_a_plain_listing_still_does` uses a client factory that fails. |
| `compensation_stays_off_the_heap` (`tests/audio_plugin_compensation.rs:1355`, got 1) | macOS arm64 | See below. | `src/plugins/bridge.rs`: `MappedRing::wrap` and the non-Windows `event::Inner::new` use their lock once at construction. |
| `transport_count_in_drain_and_mix_changes_stay_off_the_heap` (`:2201`, 1 time) | macOS arm64 | Same. | Same. |

### macOS allocation

The counting allocator is not at fault: its flags are `const` thread-locals with no destructor, so the first access allocates nothing, and the same harness passes in 12 other binaries on macOS. The one operation comes from std. `std::sync::Mutex` is the futex kind on Windows and Linux, but on macOS (std `sys/sync/mutex/mod.rs`: `target_family = "unix"` falls to `pthread`) it is boxed lazily: the first `lock` or `try_lock` allocates the pthread mutex (`OnceBox`), and the `Condvar` does the same on first `notify`. `MappedRing::with_host` (`try_lock` on the host-end mutex) and `EventHandle::signal` (`lock` plus `notify_one`) run on the audio thread. Both failing tests install a mix whose ring has never been touched (`rig_2`, `rig_b`) inside the measured region, so the audio thread makes the first `try_lock` there: exactly one allocation. This is a real audio-thread allocation on platforms with pthread-backed locks, not a harness artefact, so it is fixed in the product: the locks are used once at construction, off the audio thread. No change on Windows or Linux beyond one uncontended lock. `tests/audio_plugin_insert.rs::insert_process_stays_off_the_heap` has no warm-up at all and the same exposure; the fix covers it. In `src/` the plug-in helper is Windows-only, so this path is reached off Windows by tests only, but the invariant is kept.

### Proven and inferred

- Proven on Windows: `cargo fmt --all -- --check`; `cargo test --locked --lib` 994 passed; integration tests `audio_plugin_compensation`, `audio_plugin_insert`, `midi_in`; `npm run typecheck`; `node scripts/secret-scan.mjs` 0 findings. With the test-port fallback temporarily reverted, the new test fails with exactly CI's `Err("MIDI support could not be initialized")`; with it, it passes.
- Inferred, not run: the macOS allocation cause is from std source and the arithmetic (one operation, only on never-touched rings); it cannot be shown on Windows. The pthread change has no Windows test.

### Third wave checked by reading

- Other `midi_in`/`midi_out` tests: only the one above used `SystemMidiIn`; `SystemMidi::ports` already lists nothing when the client fails; `tests/midi_in.rs` uses a fake backend. Audio device tests: the ALSA `Unknown PCM default` lines come from `runtime::document_audio_ownership_tests::set_mix_with_an_unchanged_backing_does_not_decode_the_asset`, which passed (a clean error).
- All 13 other counting allocators use `const` thread-locals; none has a `Mutex`, `Condvar` or `OnceLock` on the audio path. `plugin-protocol/tests/no_alloc.rs` uses no locks.
- `plugin_editor`, `plugin_export`, `plugin_library`, `plugin_playback` are wholly `cfg(windows)`; `plugin_helper` has a `cfg(not(windows))` module asserting `UnsupportedPlatform`; `plugin-host` is a stub off Windows with a test that checks it. The Windows-only CI step is correctly gated.
- Unix branches in integration tests (symlinks in `document_workspace`, `file_library_*`, `recovery`) use canonicalised temp roots and `cfg(windows)` for `cmd`/`mklink`; read, not run.
- `scripts/verify-packaged-resources.mjs` skips symlinks, normalises `\`, and needs the plug-in host only on `win32`; `.app`, deb and AppImage layouts are not run here. The `ignored` resource-budget test uses only the manifest and decoder.
- Not checkable: AppImage extraction and `hdiutil` behaviour, free disk on the Linux runner before packaging.

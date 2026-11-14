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

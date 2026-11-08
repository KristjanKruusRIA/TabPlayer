# CI failures on the first public develop run

Date: 2026-11-07. Run 42396511098, at develop `4baa4fe`, the first CI run since the repository was made public. It failed on macOS, Windows and Linux before the Rust and packaging steps ran. The failures had three causes. Fixes are in `1a3f14c` and `136e35a`.

## `tuning-ui.test.tsx`, "App presets fill drafts only…" (all three platforms)

- **Error:** "Found multiple elements with the role alert".
- **Cause:** a test environment gap. A26 added the inspector's MIDI output panel (`src/audio/MidiOutPanel.tsx`). It lists ports through the real Tauri `invoke`, which fails in jsdom. The panel then shows "MIDI ports could not be listed…" as a second alert, next to the expected one.
- **Fix:** `src/App.test.tsx` and `src/tuning-ui.test.tsx` mock `nativeMidiOut` (no ports; the other calls succeed), alongside their mocks of the other native bridges. `WorkspaceApp` and `session-startup` tests replace App entirely, so they need no mock.
- **Evidence:** the test failed locally the same way before the fix and passes after it.

## `App.test.tsx`, "entry key queue" (a different subset on each platform)

- **Failed tests:**
  - keeps the oldest eight;
  - refuses every later key after an overflow;
  - queues keypad durations;
  - counts the key that threw;
  - drops a key that waited more than two seconds (Windows only).
- **Cause:** a test that depends on runner speed. `App.tsx` drops queued keys older than two seconds (`ENTRY_QUEUE_STALE_MS`, measured with `Date.now()`), by design. The nine-key tests take about 1.8 s locally and about 4 s on CI, so the later keys aged past two seconds and were dropped. The test then waited for an edit that would never come.
- **Reproduction:**
  - Each held-edit wait takes at most 104 ms locally, even with every core loaded, so the 1 s `waitFor` limit was not the problem.
  - With `Date.now` running four times fast, the same three tests that failed on macOS failed locally, and only those.
- **Fix:** the `entry key queue` describe freezes `Date.now` in `beforeEach` and restores it in `afterEach`. The two-second test still moves the clock itself, so the rule stays covered.
- **Not reproduced:** the Windows failure of "drops a key that waited more than two seconds". It passed in eight runs alone, under full CPU load. Before the change, that test switched to a mocked clock months behind real time only after setup had stamped times with the real clock. The frozen clock now covers setup too, so that mismatch is gone. Whether this was the Windows cause is unconfirmed until CI runs again.
- **Evidence:** the 22 queue tests pass locally (22/22).

### Second run: the queue tests still failed (2026-11-08)

Run 42467609586, at develop `703cecf`, had the two fixes above and the memory fix below. The MIDI alert and the macOS crash were gone (352 of 356 files passed, none missing). The queue describe still failed on every platform, with a different subset each time:

| Platform | Failed queue tests |
|---|---|
| macOS | three fast letters; refused-edit discard count; "key" singular; two-second drop |
| Windows | refused-edit discard count; "key" singular; the key that threw |
| Linux | two-second drop |

- **The first diagnosis was incomplete.** The frozen clock removed one way for keys to age, but most failures were the queue's notice not being found by `findByText`, which waits at most 1 s by default.
- **Reproduction:** run alone, the describe passes (22/22). In a full run of `App.test.tsx`, five of its tests failed locally: the refused-edit discard count, a refused queued key, "key" singular, the two-second drop and the key that threw.
- **Cause:** each whole-workspace render in jsdom is slow, and gets slower later in the file. The notice for a refused key comes three renders after the refusal:

  | Run | Time from refusal to notice |
  |---|---|
  | the test alone | 615 ms |
  | late in the full file | 1,131 ms |

  At 1,131 ms the notice was already on screen, but `findByText` had given up at 1 s. CI runners are slower again, so more waits missed. The entry queue behaved correctly; only the test's waiting limit was too short.
- **Fix:** `src/App.test.tsx` sets `configure({asyncUtilTimeout:10000})` beside its 30 s test hang guard (THE-173). No wait in that file expects to time out, so passing tests take no longer. The frozen clock stays, so queued keys still cannot age during a slow test.
- **Evidence:**
  - the full file passed 214/214 twice with the fix, in 301 s and 276 s;
  - the whole suite with CI's settings (`npm test -- --maxWorkers=2 --testTimeout=15000`): Node resource tests 44/44, Vitest 357 files passed and 2 skipped (5,924 tests passed, 4 skipped) in 598 s;
  - `npm run typecheck` is clean.
- **Review:** an independent reviewer found nothing blocking. It confirmed that the setting reaches every `waitFor` and `findBy` in the file, stays within the file, and that no wait there expects to time out.
- **Not fixed here:** after a key is dropped, several queue tests wait only 30 ms before checking that no further edit landed, which is shorter than one render. These checks were already weak before this change.

### Third run: the Rust tests (2026-11-08)

Run 42472305778, at develop `cd23cc7`, passed the frontend step on all three platforms, which confirms the queue fix. It was the first run since the repository went public to reach the Rust tests. `cargo test` stopped at the library binary, so the integration tests in `src-tauri/tests` did not run on CI. Four library tests failed:

| Test | Platforms | Failure | Cause | Change |
|---|---|---|---|---|
| `set_mix_with_an_unchanged_backing_does_not_decode_the_asset` | Linux, Windows | `prepare` found no audio output device | Linux and Windows runners have no audio device | when `prepare` reports no usable output device, the test says so and stops; elsewhere it runs in full. It guards decoding under the workspace lock, not the device, so `#[ignore]` would have dropped it from every normal run |
| `a_slow_port_opening_does_not_delay_the_messages_to_a_port_that_is_open` (MIDI out) | macOS | note 1 written 41 ms in, due 20 ms, bound 15 ms late | the bound measured how promptly the runner scheduled the thread, not whether the 400 ms open blocked the port | at most 100 ms late; the check that every note went out before the slow open finished is unchanged |
| `a_folder_above_the_target_with_unreadable_attributes_does_not_refuse_it` (Windows) | Windows | setup proof: reading the denied folder succeeded | the `icacls` deny did not stop the runner's account | both outcome checks always run; when the deny did not bind, the test says the unreadable case was not exercised instead of failing |
| `a_tone_flows_from_capture_to_the_output_at_the_expected_level` (Line-In) | macOS, Windows | 94 Hz and 217.6 Hz for a 220 Hz tone | wall-clock test; a starved capture thread leaves gaps, and the resampler slows its ratio by up to 1 % (`MAX_ADJUST`, about 17 cents) to refill its buffer | frequency from the median crossing interval, at least 100 periods in the last second, limit 1 % + 3 cents; `drift_correction_keeps_the_pitch_true_in_real_time` still holds pitch to 1 cent on a simulated clock |

- **Reproduction of the Line-In failure:**
  - With all 28 cores kept busy, three of three runs failed, measuring 135 to 175 Hz.
  - With the median measurement, the tone read 217.8 to 218.7 Hz: steadily about 17 cents flat, which is the resampler at its 1 % limit, not gaps.
  - With the new limit, it passed five of five under the same load.
- **Local checks:**
  - `cargo test --no-fail-fast`: 70 test binaries, 1,472 passed, 0 failed, 17 ignored. CI has not yet run the integration tests.
  - The four changed tests pass with `--nocapture`. The device test ran in full, and the Windows test did exercise the unreadable case on this machine.
  - The MIDI test passed five of five.
  - `cargo fmt --check` is clean.
- **Review:** an independent reviewer found nothing blocking. Its points are applied:
  - the device test skips at runtime instead of being ignored;
  - the Windows test keeps both of its outcome checks;
  - the Line-In comment now gives the correct cause: underrun restarts re-arm the fast loop, whose proportional term reaches the limit;
  - the pitch limit is now based on 1 % flat.
- **Limits:**
  - The skip paths and the 100 ms MIDI bound were not run on a runner like CI's.
  - A controller with its sign inverted would also stay within the new Line-In limit. The simulated-clock test still catches that.

### Fourth run: the integration tests (2026-11-08)

Run 42479152487, at develop `18fe022`:
- The library tests passed on all three platforms, so the four fixes above held there.
- Windows passed every native test, then failed to build packages. The Tauri bundler's download of the WiX tools from GitHub returned HTTP 503, which is outside this code; a rerun should clear it.
- macOS and Linux reached the integration tests, and one failed on both: `alias_convergence_coalesces_all_matching_records_without_losing_pin` in `src-tauri/tests/file_library_store.rs`, with "Library unavailable: duplicate recent paths."

| | Detail |
|---|---|
| **Cause** | The test stores the same song as `music/song.gp` and `music/./song.gp`. `same_path` compares stored paths as text on Windows, but uses `Path` equality elsewhere, which drops `.`. So on macOS and Linux the catalog is refused as holding duplicates before the test's merge runs. The test and the check both date from 2026-10-15, so it has never passed there. |
| **Change** | On macOS and Linux the alias goes through a symlinked folder: a second spelling the catalog keeps apart, which the store's merge resolves to the same file with `canonicalize`. Windows keeps the `.` spelling. |
| **Evidence** | On Windows, `file_library_store` passes 27/27 and `cargo fmt` is clean. This machine has no Linux environment, so the macOS/Linux branch is checked only by CI. |

### Fifth run: Windows NSIS too large; Windows becomes MSI only (2026-11-08)

Run 42486198722, at develop `528b40d`:
- macOS and Linux passed every step, packaging included, so the alias fix holds there.
- Windows passed every test and built its MSI with WiX. `makensis` then failed with "Internal compiler error #12345: error mmapping datablock".

**Likely cause:**
- The bundled audio is 1.86 GB (4,449 samples). With the 214 MB offline WebView2 installer and the program, the payload is about 2.08 GB, near NSIS's limit of roughly 2 GB.
- The last passing Windows package run, 38641519103, had 3,864 samples and a 1.52 GiB MSI. The growth most likely came from the drum and slap samples added on 2026-11-06.
- A full temporary disk on the runner can give the same error; that was not ruled out.

**Decision (user):** Windows ships as an MSI only. The changes:
- `.github/workflows/desktop.yml` builds `msi` only and verifies only the MSI. The NSIS extraction and the `*.exe` upload glob are removed.
- The new `src-tauri/tauri.windows.conf.json` sets `bundle.targets` to `["msi"]`, so a plain local `tauri build` on Windows does not try NSIS. `tauri.conf.json` is unchanged for macOS and Linux.
- The README's build text is updated.

**Review:** an independent reviewer found nothing blocking in the CI edit. It confirmed that Tauri loads and merges the platform file, and that the verifier still fails if no MSI is produced. It raised these consequences, which come from reading Tauri's WiX template rather than from an install:
- The MSI installs for all users, so it needs administrator rights. The NSIS default was a per-user install.
- File associations use one ProgID per extension (`TabPlayer.gp` and so on). The MSI neither backs up nor restores a previous `.gp*` default. `2026-11-06-gp8-file-association.md` now carries this note.
- The MSI looks for an existing NSIS install folder first. On a machine with an NSIS install it could install over that folder without removing the NSIS entry.
- The MSI puts everything in one embedded cabinet. At about 2.08 GB it may meet the cabinet's own limit of about 2 GB as the audio grows. That is a judgement, not a test.

**Result:** run 42491990087, at develop `194becb`, passed every job on Windows, macOS and Linux.
- The Windows MSI is 1.72 GiB (`TabPlayer_0.2.0_x64_en-US.msi`, SHA-256 `a01b40c6…`).
- The extracted MSI passed the offline resource check: 4,449 samples, 1,849,535,358 encoded bytes.
- The MSI has not been installed on a real machine. The installer differences above remain unverified by install.

## `batch/convert.test.ts` killed on macOS ("JavaScript heap out of memory")

- **Symptom:** Vitest reported the crash as an unhandled error, and the file was missing from the totals (329 of 330). The 1 November macOS run was also one file short (313 of 314), so it has probably crashed since the test was added on 2026-10-30.
- **Cause:** "converts a dense score whose written score.gpif is larger than the input cap" converts 12 MiB of MusicXML. Its peak heap is between 2 and 3 GB:

  | Heap limit | Result |
  |---|---|
  | 2048 MB | crashes |
  | 3072 MB | passes, about 11 s |

  The CI log shows a 2.19 GB default heap on the 7 GB macOS runner. Windows and Linux runners have more memory, so they get larger default heaps.
- **Fix:** `vite.config.ts` sets `test.execArgv: ['--max-old-space-size=4096']`. It applies to the default forks pool, which CI uses.
- **Limitations:**
  - Worker threads refuse the flag, so `--pool=threads` would need it removed.
  - It overrides a larger `NODE_OPTIONS` heap a developer may set.
- **Evidence:** with `NODE_OPTIONS=--max-old-space-size=2048`, the file passes 10/10, where before it crashed.

## Review and checks

- **Review:** an independent reviewer confirmed all three causes and the safety of the frozen clock. It found the two unused mocks and the threads-pool limitation, which are fixed or noted above.
- **Local checks:**
  - the four affected test files pass 278/278;
  - the workspace, session-startup and batch-convert files pass 71/71;
  - `npm run typecheck` is clean.
- **Not run:** the full suite in CI's configuration (`--maxWorkers=2 --testTimeout=15000`).

## Follow-ups (not done here)

- Converting 12 MiB of MusicXML takes 2–3 GB of heap in Node. `convertScoreBytes` runs synchronously on the window thread, and Open accepts files up to 32 MiB, so the app's memory use in that case is worth measuring.
- When native audio is unavailable, the MIDI output panel retries the port listing on every track change, because failures are not cached.

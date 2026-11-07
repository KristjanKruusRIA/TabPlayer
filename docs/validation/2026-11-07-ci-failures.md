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

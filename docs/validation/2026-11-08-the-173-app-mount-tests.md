# THE-173: App-mount Vitest tests pass in a full local run

Date: 2026-11-08. Branch `fix/the-173-app-mount-timeouts`, from develop at 93834a9. Windows 11 Pro, Intel Core i7-14700KF (8 performance and 12 efficiency cores, 28 logical processors), 64 GB RAM, Balanced power plan, Defender real-time scanning on. Node 24.22.1, Vitest 5.0.4, jsdom 30.1.2.

Summary: a full local `npx vitest run` now passes 3 runs in a row (5822 passed, 7 skipped, 0 failed each time, 252 to 257 s), and a fourth on the final text (283 s), against 22 failures in 333 s before. The cause is CPU saturation, not any one slow query: this machine does little more work per second beyond about 6 busy processes, so Vitest's 27 workers made every test several times slower, and the tests that cost 1 to 4 s alone passed the 5 s limit. Two changes remove most of that load (a lazy jsdom load in the setup file, and a cap of 6 workers). The heaviest App-mount tests still sit within 10% of the 5 s default with the cap, so two test files get a stated 30 s hang guard.

## Before

One full run on develop's tree (`npx vitest run`, 27 workers, JSON reporter), with other applications using about 20% of the CPU throughout:

- **Result:** 22 of 5829 tests failed in 333 s, 18 of them "Test timed out in 5000ms".
  - `src/App.test.tsx`: 12, all timeouts.
  - `src/workspace/WorkspaceApp.test.tsx`: 7.
  - `src/interchange/midi-import.test.ts`, `src/library/content.test.ts`, `src/workstation/TrackSettingsPanel.test.tsx`: 1 timeout each.
- **Knock-on failures:** four of the seven WorkspaceApp failures are not timeouts. The cases "destroy-failure", "resume-failure", "cancel" and "native-failure" failed after 1.4 to 2.9 s with an assertion or DOM error, after the "success" and "resync-failure" cases of the same `it.each` had timed out and left their tree behind.
- **Fixtures:** no run in this investigation had an ENOENT. The worktree already holds the seven files in a real `.analysis/compatibility` directory, so no junction was made and nothing under `.analysis/` was touched.

### The same files alone

The six heavy files together (`App`, `WorkspaceApp`, `tuning-ui`, `TrackSettingsPanel`, `midi-import`, `content`) took 239 s and passed 341 of 341. `App.test.tsx` took 236 s alone: 214 tests, median 0.87 s, longest 3.8 s.

Comparing every `App.test.tsx` test between the full run and the solo run:

| | Solo | Full run, 27 workers |
|---|---|---|
| File total | 236 s | 320 s |
| Median test | 0.87 s | 1.06 s |
| The 12 tests that failed | 1.1 to 3.3 s | 5.1 to 9.1 s |

The slowdown is not spread evenly. Each of the first 20 tests of the file (its first 91 s) ran 2.5 to 8.1 times slower than alone; after about 100 s of the file the tests ran at their solo speed. In those first 100 s 12 to 15 test files were executing at once, among them `SoundRig` (94 s), `tuning-ui` (69 s), `musicxml-tempo-offsets` (42 s) and `convert` (40 s). After that `App.test.tsx` ran alone for 230 s.

The other failures were the same shape: `content` 2.0 s alone and 5.4 s loaded, `midi-import` 3.0 and 9.0 s, `TrackSettingsPanel` 1.5 and 6.3 s, `WorkspaceApp` cases 1.5 to 2.4 s and 5.1 to 7.6 s.

## Measurements

### How much work this machine does per second

A single-thread, allocation-heavy script (JSON round trips and regex, 0.68 s alone) run as K copies at once:

| Copies | 1 | 4 | 8 | 12 | 16 | 20 | 24 | 28 |
|---|---|---|---|---|---|---|---|---|
| Time per copy (s) | 0.68 | 0.80 | 1.14 | 1.38 | 1.83 | 2.35 | 2.90 | 3.27 |
| Total work per second (x a single copy) | 1.0 | 3.4 | 4.7 | 5.9 | 5.9 | 5.7 | 5.6 | 5.8 |

Past about 12 busy processes the machine does no more work per second, and each process just gets slower. This is why 28 logical processors do not help: Vitest's default of 27 workers is far past the knee. (Measured with other applications at about 20% CPU. The cause of the flat total, whether the hybrid core mix, memory bandwidth or power limits, was not isolated.)

### Where one App-mount test spends its time

A temporary measurement shim (not committed) timed every Testing Library query and `getComputedStyle` call while `App.test.tsx` ran alone (222 s):

- **Queries:** 1274 queries took 103 s (46% of the file). The 847 role queries took 90 s (40%).
- **Button queries are the cost:** the 354 default-visibility `getByRole`/`queryByRole('button', { name })` calls took 75 s, 210 ms each. `getByLabelText` (283 calls) cost 28 ms each, and `getByRole('region', { name: 'Score workspace' })` (299 calls) 24 ms.
- **Why:** a CPU profile of one test (3.7 s, 11 role queries taking 52% of it) put 71% of the time in `queryAllByRole` into `computeAccessibleName` (1612 of 2274 ms), nearly all of it in `isHidden` (1531 ms), which calls jsdom's `getComputedStyle` for every node of every button it looks at. jsdom caches computed styles per element until the DOM changes. In three of the heaviest tests, the first button query after a DOM change cost 244 ms and the others 134 ms.
- **What was left alone:** cutting that cost means fewer or narrower queries in 188 `click(...)` calls, and a safe shortcut that keeps the assertions is not obvious. The one visible waste is 60 default-visibility queries that return null before the `hidden: true` fallback (6.8 s, about 3%). That is not worth a helper change.

### Worker count, before the setup change

Full runs with `--maxWorkers=N`, nothing else changed:

| Workers | Wall | Failed tests | Files with failures |
|---|---|---|---|
| 8 | 297 s | 9 | 2 |
| 12 | 296 s | 7 | 2 |
| 16 | 334 s | 15 | 3 |
| 20 | 298 s | 14 | 4 |
| 27 (default) | 333 s | 22 | 5 |

A cap helps but does not remove the failures: even 8 workers ran `App.test.tsx` 2 times slower than alone for its first 140 s. The run is bound by that one file (292 s of the 297 s).

### The setup file loaded jsdom for every test file

`tests/xml-dom.mjs` imported jsdom at the top, to provide `DOMParser` and `XMLSerializer` in Node tests, so all 353 test files paid for it, most of them in the Node environment. At rest, `import 'jsdom'` takes 728 ms and `new JSDOM('')` 40 ms. A 5-test file (`src/clipboard-commands.test.ts`) took 1.12 s in total, 77% of it setup; with the setup file removed it took 0.30 s.

Vitest's own summary of the 27-worker run read "setup 25%" of summed time and about 2.31 s startup per file. After the change setup is gone from the summary and startup is about 0.58 s per file.

### Worker count, after the setup change

| Workers | Wall | Failed tests | Files with failures |
|---|---|---|---|
| 27 (default) | 275 s | 19 | 7 |
| 4 | 258 s | 2 | 1 |
| 6 | 250 s | 3 | 2 |

With 4 or 6 workers every remaining failure was one of the heaviest App-mount tests at 5.1 to 5.3 s, plus one knock-on of it: `WorkspaceApp` "destroy-failure" (4.05 s alone) and, once, the `App.test.tsx` test "creates piano chords" (3.7 s alone). The work per second is flat across these worker counts, so the wall time barely moves with the cap, and a lower cap only buys speed per test.

## Cause

1. **CPU saturation.** The suite is CPU-bound, and on this machine every extra busy process past about 6 to 12 slows all the others. Vitest's default of 27 workers made the tests 2.5 to 8 times slower during the first 100 s of a run, when all the heavy files overlap. Tests that cost 1 to 3.3 s alone then exceeded 5 s. CI runners with 4 virtual CPUs start 3 workers, which fits CI never having reported these files; that was not measured here.
2. **Wasted startup.** About 0.77 s of CPU per file went on loading jsdom for files that never use it, roughly 270 s of CPU over 353 files at rest speed, which added to the saturation.
3. **No margin.** The heaviest App-mount tests cost 3.7 to 4.2 s alone (`App.test.tsx`) and 4.05 s alone (`WorkspaceApp` "destroy-failure") against a 5 s default. Any load at all moves them across.

## Changes

- **`tests/xml-dom.mjs`:** `DOMParser` and `XMLSerializer` are now accessors that load jsdom on first use and then turn into plain properties, as they were. A node-only file starts in 0.32 s instead of 1.12 s. Files that parse XML load jsdom exactly when they first touch the globals, so `typeof DOMParser` and `new DOMParser()` behave as before. jsdom-environment files never reach it, because the environment already defines both.
- **`vite.config.ts`:** `maxWorkers` is `min(6, logical processors - 1)`. It only lowers the count, so a 4-core CI runner keeps its 3 workers.
- **`src/App.test.tsx` and `src/workspace/WorkspaceApp.test.tsx`:** `vi.setConfig({ testTimeout: 30000 })` with the measurements above in a comment. It is a hang guard: the same kind and the same value as `APP_TEST_TIMEOUT` in `tuning-ui.test.tsx`, which already had one. A hung test still stops at 30 s.
- **Unchanged:** every assertion, every other timeout, the heap flag, and the tests' helpers and queries. `midi-import`, `content` and `TrackSettingsPanel` keep the 5 s default.

## After

Three full runs in a row on the final code, `npx vitest run` from the worktree root, each with the 6-worker cap:

| Run | Wall | Test files | Tests | Failed | Longest `App.test.tsx` test | Longest `WorkspaceApp` test |
|---|---|---|---|---|---|---|
| 1 | 252 s | 350 passed, 3 skipped | 5822 passed, 7 skipped | 0 | 4.57 s | 5.06 s |
| 2 | 257 s | 350 passed, 3 skipped | 5822 passed, 7 skipped | 0 | 4.45 s | 5.59 s |
| 3 | 254 s | 350 passed, 3 skipped | 5822 passed, 7 skipped | 0 | 4.63 s | 5.48 s |
| 4 (after rewording comments) | 283 s | 350 passed, 3 skipped | 5822 passed, 7 skipped | 0 | 7.39 s | 4.90 s |

- **Guard needed:** the longest `WorkspaceApp` test is over 5 s in runs 1 to 3, so without the guard each of those runs would have failed. Run 4 was slower for a reason that was not isolated (other applications were active, and I ran small analysis scripts during it): four `App.test.tsx` tests took 5.1 to 7.4 s and passed only on the 30 s guard.
- **Comment wording:** runs 1 to 3 ran with the first wording of the comments, run 4 with a second. A last pass then changed the figures quoted in three comments (the run 4 numbers and the sentence about plain properties) and this report; no code line changed after run 1.
- **Before and after:** failures 22 to 0; wall 333 s to 252 to 257 s; Vitest's startup per file 2.31 s to 0.58 s.
- **Typecheck:** `npx tsc --noEmit` is clean.

## Limits

- **One machine.** All numbers come from this Windows development machine with about 20% of the CPU used by other applications. No Linux, macOS or CI run was made. The cap cannot raise CI's worker count, and the setup change removes work there too, but neither effect was measured on CI.
- **Heavy external load defeats the margins.** Another full Vitest run or a Cargo build at the same time will still push the heaviest tests far past 5 s. `App.test.tsx` and `WorkspaceApp.test.tsx` now survive that (run 4 above shows it); `midi-import` (random-fill test, 2.4 to 3.3 s with the cap), `content` (1.6 to 1.8 s) and `TrackSettingsPanel` (0.9 to 1.0 s) have 1.5 to 5 times margin on the 5 s default and would not.
- **The wall time is set by one file.** With the cap, every other test file finishes by about 150 s and `App.test.tsx` runs alone for the rest of the 250 s. Splitting that file would shorten a full run, but each piece needs its own copy of the module mocks. It was not attempted. The cap and the setup change therefore make a full run about 25% shorter, not much more.
- **Not reduced:** the number or cost of role queries in the App-mount tests. The measurements above show where it is, and why a cheap fix would change what the tests check.
- **Run-to-run spread:** `App.test.tsx` took 247 to 255 s in the final runs, and single-test times move by 10% or more.
- **Method:** the figures come from Vitest's JSON reporter (`--reporter=json`) and from a temporary shim and probe config that were not committed. The wall times are `date` differences around the command and run 1 to 2 s longer than Vitest's own "Duration".
- **Run artifact:** every full run rewrites `src/audio/__snapshots__/plan.performance.test.ts.snap` with LF line endings (the content is identical; `git diff --ignore-space-at-eol` is empty). It was restored with `git restore` after each run and is not part of the change.

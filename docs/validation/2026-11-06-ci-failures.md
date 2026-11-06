# CI failures from the last develop run (THE-48)

Date: 2026-11-06. Branch `fix/the-48-ci-failures`, from develop at 827f734. Local machine: Windows 11, 28 logical processors.

The last CI run failed four items. Two were real defects and are fixed. Two come from slow runners: one gets a stated hang guard, and the other stays unchanged.

## macOS: `expressions.test.ts`, "lists keyboard shortcuts beside the commands that have them"

- **Cause:** a test defect. The palette labels shortcuts `Cmd+…` when `navigator.platform` matches Mac, iPhone or iPad. Node reports `MacIntel` on macOS runners, but the test expected `Ctrl+…` everywhere. The app handles `metaKey` wherever it handles Ctrl, so the label is right.
- **Fix:**
  - `shortcutModifier(platform)` is now exported from `src/editor/command-palette.ts`.
  - The test expects the label for the platform it runs on.
  - A new test pins the mapping for MacIntel, iPad, Win32, Linux and an unknown platform.
- **Evidence:** `npx vitest run src/editor/expressions.test.ts` passes 10 of 10 on Windows. The macOS branch is covered only by the mapping test; it was not run on a Mac.

## Windows: `musicxml-tempo-offsets.test.ts`, "stays linear…" (42,558 ms against a 40,000 ms limit)

- **Cause:** a slow runner. Locally the test takes about 9.4 s alone, and it passes inside a full parallel run, where the whole file takes 42 s. In CI the file took 47.7 s on Windows and 13.4 s on macOS.
- **Limit:** not changed. It is a real linearity budget, and the code is well inside it.
- **Defect found along the way:** MXL preparation was not deterministic. `zipSync` stamped each entry with the current time, so preparing the same score twice could give different bytes across a second boundary. Under load, this failed the sibling test "changes only the selected MXL root…".
  - **Fix:** `src/interchange/musicxml-tempo-offsets.ts` now passes a fixed DOS timestamp, `mtime: new Date(1980,0,1)`.
  - **Test:** a new test, "prepares the same MXL bytes at different times of day", uses fake timers 10 s apart. It fails without the fix and passes with it.

## Windows: `tuning-ui.test.tsx`, nine-string presets (timed out at 15,000 ms)

- **Timings:**

  | Run | Time |
  |---|---|
  | Windows CI | 16.9 s |
  | Linux CI | 14.1 s |
  | macOS CI | 3.8 s |
  | Local, alone | 4.3 to 6.1 s |
  | Local, full parallel run | about 16 s |

  The other four tests in the file use the default 5 s limit. They also time out locally under load: on 2026-11-06, all five failed in one full run and one failed in another.
- **Cause:** each test mounts the whole workspace in jsdom. Measured locally, one Testing Library `getByRole` query over that DOM costs about 300 ms, and role queries took 40 to 50% of each test's time. The `click` helper ran two role queries per click, one of them visible-only, which is the most expensive kind.
- **Fix:**
  - **Helper:** `click` now runs one role query and checks visibility with `toBeVisible`. That cuts the role queries per test by 40 to 50%; the retune test fell from 6.6 s to 4.3 s.
  - **Limit:** all five App tests share `APP_TEST_TIMEOUT = 30000`. The stated reason is that these are behaviour tests, not budgets. The limit is a hang guard sized for loaded runners: a 4 to 6 s test reached 16.9 s on Windows CI.
- **Evidence:** in the full local run after the change, `tuning-ui.test.tsx` passed 5 of 5.

## Rust: `a_page_search_over_fifty_thousand_rows_stays_fast` (about 2 s against a 2 s debug budget)

- **Timing:** `cargo test --lib a_page_search -- --nocapture` printed `search over 50000 rows with all filters: 204.7574ms` with the test profile. The budget is about ten times that.
- **Conclusion:** the CI figure comes from the runner. The budget is unchanged.
- **Setup note:** a fresh worktree needs an empty `src-tauri/resources/library` folder for the build script. The folder is ignored by git, and the main checkout has it empty.

## Full local Vitest run after the changes

- **Totals:** 47 of 5296 tests failed, in 11 of 317 files, over 282 s. One of the 47 was the shortcut test, from a placeholder lost while editing, and it was fixed afterwards. The rest had two causes, both present before these changes:
  - **Missing fixtures:** 26 ENOENT errors, from `.analysis/compatibility` fixtures. Worktrees do not have them. Files: `compatibility`, `audio/plan`, `export/musicxml`, `export/midi` and `interchange/gp`.
  - **5 s timeouts under full parallel load:** 14 tests, in `App.test.tsx`, `WorkspaceApp.test.tsx`, `TrackSettingsPanel.test.tsx`, `library/content.test.ts` and `interchange/midi-import.test.ts`.
- **Earlier develop runs:** the same timeout set appeared in two full runs on develop the same day, with 52 and 38 failures. CI has not reported these files, so they are left for a separate issue rather than widened here.
- **Typecheck:** `npm run typecheck` is clean.

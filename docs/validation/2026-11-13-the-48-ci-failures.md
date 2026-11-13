# THE-48 follow-up: re-checking the CI failures from 788cb88 (2026-11-13)

Branch `agy/the-48-ci-failures`, from `develop` 7f298b8. Windows 11, 28 logical processors.

The four failures reported on 788cb88 (1 November) were already handled by 5cc709a (6 November; see [2026-11-06-ci-failures.md](2026-11-06-ci-failures.md)). This note re-checks each one and records two test changes. No product code changed.

| Item | Status | Evidence |
|---|---|---|
| macOS: shortcut labels in `src/editor/expressions.test.ts` | Cause was the test; test strengthened now | The palette picks Cmd or Ctrl from `navigator.platform` when the module loads, and a macOS runner reports `MacIntel`. The test now stubs the platform and loads a fresh palette module for `MacIntel`, `iPad`, `Win32` and `Linux x86_64`, asserting literal labels, so the Cmd branch runs on every operating system. With the Mac check disabled the Mac cases fail. |
| Windows: `musicxml-tempo-offsets` "stays linear" | Specific to the runner; test redesigned | Alone it takes 7 to 9 s. Cost grows linearly (1.5 s, 7.2 s and 17.3 s for 1, 8 and 16 times the input) and is dominated by jsdom parsing. CI took 47.7 s on Windows against 13.4 s on macOS. |
| Windows: `tuning-ui` nine-string presets | Already fixed; no change | 10 of 10 alone (4.9 to 5.1 s), 3 of 3 in the whole file (20 to 24 s), 3 of 3 under 28 busy loops (up to 18 s per test, inside the 30 s guard). |
| Rust `a_page_search_over_fifty_thousand_rows_stays_fast` | Already fixed; no change | 204 to 229 ms alone and about 600 ms under 28 busy loops, against a 2 s budget. The near-miss of 31 October predates the tenfold speed-up in [2026-10-31-gp8-library-search-speed.md](2026-10-31-gp8-library-search-speed.md). |

## The timing limit that changed, and why

`stays linear with a long moved part beside many empty parts` had an absolute bound of 40 s. An absolute bound measures the runner, not the algorithm, so it is now a ratio: after a warm-up, four times the input (2400 bars with 180,000 parts against 600 bars with 45,000) must take less than six times as long, taking the faster of two runs at each size. Linear behaviour measured 2.4 to 4.5 over ten runs; a single measurement once exceeded 8, which is why two runs are taken. A temporary quadratic step in the code under test gave 7.75 and failed the check. The 120 s test timeout stays as the guard against a hang.

## Limits

- Nothing was run on macOS. The macOS conclusion rests on reading the code and on simulating the platform on Windows.
- A slow Windows CI runner was not reproduced; 28 busy loops on this machine are an approximation.
- `tuning-ui.test.tsx` keeps the default 1 s `waitFor` timeout for four waits where `App.test.tsx` uses 10 s. No failure from that appeared, including under load.
- The ratio check can still fail on a machine with very uneven timing; it would then report a ratio, not a wall-clock miss.

## Verification

- `npx vitest run src/editor/expressions.test.ts src/interchange/musicxml-tempo-offsets.test.ts`: 97 of 97 passed.
- `npx tsc --noEmit`: no errors.
- `cargo test --locked --lib a_page_search`: passed, times above.
- The full suite was run after merging into `develop`, not on this branch.

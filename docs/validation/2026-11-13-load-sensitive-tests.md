# Tests that failed only under load (2026-11-13)

Branch `agy/flaky-tests`, from `develop`. Windows 11, 28 logical processors. Two tests had failed intermittently in full runs on a loaded machine and passed alone. The cause in each was a wall-clock assumption in the test. Small test-only hooks were added to product code in `midi_out.rs` (below); no behaviour changed.

## 1. Vitest: "does not let a flood of chords starve a typed key" (`src/App.test.tsx`)

**Cause.** The test sends 14 chords and then a typed key. One chord runs at once, up to four wait, the rest are turned away and counted, and the typed key queues behind them. Each queued item runs after the previous edit has settled, which costs a render of the whole workspace in jsdom (0.2 to 0.4 s alone, more under load). `drainEntry` in `src/App.tsx` drops the whole queue when its oldest entry is more than `ENTRY_QUEUE_STALE_MS` (2000 ms) old. A dropped chord is counted; a dropped typed key is not. So on a slow machine the typed key `e` was discarded, written plus not-written came to 14, and the `waitFor` for 15 never succeeded. The neighbouring tests in the same `describe` ran the same queue without protection.

**Change.** The `MIDI capture in the score` describe now freezes `Date.now` in `beforeEach` and restores it in `afterEach`, the way the `entry key queue` describe already does (its own test moves the clock to test the 2 s rule). No timeout or interval was raised. The file already sets `asyncUtilTimeout` to 10 s and `testTimeout` to 30 s, so the "5 s timeout" seen in the failing runs was not this test's own limit; the failure was the missing count.

**Reproduced.** Temporarily replacing the frozen clock with one that advances 700 ms per call (a slow machine) made the test fail with `expected 14 to be 15`. With the frozen clock it passes.

## 2. Rust: `an_open_that_never_returns_delays_nothing_and_a_second_port_still_opens` (`src-tauri/src/midi_out.rs`)

**Cause.** Wall-clock assumptions in four places: `ensure_ports` had to return in under 100 ms; a 100 ms open timeout (on `Instant::now()`) ran while the test was still waiting for the second port to open, so a slow start could time out the healthy port; a 150 ms sleep was expected to be enough for the 100 ms timeout; and the hanging open was a 600 s sleep. The same pattern was in neighbours that share the `Fake` backend.

**Change.**
- Product code: `MidiOut::with_clock` (like `MidiInState::with_clock`) and a private `now()`, used by `reap` and `ensure_ports` for the open timeout and the retry spacing. Without it the system clock is used.
- Test backend: opens of chosen ports are held at a `Gate` (signals when entered, waits for release, 30 s hang guard; dropping the rig releases it). `rig_with(names, gated)` replaces the millisecond delays; `rig.holds.entered(name)` and `rig.holds.release(name)` sequence the test.
- "Asking does not wait" is now shown by the slot still being `opening` after `ensure_ports` returns while the gate is held, not by an elapsed time. The timeout is crossed by setting the manual clock to 150 ms, not by sleeping.
- Fixed the same way: `the_fault_bit_says_whether_the_port_is_really_open`, `a_slow_port_opening_does_not_delay_the_messages_to_a_port_that_is_open` (dropped the 100 ms upper bound on lateness; the proof is that all ten notes went out while the open was held; the lower "never early" bound stays), `a_retry_that_hangs_is_timed_out_even_though_the_try_before_it_failed`, `a_port_opened_after_the_route_was_built_takes_its_track_without_a_new_route`, and the two tests that used a 600 s sleep. `wait_for` and `settle` now allow 30 s as a hang guard. `the_test_port_is_listed_and_records...` lost its `< 500 ms` bound.

**Reproduced.** The old code, run under 150 busy `node` loops, failed in 6 of 8 runs: the fault-bit test 4 times, the never-returns test twice and the slow-port test once. (Under 40 loops it passed 4 of 4.)

## Verification

See the end of this file for the results recorded when the work was finished.

## Not covered, and doubtful tests left alone

- A test that sleeps and then asserts that nothing happened (`a_dead_sender_does_not_forget_an_open_that_is_still_running`, 150 ms) can pass for the wrong reason but cannot fail from load; left as it is.
- `src/editor/midi-capture.test.ts` ("places eight pitches on twelve strings") asserts the search takes under 500 ms twice. It is a performance budget on pure CPU work and could fail on a very slow runner.
- `src/audio/NativePlaybackController.test.ts` asserts 200 active-note queries take under 1000 ms.
- `src-tauri/tests/midi_in.rs` asserts `stop` returns in under 2 s, and a rate bound from elapsed seconds. The matching unit tests in `midi_in.rs` were made deterministic earlier today; these integration tests were not changed.
- The Vitest freeze applies to the capture `describe` only. Other describes in `App.test.tsx` that depend on real time were not audited.
- Load here was synthetic (busy loops on one machine); no CI runner was reproduced.

## Changes made after review

- **`with_clock` is test-only.** `MidiOut::with_clock`, the `manual_clock` field and the branch in `now()` are `#[cfg(test)]`; a production build uses `Instant::now()` exactly as before (`cargo check --lib` shows no new warning).
- **Gate guard.** The hang guard (`GUARD`, and `wait_for` / `settle`) is now 600 s, so a slow test can no longer have its held open released or its wait failed by the guard. It only stops a hung test binary. **Coverage lost:** the old `< 100 ms` assertions would also have caught a stall of, say, one second inside `ensure_ports` that has nothing to do with the open (a lock held across a driver call). Now such a stall passes as long as the open itself is not waited for. The remaining proof that nothing waits on the driver is that the slot is still `opening` after the call returns while the gate is held, and that the other port opens and the notes go out while it is held.
- **Product fix, `src/App.tsx` (`drainEntry`).** The 2 s rule was judged on the oldest item, so a key typed just now was thrown away with chords that had waited too long, which contradicts the rule that a flooding device cannot keep typed keys out. Each item is now judged by its own age. A stale chord is dropped and counted in `notWritten`. A stale typed key is dropped with the existing notice, which counts only the keys dropped. A typed key behind a stale typed key is also dropped, as before, because it assumed that key landed (one gesture is one edit, no hole in the music); a fresh typed key behind only stale chords stays and is written. Items still young stay in order. A queue of typed keys alone behaves as before; the `entry key queue` tests pass unchanged.
- **New tests** in `MIDI capture in the score`, with the clock moved by hand: stale chords plus a fresh typed key (key written, 2 chords counted, no notice); and everything stale (2 chords counted, notice says 1 key). Both failed before the `App.tsx` change (the key was thrown out, and the notice counted every item).
- **`src/editor/midi-capture.test.ts`.** The 500 ms bounds on the fingering search are replaced by a bound on work: `lastFingeringSearchNodes()` (new, exported from `midi-capture.ts`) must be at most `NODE_LIMIT + 1`. The clock is kept only as a 60 s hang guard.
- **`src-tauri/tests/midi_in.rs`.** The 2 s bound on `stop` after a million messages is a 60 s hang guard; the assertion that it returns, and that the driver was closed once, stays.

## Results

- `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check`: clean. `npm run typecheck`: clean.
- `cargo test --locked --lib midi_out`: 83 passed, 5 of 5 runs alone; 8 of 8 runs under 150 busy `node` loops (up to 18.6 s per run). The old code failed 6 of those 8 under the same load.
- `npx vitest run src/App.test.tsx`: 283 of 283 alone (340 s), 283 of 283 under 28 busy loops (871 s). One earlier alone-run had 1 failure out of 283 that was not identified (the output was truncated to its last lines); the capture describe passed 18 of 18 when run by itself, and the next full run passed. That failure is unexplained and may be a further load-sensitive test in this file.
- Full `npm test`: 402 files and 7037 tests passed, 8 skipped. The `plan.performance` snapshot was restored with `git checkout --`.
- After the review changes: `cargo fmt --check` clean; `--lib midi_out` 83 passed in 3 of 3 runs; `--test midi_in` 4 passed; `npm run typecheck` clean; `npx vitest run src/App.test.tsx src/editor/midi-capture.test.ts` 310 of 310 in 2 of 2 runs; full `npm test` 7039 passed, 8 skipped (snapshot restored). These runs were not repeated under CPU load.

## Three more tests that timed out at 5 s under load (2026-11-14)

**`src/interchange/midi-import.test.ts`, "fills every bar exactly for random unquantized playing under every option".**
- **Cause: the amount of work, not randomness and not the importer.** The generator was already seeded (a linear congruential generator, seed 7), so it was reproducible. The test took 2.5 s alone: 120 rounds, each importing 40 random notes and then writing the score to a `.gp` file and reading it back. Across 20 seeds the total time was 2.0 to 2.4 s, of which the importer was 19 to 27 ms, the export about 1.0 s and the read about 1.0 to 1.3 s. No round was an outlier (worst 49 to 119 ms), so there is no super-linear case. On a loaded machine that is a few times 2.5 s, over the 5 s default (reproduced: the unchanged test timed out at 5000 ms under 56 busy loops).
- **Change:** the clock check of every bar runs in all 120 rounds, and the file round trip in every seventh round (18 of 120; 7 is coprime to 3, 4 and 5, so it meets every option combination). The test now takes about 0.45 s alone. The seed and round are named in the failure message (`SEED=7, ROUND=n, options ...`) so a failure replays. The 60 s timeout is a hang guard.
- **A finding, not changed:** with other seeds (1, 4, 5, 12, 15 and 16 of 20) one round in 120 is refused with `A rhythm in this file could not be placed on the tuplet grid.` Seed 7 happens to avoid it. It is a plain `Error` that the import path reports, so it may be a deliberate refusal for such input; whether random unquantized playing should always import is a product question, and the test's claim (every imported bar is filled exactly) holds only for the seed it runs. Nothing was fixed or hidden.
- **Protection of the import path:** `readMidiFile` refuses files over 8 MB, over an event budget and over `MIDI_NOTE_LIMIT` notes; the importer limits measures and parts. These bound size, not time, and no input in these runs showed super-linear cost.
- **Neighbours:** the other random test in the file (seed 3, 300 corruptions of a small file) is seeded and fast. No other file in `src/interchange` uses random input.
- **Also in this file:** "keeps drums and second voices through a Guitar Pro round trip" (1.3 s alone, the first export and read in the worker) timed out at 5 s under load. The two round-trip tests now have a 30 s hang guard.

**`src/compatibility.test.ts`, the Guitar Pro 7 file ("imports known frets... guitarpro7-notes.gp") and `src/export/pdf.test.ts`, "preserves the mixed Unicode title...".** Each takes about 1 s alone even when run on its own, because it is the first use of heavy code in the worker (the importer for the GP7 container; the bundled fonts and the first full render). That work is legitimate and not super-linear, so these tests only needed the explicit 30 s timeout that other heavy tests already use, as a hang guard. Which of the five compatibility tests timed out was not recorded, so all five of the loop's cases have the limit.

**Verification.** The three files together: 86 of 86 in 3 of 3 runs alone (2.3 to 3.0 s), and 86 of 86 under 28 busy loops (29 s). An earlier run under 56 loops, before the round-trip test had its limit, showed the 30 s limit itself being exceeded for two tests (a 30-fold slowdown), which is the point at which a hang guard and a load test can no longer be told apart.
Full `npm test` after these changes: 404 files, 7087 tests passed, 8 skipped (snapshot restored); `npm run typecheck` clean.

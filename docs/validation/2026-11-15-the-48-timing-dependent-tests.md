# THE-48: tests that depended on how fast the machine was (2026-11-15)

Branch `agy/the-48-flaky-tests` (from `develop` 13922ef). Two tests failed now and then on the macOS CI runner (slow, shared) and passed everywhere else, with no product
change between a pass and a fail. Both turned out to measure wall-clock time. The macOS runner itself was not run here; CI is the proof. Everything below ran on one
Windows machine that other agents were also using.

## 1. Front end: the two-digit fret tests in `src/App.test.tsx`

### What the product does

A typed digit writes that fret at once. A second digit within 1000 ms joins the two (the first write is undone, the joined fret written, one undo step); a failure puts the
first digit back and says so. The time sources involved, all in `src/App.tsx`:

- `performItem(item, at)`: the key's time `at` is `Date.now()` when the key is pressed, or when it was queued behind an edit in flight. The join needs
  `at - run.at <= FRET_DIGIT_WINDOW_MS`.
- The entry queue's stale rule, `ENTRY_QUEUE_STALE_MS` (2000 ms), is judged with `Date.now()` at enqueue and at drain.
- The hint for a second digit (`pendingFret`) ended with a real `setTimeout` of 1000 ms, which also cleared `fretRun`. That is a second, separate clock.
- The tests' key events are `fireEvent.keyDown`; the product does not read the event's `timeStamp`.

So the join was decided by two clocks: `Date.now()` (frozen or driven by the test in the entry-queue block only) and a real timer.

### Root cause, with evidence

1. The `GP8 edit and cursor keys` block did not freeze `Date.now()`. With a clock that advances 300 ms per read (a simulated slow runner) six tests failed, with the
   same messages as macOS CI: `expected { type: 'setNote', … } to match object { fret: 12 }`, `to have a length of 3 but got 5` (the second digit became a fret of its own), and
   `Unable to find an element with the text: /first digit was put back/`. Two entry-queue tests in the same block failed too (`expected [] to have a length of 1`), because a
   queued key had aged past 2000 ms.
2. Freezing `Date.now()` was not enough: `turns 1 then 2 into fret 12` still failed 4 times in 4 with `length 3 but got 4`. A probe in `typeFretDigit` showed the cause:
   the window timer fired after 1202 to 1483 real milliseconds (the machine was busy) and cleared `fretRun` before the second digit was performed, so `here` was false
   and `run` was null. The first edit simply took longer than a real second to land.
3. A third dependence, in the tests: while the hint for a second digit is on screen it hides the notice that explains a failure (`pendingFret !== null ? hint : notice`).
   `puts the first digit back…` and `says why a digit cannot write…` waited for the notice with `findByText`'s default 1000 ms timeout, racing the 1000 ms hint timer that had
   been armed a moment earlier. They passed only when the machine was fast enough to leave a margin.

### What changed

- `src/App.tsx`: the hint's window now closes by the clock the join uses. `closePendingWindowAt(end)` arms the timer, and when it fires it compares `end` with
  `Date.now()`; if the clock has not reached `end` it waits for the rest. For a real user the clock and the timer agree (a timer that fires a millisecond early waits that
  millisecond), so the window is still 1000 ms measured from the digit and the stale rule is untouched. The timer only wakes the check.
- `src/App.test.tsx`, block `GP8 edit and cursor keys`: `Date.now()` is frozen in `beforeEach` and moved only by `later(ms)`, as the `entry key queue` block already did. The
  tests that depend on a gap set it: the notice tests call `later(1000)` before waiting (the `timeout: 5000` there only covers the real second the timer takes to look; it
  does not decide the outcome), `the window closes` test does the same, and the old test for a digit after the window uses `later(1500)`.
- New tests: a second digit exactly 1000 ms after the first joins and one 1001 ms after does not (the gap is set, not raced), and a second digit joins when 1300 real
  milliseconds pass but the clock has not moved (the failure above, kept as a regression test). The stale rule (2500 ms) already had its tests in `entry key queue`.
- The other entry and typing tests were checked. `entry key queue` and `MIDI capture in the score` already freeze the clock. `click to seek and Space to play` uses a 5 s
  pending window against tests that finish in milliseconds and only assert that nothing happened; left as they are. `src/editor/**` has no typing tests with a clock;
  its `performance.now()` uses are generous budget checks (60 s, 20 s, 5 s), not behaviour.

## 2. Rust: `line_in::tests::a_tone_flows_from_capture_to_the_output_at_the_expected_level`

### What it protects

The whole path of a Line-In tone: the level through the chain (peak 0.35 x 0.8, input and output meters), the frequency through the drift-correcting resampler, the
latency report (8 to 80 ms), and the detach on stop. It ran a capture thread that paced a tone by `Instant::elapsed()` and a test thread that pulled the output by
`Instant::elapsed()` too, three attempts, and counted periods in the last real second.

### Root cause

Both sides ran on the scheduler. A capture thread that is not scheduled for a few hundred milliseconds leaves a gap: the ring runs dry (an underrun), the output goes
silent, and the last second holds fewer periods. `only 89 periods in the last second` is that. The retries only helped when the scheduler happened to give three quiet
seconds. The test's own comment said so.

Reproduced deterministically, on the new simulated version: leaving the capture side idle for 300 ms of simulated time makes the status read `underruns: 1` (and 600 ms
the same), with no real waiting. A clean simulated run reads 0 for underruns, skips, drops and resets.

### What changed (`src-tauri/src/line_in.rs`)

- `pace_tone(synth, producer, produced, elapsed)`: the capture thread's tone pacing, extracted unchanged except that the elapsed time is passed in. The thread still passes
  `started.elapsed()`. Only `cfg(any(test, feature = "desktop-test"))` code moved; the audio callback, `audio/line_in.rs` and the device path are untouched.
- `Source::Driven` and `Live::Handed` (both `#[cfg(test)]`): the capture thread opens at once, hands its `LineInProducer` to the test over a channel and only holds the
  session open. The session, attach, status and stop are the real ones.
- The test now plays both sides on one simulated clock: every 5 ms of simulated time it feeds the capture side (every second tick, as the 10 ms poll did) and renders the
  output for the frames that time says are due, for 8 simulated seconds (the controller settles in about 4). Nothing waits and nothing is retried. Measured: 219 periods in
  the last second, pitch 0.03 cents off 220 Hz, latency 31.1 ms, input -9.12 dBFS, output -11.06 dBFS.
- Assertions kept: peak within 0.02 of 0.28, input level within 1 dB, output level within 1.5 dB, latency 8 to 80 ms, running with no error, rates, stop, not running,
  detached. Tightened because the run is now clean: the periods must be 218 to 221 (was at least 100), the pitch within 1 cent (was 20 cents, which allowed for starved runs;
  `drift_correction_keeps_the_pitch_true_in_real_time` holds a drifting device to 1 cent, also simulated), and underruns, skips, drops and resets must all be 0 (new).
- A small real-time test, `a_real_time_tone_starts_passes_audio_and_stops`, keeps the real thread covered: it starts the real-time tone source, waits for the output meter
  to leave silence, checks the status and rates, stops, and checks it is not running and detached. No period count, pitch or timing threshold. `wait_for` has a 10 s
  deadline, which only ends a hang.

### The three lib tests that failed under load

- `plugin_tick_tests::a_new_device_rate_starts_the_plug_ins_at_it` and `…::the_first_open_stream_starts_the_plug_ins` (the two that failed when 56 busy loops were run beside
  `cargo test`; reproduced at `runtime.rs` lines 1840 and 1848): the same kind of dependence. `Tick::launches()` slept a fixed 100 ms and then read the rates the fake
  launcher had recorded, but the launch runs on its own thread. Fixed: `launches()` waits until no slot of the document is `Loading` (the service marks a launch Loading
  before it spawns the thread), with a 60 s hang deadline.
- `audio::device::tests::invalidate_does_not_wait_for_preparation_mutex` did not fail in my reproduction, but it asserts that a thread scheduled and finished within 100 ms,
  the same dependence. A command that blocked on the control mutex would wait for ever (the test holds it), so the answer does not need a tight deadline: it now waits up to
  30 s and the outcome is the same.
- The two paused-tick tests (`a_document_switched_away_during_a_tick…`, `a_document_closed_during_a_tick…`) slept 200 ms inside the tick and hoped the test thread acted
  within that. They now block on a channel the test releases after it has acted, and the closed-document check polls for the shutdown instead of a 100 ms sleep. `wait_for_slot`
  (`plugins/service.rs`) had a 2 s deadline for a launch; it is now a 60 s hang deadline. `an_undo_during_a_reprepare…` still sleeps 300 ms: its action blocks on the lock the
  paused tick holds, so there is nothing to wait for; it cannot fail from slowness (the order it tests just becomes less likely to be exercised) and is left alone.

## Verification

Run on this machine, with other agents building and running in parallel.

| Check | Result |
|---|---|
| `npm run typecheck` | passes |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | passes |
| `src/App.test.tsx`, the two blocks changed (`GP8 edit and cursor keys`, `entry key queue`), 20 runs in a loop while a full `npm test -- --testTimeout=60000` and a Rust loop ran beside it | 20 of 20 passed |
| `src/App.test.tsx`, whole file, once | 337 passed (532 s under load) |
| `npm test -- --testTimeout=60000`, whole suite, while the loop above ran | 7363 passed, 8 skipped, 422 files passed, 5 skipped (870 s) |
| `cargo test --locked --lib -- line_in invalidate_does_not_wait plugin_tick_tests`, 20 runs in a loop, with the full `npm test` and the Vitest loop running | 20 of 20 passed on the final code (an earlier loop on the commit before the last fix passed 19 of 20: see below) |
| Same 61 tests with 56 busy loops (2 per core) running: before the change | 2 failed (the two `plugin_tick_tests`); after: 18 of 18 passed three times in a row |
| `cargo test --locked --workspace --no-fail-fast` | 2050 passed, 0 failed (exit 0) |

`plan.performance.test.ts.snap` changed during the full run and was restored with `git checkout --`.

A first 20-run Rust loop failed once (iteration 8) in the new `a_real_time_tone_starts_passes_audio_and_stops`: the input and output levels are the peak since the previous
status call, and the test read the input peak in an earlier call than the output peak. That was a bug in the new smoke test, not a timing threshold; it now remembers having
heard the input across calls. The loop was then repeated on the final code and passed 20 of 20. The Vitest loop and the workspace run were made on commits that still held a
debugging probe in the line-in test (an environment variable that was unset, so it had no effect) and the smoke-test bug; the workspace run (2050 passed, 0 failed) was not
repeated after those two fixes, and the full `npm test` does not touch Rust.

## Limits

- macOS was not run. The macOS failures were matched by signature and cause (the same assertion messages from a simulated slow clock, and a real timer longer than the join
  window), not by reproducing them on macOS.
- The 20-run Vitest loop covers the two blocks that were changed, not the whole file 20 times (one whole-file run takes 9 to 15 minutes here).
- The 5 s hang-detector deadlines and the `timeout: 5000` waits in the new front-end tests are real-time waits for a 1 s timer; a runner that is stalled for over 5 s would
  still fail them.
- The window timer still fires after a real second, so the notice tests and the window-closes test take about a second each.
- `an_undo_during_a_reprepare_is_not_undone_by_it` is unchanged (above). The `performance.now()` budget tests in `src/editor` and `lyric-*` are unchanged; their limits are loose
  on purpose.

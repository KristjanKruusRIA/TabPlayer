# GP8 MIDI input, slice 1 (THE-70, tracker rows U16 and U17)

Date: 2026-11-13. Branch `agy/the-70-midi-capture`, uncommitted at the time of writing. Design: `docs/superpowers/specs/2026-11-13-midi-note-capture-design.md`.

## Scope

Slice 1 only: a session-scoped MIDI input service that delivers chords to the page, a View-menu panel (input, Start/Stop, chord window, velocity floor, last-chord readout, status), and a toolbar badge. **Nothing is written into the score.** U16 (capture into the selected beat) and U17 (channel-to-string mapping, grouping threshold) are not done; the tracker rows are not moved.

## What was built

- `src-tauri/src/midi_in.rs`: `MidiInBackend` and a midir backend, a pure `ChordGrouper` with an injected clock, a rate limit, session numbers, loss detection, the commands and the `midi-in-chord` and `midi-in-status` events, and the desktop-test-only injection port (`TABPLAYER_MIDI_IN_TEST=1`).
- `src/audio/midi-in.ts`, `src/editor/midi-capture-preferences.ts`, `midi-capture-session.ts`, `MidiCapturePanel.tsx`; `midi_in.*` text in en, et and de; `tests/desktop/parity-midi-in.mjs`.

Consent: listing opens no port and happens only when the View menu is opened or Refresh is pressed; the listing client is made when the MIDI input section is opened or Refresh is pressed; a port opens only on Start; capture is off at every launch; only the port name and three settings are stored; nothing about played notes is logged.

## Evidence (2026-11-13, Windows, this worktree)

| Check | Result |
|---|---|
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib midi_in::` | `43 passed; 0 failed` (three runs) |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | `947 passed; 0 failed; 7 ignored` |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --test midi_in` | `4 passed; 0 failed` |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --features desktop-test --lib` | finished, no warnings |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | clean |
| `npm run typecheck` | no errors |
| `npm test` | `Test Files  390 passed | 4 skipped (394)`, `Tests  6797 passed | 8 skipped (6805)` |

The Rust tests use a fake driver: grouping (window, extension, span cap, 8-note cap, dedup, velocity floor, rate bucket), start, stop, stale stop, failed open, an open that never returns, a stop during an open, loss, a failed listing, a million-message flood that stays bounded (drops counted, worker responsive), and malformed messages. Timing-dependent tests use a clock the test moves, channels and gates; the remaining waits are hang guards.

## Not verified

- No real MIDI device was opened on any operating system. The path from the driver callback is exercised only through a fake backend and the desktop test port, which call the same sink and bypass midir.
- `tests/desktop/parity-midi-in.mjs` is written and syntax-checked, **not run**.
- Unplug detection is a once-a-second port listing, two misses in a row; tested with a fake backend only.
- The 60 ms default and the gap-based window are not measured on real playing.
- Whether Tauri accepts the commands and events without a capability entry is as designed but not run in the app.
- macOS and Linux are untested; see the limits below.

## Limits

- Capture is not blocked while the transport plays.
- Same-named devices are not told apart; the watchdog misses the unplug of one of two.
- macOS: the listing client is made on a thread without a run loop, so the list may not update after a replug.
- Linux: ALSA port names embed client numbers, so a remembered port may show as not connected after a replug.
- An open the system never answers keeps a thread and a sink until it returns and cannot be cancelled. Starts for that port are refused meanwhile (a Start for another port is allowed; at most 4 opens may be outstanding in all), and after 30 s the message says TabPlayer must be restarted to use that port again.
- A listing the driver never finishes makes later Refreshes fail with "still in progress" and the watchdog skip its tick; a watchdog thread stuck inside the driver stays stuck.
- U17 will be verified with injected messages only (slice 3).

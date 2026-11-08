# tabplayer-plugin-host

The VST3 plug-in host helper (THE-71): one plug-in per process, run out of process so that a crash or hang in third-party code never takes the app with it. The app speaks to it with the `tabplayer-plugin-protocol` crate. On Windows the helper hosts the plug-in through a vendored extract of SoundCraft's FFI (`src/vst3/`, see its `NOTICE.md`); on other platforms it is a stub that answers every request with `UnsupportedPlatform`.

## The conversation

- The first frame on stdin is `Probe` (answered with `Probed`, then exit 0; an `Error` is followed by exit 1) or `Load` (answered with `Loaded`). Stdin closing means exit 0.
- **Every request gets exactly one reply**, in the order the requests were sent: a result (`State`, `EditorOpened`, `EditorClosed`), `Done` (for `SetState` and `SetParameter`) or `Error`. `Shutdown` has none; the helper ends. An unparseable frame is answered with `Error { BadRequest }`, and a request the helper has no room for while its main thread is busy with `Error { Busy }` (nothing was done; ask again), each in its turn. `Shutdown` is never refused for lack of room.
- **One `Error` answers no request:** when the plug-in can no longer be run (a reconfigure it asked for fails, or leaves a different audio layout), the helper sends an `Error` and exits with code 4. A router must accept an `Error` with nothing pending, or charge it to the request at the head of its queue, and then expect the exit.
- **After a reconfigure the helper sends `LatencyChanged`** with the latency that follows, even if the value did not move, so that the app flushes and primes rather than finding an unexplained gap. Reconfigures are rate limited to about one a second; announcements made meanwhile are coalesced into the next one.
- `StateDirty` and `LatencyChanged` are unsolicited and rate limited (at most 4 and 10 a second). `EditorClosed` is both the reply to `CloseEditor` and an unsolicited message when the user closes the window, so a receiver treats a repeat as harmless.
- A state the plug-in produces that does not fit the container is `Error { StateTooLarge }` and is never sent, even when the plug-in itself reported success.

## Exit codes

0 for a closed pipe or `Shutdown`; 1 for a failed load or probe or a broken pipe; 3 for a panic in the helper's own code; 4 for a plug-in that could not be reconfigured. **Any other nonzero exit is a failure of the plug-in's code**, and the app should treat every nonzero exit as `Crashed`.

## Limits

- **Only Rust panics are caught.** A C++ exception or a structured-exception fault (an access violation, say) coming out of plug-in code is not caught: the process ends with the system's exception code, not 3. The helper sets `SEM_NOGPFAULTERRORBOX` and Windows Error Reporting's no-UI flag at start, so this is a prompt exit and not a dialog or a wait for a dump.
- **The helper ends through `TerminateProcess`.** It runs the plug-in modules' exit functions (`ExitDll`) first, but it does not run `DllMain(DLL_PROCESS_DETACH)` or C++ static destructors. A plug-in that flushes preferences, a licence cache or a log there loses that work. This is deliberate: with `ExitProcess`, a plug-in whose detach hangs (SLAMP does) hangs the helper, with every other thread already killed and no watchdog left. State the app needs is saved with `GetState` before `Shutdown`, and every reply owed before `Shutdown` is on the pipe by then, because replies are written and flushed in order.
- **`kReloadComponent` reconfigures; it does not reload.** The helper deactivates the plug-in, sets it up again with the same layout and activates it, with the audio loop parked. It does not save the state, create a new instance and restore it. `kIoChanged` and `kLatencyChanged` take the same path. Announcements a plug-in makes from inside the helper's own reconfigure are covered by the latency read afterwards and do not start another. A plug-in whose bus layout differs afterwards ends the helper (exit 4, `UnsupportedLayout`).
- **Plug-in output is dropped:** output parameter changes, and events (no MIDI or note events are sent to a plug-in).
- **The probe lists a class only if its sub-categories include `Fx`.** A class from a version 1 factory (no sub-categories) is not offered.
- **No affinity or power-throttling control** for the audio thread (Spike 2, finding 3).
- **Editor.** The window is unowned and unparented, per-monitor DPI aware v2 (Spike 4). A DPI change is applied on the helper's next 50 ms tick. It is checked in process, not by moving a window between real monitors.

## For the app

- Give the helper non-inheritable duplicates of the ring and the events where you can, and start it with its own folder as the current directory. (The helper takes the inherit flag off every handle it is given and removes the current directory from the DLL search path, so this is a second line of defence.)
- `Loaded.latency` is read after the load state has been applied. A later change comes as `LatencyChanged`, and the app re-prepares.
- A helper whose heartbeat has not moved for 500 ms while blocks are pending is hung. The helper stops beating if a reconfigure parks the audio loop for more than 10 seconds.

## Tests

```text
cargo test --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host
cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin
cargo test --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -- --ignored
```

The first runs the unit tests. The ignored tests need both binaries built (preflight ruling P7): the end-to-end tests in `tests/helper.rs`, and two unit tests that load the test plug-in into the test process (the audio thread never allocates, a DPI change reaches the view). `TABPLAYER_TEST_REAL_PLUGIN=<path to a .vst3>` points `real_plugin_smoke` at a plug-in you have installed.

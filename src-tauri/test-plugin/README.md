# TabPlayer Test Gain

A VST3 plug-in for TabPlayer's own tests. It is not shipped and it is not a product: the plug-in helper, the client and the end-to-end tests load it to exercise state, latency, the editor and every way a plug-in can misbehave.

## What it does

A stereo gain with an exact delay. The output is the input times the gain, delayed by exactly the latency in frames, and `getLatencySamples` reports that latency. Whenever the latency changes, the plug-in calls `restartComponent(kLatencyChanged)` on the host's handler, once a handler is set. That covers every way it can change: the controller's `setParamNormalized`, the processor's parameter queue in `process`, and `setState`. It remembers the latency the host last read with `getLatencySamples` (or was last told) and announces a latency that differs, so the order in which a host delivers a parameter does not matter. The call comes from the thread that made the change, with no lock held, so a host that re-reads `getLatencySamples` from inside it sees the new value. A latency loaded before a handler exists is not announced; the host reads it anyway. `setProcessing(false)` clears the delay line.

It is one class that is both the component and the edit controller, so a probe sees exactly one class: `TEST_CLASS_ID`, named "TabPlayer Test Gain".

The controller's `getState` writes five bytes: the `processMode` the host passed to `setupProcessing` (0 realtime, 1 prefetch, 2 offline), then how many times the component has been activated (`setActive(true)`), as a little-endian `u32`. The component's state is the record described below.

## Parameters

| ID | Name | Normalized value |
|---|---|---|
| 0 | Gain | the gain, 0 to 1 (default 1); a state can carry any finite gain |
| 1 | Latency | frames / 48,000, one step per frame (at most one second) |
| 2 | Mode | one step per mode: Normal, Crash, Hang, NaN, Slow, Hang on load, Reject state, Fail process, Fault |
| 3 | Edits | how many edits the editor has reported, over 1,024 |

Slow takes 50 ms through the parameter. To choose another length, set the state: `Slow { ms }` is part of it.

## Modes

- **Crash**: the next `process` call ends the process at once with a fatal exception code (`0xC0000409`). On Windows it uses `TerminateProcess`, so Windows Error Reporting does not run and delay the exit; elsewhere it aborts.
- **Hang**: the next `process` call never returns.
- **NaN**: every output sample is NaN.
- **Slow**: every `process` call takes at least `ms` milliseconds.
- **Hang on load**: `setState` never returns once it has read a state with this mode.
- **Reject state**: `setState` returns `kResultFalse`, and so does a state that carries this mode.
- **Fail process**: every `process` call returns `kResultFalse` and writes nothing.
- **Fault**: the next `process` call crashes for real, with an access violation (`0xC0000005` on Windows), so the system's own crash handling runs: Windows Error Reporting, with its dialog switched off by a host that hardened its process. Use it to show that a crash ends a hardened host promptly with the real exception code, rather than raising a dialog or stalling the exit. It does not by itself prove the hardening is the cause, since no test runs the host unhardened; use **Crash** where a test needs the process gone at once.

## State

The component state is a 23-byte record (`encode_test_state`) followed by `padding` zero bytes, so `padding` sets the size. `decode_test_state` reads it back and refuses anything malformed, including a tail that is not all zeros. A state of any size is therefore one `TestState { padding, .. }` away. `decode_test_state` also refuses an edit count over 1,024. `setComponentState` on the controller only checks that a state decodes; it never applies it, and the component's `setState` is the only way a state gets in.

To make the plug-in produce a large state on its own, for a host that cannot send one in (the helper refuses anything over 8 MiB), set `TABPLAYER_TEST_PLUGIN_STATE_PADDING=<bytes>`: `getState` then writes at least that much padding. It is held to 16 MiB (16,777,216), so `9437184` gives a 9 MiB state.

## Factory

The factory implements `IPluginFactory2`: the class reports the subcategory `Fx`, version `1.0.0` and vendor `TabPlayer`. It does not set `kUnicode`, because that promises `IPluginFactory3`.

## Editor (Windows)

`createView("editor")` returns an `IPlugView` holding one child static window, 300 by 200 at scale 1. It also takes `IPlugViewContentScaleSupport`: after `setContentScaleFactor(f)` the view's size and its child window are `f` times that, so a host's DPI handling can be seen. When it attaches it reports one edit on parameter 3 through `beginEdit`, `performEdit` and `endEdit`. Other platforms have no editor and return no view.

## Environment variables

They are read inside the process that hosts the plug-in.

- `TABPLAYER_TEST_PLUGIN_HANG_FACTORY=1`: `GetPluginFactory` blocks forever.
- `TABPLAYER_TEST_PLUGIN_STATE_PADDING=<bytes>`: `getState` pads the state to at least this much padding, at most 16 MiB.
- `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1`: the editor does not report an edit when it attaches.
- `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=<n>`: the editor blocks its thread for `n` milliseconds after it attaches.
- `TABPLAYER_TEST_PLUGIN_VIEW_MODAL_MS=<n>`: the editor runs a nested message loop on its thread for `n` milliseconds after it attaches, as a modal licence dialog does: window messages are dispatched and thread messages are dropped.
- `TABPLAYER_TEST_PLUGIN_ANNOUNCE_ON_ACTIVE=1`: `setActive(true)` calls `restartComponent(kLatencyChanged)` whether or not the latency changed, as plug-ins do that work it out in their own set-up. A host that re-activates the plug-in in answer would loop.
- `TABPLAYER_TEST_PLUGIN_ANNOUNCE_EVERY_BLOCK=1`: every `process` call does the same, from the audio thread.
- `TABPLAYER_TEST_PLUGIN_IGNORE_WRITE_FAILURE=1`: `getState` returns `kResultOk` even when the host's stream refused a write, as plug-ins that write without checking do.
- `TABPLAYER_TEST_PLUGIN_PRINT=1`: the plug-in prints on load and on every block, through Rust's standard output and error and through the C runtime's `puts`. A host must keep that off its control pipe.

## Build

```powershell
cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-test-plugin
```

The library is `src-tauri/target/debug/tabplayer_test_plugin.dll` on Windows, `libtabplayer_test_plugin.so` on Linux and `libtabplayer_test_plugin.dylib` on macOS. A host that wants a `.vst3` file can copy it under that name. The crate is also an `rlib`, so tests can use `TEST_CLASS_ID` and `encode_test_state` without loading anything; the app takes it as a dev-dependency only, never a normal one.

## Origin and licence

The COM plumbing (the class, the factory, the entry points and the bus code) is derived from `examples/gain.rs` in the [`vst3`](https://github.com/coupler-rs/vst3-rs) 0.3.0 crate by Micah Johnston, which is licensed MIT OR Apache-2.0. This crate uses it under the MIT licence and keeps the licence text in the header of `src/lib.rs`. The rest, including the delay, the state codec, the modes and the editor, is TabPlayer's, under the MIT licence of this crate.

## Tests and their limits

`cargo test -p tabplayer-test-plugin` runs the pure unit tests and an in-process COM test (`com_tests`) that drives the factory, a plug-in instance, a Rust `IBStream` and a Rust `IComponentHandler`, with no library loaded. It is written for Windows, macOS and Linux and covers the restart, `RejectState`, the padding size, `setProcessing(0)` and `setComponentState`. It has only been run on Windows. The bindings differ by platform in three ways: the enum type (which sets the width of every enum, including the seek mode), the byte order of class IDs, and result-code values. The test casts the seek mode to its own type and uses only named constants, so it depends on none of these.

The tests read the process environment through the plug-in, so they expect `TABPLAYER_TEST_PLUGIN_HANG_FACTORY` and `TABPLAYER_TEST_PLUGIN_STATE_PADDING` to be unset: the first hangs every COM test, the second changes the state sizes they check.

Not covered by any automated test:

- **The split component and controller.** This plug-in is one class that is both, so the usual path of real plug-ins (two classes, a controller created from `getControllerClassId`, the two joined with `IConnectionPoint`) is not exercised here. A host that supports only that path will not work with it.
- **`Crash`, `Hang`, `Slow` and `HangOnLoad`**, which end or stall the process they run in, and the editor with its environment variables. Task 8's and later tests run those against the built library.

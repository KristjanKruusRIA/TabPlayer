# TabPlayer Test Gain

A VST3 plug-in for TabPlayer's own tests. It is not shipped and it is not a product: the plug-in helper, the client and the end-to-end tests load it to exercise state, latency, the editor and every way a plug-in can misbehave.

## What it does

A stereo gain with an exact delay. The output is the input times the gain, delayed by exactly the latency in frames, and `getLatencySamples` reports that latency. Changing the latency through the controller calls `restartComponent(kLatencyChanged)`. `setProcessing(false)` clears the delay line.

It is one class that is both the component and the edit controller, so a probe sees exactly one class: `TEST_CLASS_ID`, named "TabPlayer Test Gain".

## Parameters

| ID | Name | Normalized value |
|---|---|---|
| 0 | Gain | the gain, 0 to 1 (default 1) |
| 1 | Latency | frames / 48,000, one step per frame (at most one second) |
| 2 | Mode | one step per mode: Normal, Crash, Hang, NaN, Slow, Hang on load, Reject state |
| 3 | Edits | how many edits the editor has reported, over 1,024 |

Slow takes 50 ms through the parameter. To choose another length, set the state: `Slow { ms }` is part of it.

## Modes

- **Crash**: the next `process` call aborts the process.
- **Hang**: the next `process` call never returns.
- **NaN**: every output sample is NaN.
- **Slow**: every `process` call takes at least `ms` milliseconds.
- **Hang on load**: `setState` never returns once it has read a state with this mode.
- **Reject state**: `setState` returns `kResultFalse`, and so does a state that carries this mode.

## State

The component state is a 23-byte record (`encode_test_state`) followed by `padding` zero bytes, so `padding` sets the size. `decode_test_state` reads it back and refuses anything malformed, including a tail that is not all zeros. A state that is more than a few kilobytes is therefore one `TestState { padding, .. }` away.

## Editor (Windows)

`createView("editor")` returns an `IPlugView` holding one child static window, 300 by 200. When it attaches it reports one edit on parameter 3 through `beginEdit`, `performEdit` and `endEdit`. Other platforms have no editor and return no view.

## Environment variables

They are read inside the process that hosts the plug-in.

- `TABPLAYER_TEST_PLUGIN_HANG_FACTORY=1`: `GetPluginFactory` blocks forever.
- `TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT=1`: the editor does not report an edit when it attaches.
- `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=<n>`: the editor blocks its thread for `n` milliseconds after it attaches.

## Build

```powershell
cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-test-plugin
```

The library is `src-tauri/target/debug/tabplayer_test_plugin.dll` (`.so` and `.dylib` elsewhere). A host that wants a `.vst3` file can copy it under that name. The crate is also an `rlib`, so tests can use `TEST_CLASS_ID` and `encode_test_state` without loading anything; the app takes it as a dev-dependency only, never a normal one.

## Origin and licence

The COM plumbing (the class, the factory, the entry points and the bus code) is derived from `examples/gain.rs` in the [`vst3`](https://github.com/coupler-rs/vst3-rs) 0.3.0 crate by Micah Johnston, which is licensed MIT OR Apache-2.0. This crate uses it under the MIT licence and keeps the licence text in the header of `src/lib.rs`. The rest, including the delay, the state codec, the modes and the editor, is TabPlayer's, under the MIT licence of this crate.

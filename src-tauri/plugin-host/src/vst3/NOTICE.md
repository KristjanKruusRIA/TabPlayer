# Vendored code in this folder

The files `editor.rs`, `host.rs`, `instance.rs`, `mod.rs`, `module.rs`, `process.rs`, `scan.rs` and `window.rs` are
derived from the `vst3-host` crate of SoundCraft, <https://github.com/storytold/soundcraft>, commit `b6f9f15`
(`crates/vst3-host/src/ffi.rs`, `ffi/*.rs`, `ffi/window/windows.rs` and the bundle resolution of `scan.rs`). SoundCraft
is licensed MIT OR Apache-2.0; TabPlayer uses it under the MIT licence, whose text follows. The bundle resolution of `scan.rs`
now lives in `src-tauri/plugin-protocol/src/bundle.rs` (so the app and the helper share it), with the same attribution.

`queue.rs` is TabPlayer's own, under the licence of this crate.

TabPlayer's changes are marked `TabPlayer:` in the files. In short: the Windows extract only (no macOS or Linux code);
`MAX_STATE_BYTES` is TabPlayer's 8 MiB and the state container is the protocol crate's; the editor window is unowned
and unparented, sized for per-monitor DPI v2, and takes the keyboard focus (Spike 4); the processor side (`AudioPart`)
is split from the main-thread side (`Instance`); the host context is lock-free (a restart is an atomic flag and one
posted message, an edit goes through a bounded queue); parameter queues hold several points per block; a state past the
cap is reported as too large; the main thread is found by thread id and not by thread name; modules load with
`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS`.

## SoundCraft licence (MIT)

```
MIT License

Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The `vst3` crate, `com-scrape-types` and the Steinberg `pluginterfaces` that `vst3` is generated from are third-party
dependencies, not vendored here; their notices ship with the app (`legal/`, `scripts/copy-notices.mjs`).

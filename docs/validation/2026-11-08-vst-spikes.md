# VST spike 1: hosting core choice (THE-71), 2026-11-08

Task 1 of `docs/superpowers/plans/2026-11-08-vst-hosting.md`, under pre-flight rulings P21 and P22. Branch `feature/vst-hosting` at `f6bcc2a`. Windows 11 Pro (10.0.26300), display at 150 %.

## Result

**PASS. The hosting core is Rust.** The Rust host loaded and ran the unmodified `gain` example of `vst3` 0.3.0 and six real amp plug-ins, and every criterion held for the gain example and for five of the amps. P22 needs the gain example and at least two amps.

**The C++ arm was not run.** CMake is not installed, and the VST3 SDK 3.8.x fetch needs the user's approval (pre-flight §10). The controller ruled the arm out for this run. P22 then says: decide on Rust alone and record that. One question stays open because of it: whether the C++ SDK host would draw the two blank VSTGUI editors described below.

No state was over 1 MiB and no latency was over 100 ms, so nothing needs raising before Task 5.

## What was built

All of it is under `.analysis/vst-spikes/`, which git ignores. None of it is committed.

- **`host-rust/`** is a throwaway in-process host.
  - It holds SoundCraft's `crates/vst3-host/src/ffi.rs` and `ffi/{editor,host,instance,module,process}.rs`, plus `ffi/window/windows.rs`, copied from the local clone at `b6f9f15`. That is 2,357 lines including the added headers.
  - It also holds the bundle-resolution part of `scan.rs` (`Os`, `arch_dirs`, `bundle_binary`; 97 lines).
  - Each vendored file carries a header naming the source and the MIT OR Apache-2.0 licence, and SoundCraft's `LICENSE-MIT` sits next to the crate.
- **Changes to the vendored code:**
  - the `#[cfg(test)]` module is removed from `ffi.rs`;
  - `use soundcraft_dsp::Transport` becomes `use crate::soundcraft_dsp::Transport`;
  - `editor.rs` gained one experiment, off by default: show the window before `attached`.
- **Stubs (P22):** `Vst3Error`, with the same five variants and a hand-written `Display` instead of `thiserror`, and `soundcraft_dsp::Transport`, with the eight fields the FFI reads.
- **The driver** (`main.rs`) runs every measurement below in one process per plug-in, with a 120–180 s timeout. It enumerates the process's top-level windows with `EnumWindows` and saves a `PrintWindow` image of each editor.
- **`gain-example/`** builds `examples/gain.rs` from the crates.io `vst3` 0.3.0 package as a `cdylib`. The file is byte-identical (SHA-256 `cb28941b…3ff89`). Nothing was cloned or downloaded apart from crates.
- **Dependencies, pinned exactly:**
  - `vst3 =0.3.0` and its `com-scrape-types 0.1.1`;
  - `libloading =0.9.0`;
  - `log =0.4.35`;
  - `windows-sys =0.61.2`. SoundCraft's editor window needs it; it was already in the local cargo cache, and the app's lockfile already has it transitively.
- **Build:** `RUSTUP_TOOLCHAIN=1.90.0`, `CARGO_TARGET_DIR=E:/cargo-target/slot-1`, release profile.

## Plug-ins

Only plug-ins already installed in `C:\Program Files\Common Files\VST3` were used. No licence, activation or login dialog appeared in any run: no extra visible top-level window, and no dialog in the editor images.

| Plug-in | Vendor, version, SDK | Format | Editor toolkit |
|---|---|---|---|
| Gain (vst3-rs example plugin) | built from `vst3` 0.3.0 | single file | none |
| Ignite - Emissary | STL Tones 2.0.2, VST 3.6.12 | single file | VSTGUI |
| AtlasDSP DI Crank | AtlasDSP 1.0.0, VST 3.7.8 | single file | JUCE |
| SLAMP | Oracle Sound 1.2.0, VST 3.8.0 | single file | JUCE |
| Archetype Gojira X | Neural DSP 1.0.2, VST 3.7.2 | single file | JUCE |
| Amped - ML5 | ML Sound Lab 2.0.0, VST 3.7.2 | single file | JUCE |
| Toneforge Menace | Joey Sturgis Tones 1.5.2, VST 3.7.12 | bundle (`Contents/x86_64-win`) | JUCE |

Ignite - NadIR (an IR loader, not an amp) was also run to check the VSTGUI editor finding.

## Criteria per plug-in

The setup for every run was 48 kHz, 128-frame blocks, stereo main bus, 32-bit float, realtime mode. The input was 10 s (3,750 blocks) of a 220 Hz sine at 0.3 peak on both channels.

| Plug-in | Stereo main bus | 10 s finite, RMS | State round trip | Latency at load | Latency re-read after `kLatencyChanged` | Editor ×3, no window left | Verdict |
|---|---|---|---|---|---|---|---|
| Gain | in [2], out [2] | yes, −13.47 dBFS | identical | 0 | no such setting | n/a: `createView` returns null | **pass** (editor n/a) |
| Emissary | [2] / [2] | yes, −15.34 | identical | 6 | **yes**: Oversampling → 7, back → 6 | yes, but the content is blank (below) | pass as written; not counted |
| DI Crank | [2] / [2] | yes, −16.15 | identical | 256 | no such setting found | yes, drawn | **pass** |
| SLAMP | [2] / [2] | yes, −16.43 | identical | 0 | no such setting found | yes, drawn | **pass** |
| Gojira X | [2] / [2], event in | yes, −12.08 | identical | 36 | no such setting found | yes, drawn | **pass** |
| Amped ML5 | [2] / [2], event in | yes, −13.88 | identical | 0 | no such setting found | yes, drawn | **pass** |
| Toneforge Menace | [2, 2] (sidechain) / [2], event in | yes, −19.35 | identical | 0 | no such setting found | yes, drawn | **pass** |

What the columns mean:
- **Finite** means no NaN or infinity in 960,000 output samples, and every `process` call returned `kResultOk`.
- **State round trip** means get, set, get, compared byte for byte. Every plug-in gave identical bytes on the first round trip.
- **Latency re-read** means the probe looked for parameters whose titles name oversampling, quality, latency, look-ahead or HQ. It set each through the process queue and `setParamNormalized`, and re-read the latency after a re-prepare (`configure` again) whenever `restartComponent(kLatencyChanged)` arrived.
- **Editor** means three cycles of `createView`, `attached`, a 1.5 s message pump, then `removed` and destroy. After each close no visible top-level window of the process was left, and none was left after teardown either. JUCE plug-ins keep one hidden helper window from the first open until the instance is destroyed. That window is not visible, and it is gone at teardown.
- Audio after the state set and after the three editor cycles stayed finite and non-silent.

## Measurements for Task 5 and later

| Plug-in | Component state | Controller state | TabPlayer container (16 + both) | Latency (samples / ms) | Load: module + instantiate + configure, ms (first run; warm) | Process per block, µs: mean / p99 / max | Mean CPU of a 2,667 µs block |
|---|---|---|---|---|---|---|---|
| Gain | 0 B | 0 B | 16 B | 0 / 0 | 0.4; 0.3 | 0.1 / 0.1 / 0.7 | 0.0 % |
| Emissary | 6,889 B | 0 B | 6,905 B | 6 / 0.125 (7 with oversampling) | 106; 14 | 33.6 / 43.3 / 379 | 1.3 % |
| DI Crank | 1,110 B | 0 B | 1,126 B | 256 / 5.333 | 40; 9 | 7.4 / 8.1 / 21 | 0.3 % |
| SLAMP | 987 B | 0 B | 1,003 B | 0 / 0 | 60; 22 | 89.9 / 114.8 / 464 | 3.4 % |
| Gojira X | 4,606 B | 0 B | 4,622 B | 36 / 0.750 | 4,739; 4,886 | 205.0 / 257.1 / 613 | 7.7 % |
| Amped ML5 | 3,160 B | 0 B | 3,176 B | 0 / 0 | 172; 47 | 292.4 / 387.2 / 739 | 11.0 % |
| Toneforge Menace | 2,241 B | 0 B | 2,257 B | 0 / 0 | 62; 25 | 53.3 / 70.6 / 394 | 2.0 % |

- **Largest state:** 6,905 bytes with the container. That is far under the 1 MiB review mark and the 8 MiB cap. All controller states were empty.
- **Largest latency:** 256 samples (5.3 ms). That is far under 100 ms.
- **Get and set state timing:** getting a state took at most 1.35 ms. Setting one took at most 0.91 ms, except Gojira X: 1,626 ms on its first run and 2.7–2.8 ms on later runs.
- **Dependent DLLs:** none failed to load. `libloading` 0.9 calls `LoadLibraryExW(path, NULL, 0)`, with no extra search directory.
- **Teardown** (editor kill, `setActive(0)`, disconnect, `terminate`) took 0.1–350 ms. The 350 ms was Gojira X.

## Findings for later tasks

1. **Slow plug-in UI work on the helper's main thread (Tasks 8, 15; P16).** Gojira X took 4.0–5.6 s to instantiate over three runs. Its editor took 1.9–5.9 s to open: one cycle-1 open took 5,908 ms, another 4,652 ms. A 5 s request timeout on `OpenEditor` would therefore fail on a healthy plug-in. Give editor-open and load their own longer timeouts, like the 60 s load timeout, or answer `OpenEditor` before the view attaches.
2. **Two VSTGUI editors draw blank.** Emissary and NadIR (both Ignite 2.0.2 on SDK 3.6.12, VSTGUI) attach a correctly sized `VSTGUI…` child window, and open and close cleanly, but the window stays white. That shows in `PrintWindow` and in an on-screen grab, after 1.5 s and after 5 s. Audio, state and latency are unaffected.
   - Ruled out: `OleInitialize` on the main thread, showing the window before `attached`, and an application manifest (supportedOS Windows 10/11, Common Controls 6).
   - The process was DPI-unaware, so editors were bitmap-scaled at 150 %.
   - Task 4 (editor focus and DPI) should retest these two. The cause is open. A comparison with the C++ SDK host would show whether it is host-side.
3. **A restored state can sound different from a fresh instance (Task 13).** ML5 and Menace returned identical state bytes, yet their output level moved after they were set to their own state: ML5 from −13.88 to −14.81 dBFS, Menace from −19.35 to −20.35 dBFS. Gojira X moved by 0.04 dB.
   - So a just-added plug-in and the same plug-in after the document is reopened may not sound the same.
   - Consider having the helper apply the state it just read once, right after a new plug-in is added, so both paths go through `setState`.
4. **Vendored code to adjust in Task 8.**
   - SoundCraft's `MAX_STATE_BYTES` is 64 MiB and its stream accepts up to that. Lower it to TabPlayer's 8 MiB (P10).
   - Its state container is `SCV3` with a 12-byte header, not TabPlayer's 16-byte one.
   - Its editor window takes `GetActiveWindow()` as its owner. In the helper that is null, but pass null explicitly, because the spec forbids an owner link.
   - `on_main_thread` relies on Rust naming the first thread "main".
5. **Bus layouts seen.**
   - Menace has a second stereo input bus (a sidechain), and Gojira X, ML5 and Menace have an event input bus. The FFI gives every bus buffers and activates only the main ones, and that worked. Task 8 needs the same.
   - JUCE plug-ins expose about 2,100–2,200 parameters (MIDI CC proxies), within the FFI's cap of 4,096.

## Limits

- **In-process only.** These runs say nothing about the helper, the ring or the watchdog (Spike 2 and Tasks 6–9).
- **Defaults only.** States were measured with the default preset of each plug-in. A plug-in holding a user IR or capture in its state could be much larger; none of the six embeds one by default.
- **The latency probe matches on parameter titles.** Only Emissary had a setting that changed latency. Other plug-ins may have such settings under other names, so for them the latency was read at load only.
- **Editor judgment.** "Drawn" means the `PrintWindow` image shows the plug-in's interface. Nothing was clicked in an editor, and no editor was resized.
- **Timing.** Single process, one thread, on a developer machine with other work running. These are not realtime measurements.
- **Gain example editor.** The gain example has no editor (`createView` returns null). That criterion is recorded as not applicable to it, not as passed.

## Reproduce

These commands assume `.analysis/vst-spikes/` as rebuilt from the description above; it is not committed.

```powershell
$env:RUSTUP_TOOLCHAIN = '1.90.0'; $env:CARGO_TARGET_DIR = 'E:/cargo-target/slot-1'
cargo build --release --manifest-path .analysis/vst-spikes/host-rust/Cargo.toml
cargo build --release --manifest-path .analysis/vst-spikes/gain-example/Cargo.toml
# copy gain.dll to plugins/gain.vst3 and the exe to host.exe, then for each plug-in:
.analysis/vst-spikes/run.ps1 -Plugin "C:\Program Files\Common Files\VST3\SLAMP.vst3" -Name slamp
```

Logs and editor images are in `.analysis/vst-spikes/logs/` (not committed).

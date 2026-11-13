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
- **Build:** `RUSTUP_TOOLCHAIN=1.90.0`, `CARGO_TARGET_DIR=<cargo-target>/slot-1`, release profile.

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

| Plug-in | Component state | Controller state | TabPlayer container (20 + both) | Latency (samples / ms) | Load: module + instantiate + configure, ms (first run; warm) | Process per block, µs: mean / p99 / max | Mean CPU of a 2,667 µs block |
|---|---|---|---|---|---|---|---|
| Gain | 0 B | 0 B | 20 B | 0 / 0 | 0.4; 0.3 | 0.1 / 0.1 / 0.7 | 0.0 % |
| Emissary | 6,889 B | 0 B | 6,909 B | 6 / 0.125 (7 with oversampling) | 106; 14 | 33.6 / 43.3 / 379 | 1.3 % |
| DI Crank | 1,110 B | 0 B | 1,130 B | 256 / 5.333 | 40; 9 | 7.4 / 8.1 / 21 | 0.3 % |
| SLAMP | 987 B | 0 B | 1,007 B | 0 / 0 | 60; 22 | 89.9 / 114.8 / 464 | 3.4 % |
| Gojira X | 4,606 B | 0 B | 4,626 B | 36 / 0.750 | 4,739; 4,886 | 205.0 / 257.1 / 613 | 7.7 % |
| Amped ML5 | 3,160 B | 0 B | 3,180 B | 0 / 0 | 172; 47 | 292.4 / 387.2 / 739 | 11.0 % |
| Toneforge Menace | 2,241 B | 0 B | 2,261 B | 0 / 0 | 62; 25 | 53.3 / 70.6 / 394 | 2.0 % |

- **Largest state:** 6,909 bytes with the container. That is far under the 1 MiB review mark and the 8 MiB cap. All controller states were empty.
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
   - Its state container is `SCV3` with a 12-byte header, not TabPlayer's 20-byte one.
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
$env:RUSTUP_TOOLCHAIN = '1.90.0'; $env:CARGO_TARGET_DIR = '<cargo-target>/slot-1'
cargo build --release --manifest-path .analysis/vst-spikes/host-rust/Cargo.toml
cargo build --release --manifest-path .analysis/vst-spikes/gain-example/Cargo.toml
# copy gain.dll to plugins/gain.vst3 and the exe to host.exe, then for each plug-in:
.analysis/vst-spikes/run.ps1 -Plugin "C:\Program Files\Common Files\VST3\SLAMP.vst3" -Name slamp
```

Logs and editor images are in `.analysis/vst-spikes/logs/` (not committed).

# VST spike 2: IPC hand-off timing (THE-71), 2026-11-08

Task 2 of `docs/superpowers/plans/2026-11-08-vst-hosting.md`, under pre-flight rulings P23 (8 helpers, stop rule), P9 (pipeline depth for small callbacks, ring size), P3 (copy results out, host-owned indices in app memory) and P21 (build location). Branch `feature/vst-hosting` at `f934a53`.

## Result

**PASS. `BLOCK_FRAMES = 128`, pipeline depth two callbacks, wake by event.**

- At block 128 and `P` = 2 callbacks, 8 helpers ran for 10 minutes with zero underruns. The p99 hand-off was 1.28 ms with the synthetic load and 2.31 ms with a real amp plug-in (Amped ML5) in every helper. The limit is one callback, 10.67 ms.
- Blocks 64 and 256 also passed. Block 128 stays because it is the spec's value and nothing argues for a change.
- `P = 3` was not needed in any configuration.
- **Pipeline depth.** It follows P9: `P = C + max(C, BLOCK_FRAMES)`, rounded up to a multiple of `BLOCK_FRAMES`. That is 2C whenever C ≥ 128. At 64-frame callbacks it gives 256 frames (5.33 ms), and that run passed.
- **Wake method: events.** Each helper has an auto-reset event, and the app calls `SetEvent` after each published block. Events had the lower p99 at equal underruns (zero) in both pairs measured, and the lower total CPU:
  - 512-frame callbacks: 1.28 ms with events, 2.25 ms with polling.
  - 64-frame callbacks: 0.41 ms with events, 1.51 ms with polling. Polling fails the criterion there.

## What was built

All of it is under `.analysis/vst-spikes/ipc/`, which git ignores. None of it is committed.

- **One binary, two roles.** `ipc.exe app …` spawns N copies of `ipc.exe helper …`.
- **The prototype ring** (`ring.rs`) has Task 6's layout: `RingHeader`, then per-block `BlockHeader`s for input and output, then the input and output sample areas of `RING_BLOCKS × BLOCK_FRAMES × [f32; 2]`, all 64-byte aligned. It lives in a named page-file mapping.
- **P9:** `RING_BLOCKS = ceil(8192 / BLOCK_FRAMES) + 2`, so 66 blocks at 128.
- **P3:**
  - The app copies each output block into preallocated scratch with volatile reads.
  - It checks the block's sequence before and after the copy, seqlock style, and checks finiteness on the copy.
  - It refuses an `output_write` above its own count of published inputs.
  - The next input sequence and the epoch are app-memory counters that are only written to the mapping.
  - The helper mirrors this for input blocks.
- **The callback thread** joins MMCSS "Pro Audio" and is paced by a high-resolution waitable timer (`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`) on an absolute QPC grid. Each callback writes a 220 Hz sine frame by frame into every helper's current block, and publishes and signals each block as it fills. It reads the result for frame `f − P`, fetching each block at its first frame. It does not allocate or lock.
- **The helpers** join MMCSS "Pro Audio" and run one of three modes:
  - echo: input copied to output;
  - synthetic: a busy-wait for a fixed share of block time, then echo;
  - plug-in: the Spike 1 FFI, vendored again from `host-rust/`, with one VST3 instance at 48 kHz, the block size and a stereo main bus.
- **Wake.** In event mode the helper waits on its event (50 ms timeout) and then drains every published block. In poll mode it sleeps 500 µs on a high-resolution waitable timer between checks.
- **Measurements.**
  - The hand-off runs from the app's QPC stamp just before it publishes `input_write` to the helper's QPC stamp just before it publishes `output_write`. It includes the wake, the queueing behind earlier blocks of the same callback, and the processing.
  - The helper keeps 1 µs histograms of hand-off, wake and process time in the mapping.
  - The app counts underruns: a block not ready, torn or non-finite when its first frame is due.
  - The app also counts echo mismatches, bit-exact against the regenerated input, in echo and synthetic modes.
  - CPU use is the kernel plus user time from `GetProcessTimes` and `GetThreadTimes` over the timed span, as a percentage of one core.
- **Step 1 checks (10 s each).** Echo and the `vst3` gain example (`plugins/gain.vst3`) both ran on the ring with 8 helpers, with zero underruns and zero mismatches in echo.
- **Build.** `RUSTUP_TOOLCHAIN=1.90.0`, `CARGO_TARGET_DIR=<cargo-target>/slot-1`, release, `--offline`. Dependencies are the Spike 1 pins plus `cpal =0.18.2`, which the app already locks and which was already in the cache, for the device-paced run. Nothing was downloaded.

## Load

- **Synthetic per-block cost: 11 % of block time** (293 µs at block 128), the mean of Amped ML5, the heaviest plug-in in Spike 1.
- **Real plug-in run:** Amped ML5 in all 8 helpers. Its process time per block was p50 356 µs, p99 979 µs and max 2.29 ms.
  - That is heavier than Spike 1's in-process figures. 8 instances share the machine, and up to 29 % of a helper's blocks ran on E-cores.
- **Machine:** i7-14700KF, 8 P-cores and 12 E-cores (28 threads), Windows 11 Pro 10.0.26300.
- **Quiet runs.** The runner waited for no `cargo`, `rustc`, `link`, `cl` or `msbuild` process before each run, then sampled every 10 s.
  - Another session's Cargo builds overlapped part of four runs. The table gives the share of samples with a build running.
  - The headline runs (block 128, synthetic and ML5) and the quiet poll rerun saw none.

## Runs: 8 helpers, 48 kHz, 10 minutes each

| Configuration | P (frames) | Hand-off p50 / p99 / p99.9 / max (µs) | Underruns | Limit (1 callback, µs) | Min margin to deadline | CPU: app / per helper | Builds seen | Verdict |
|---|---|---|---|---|---|---|---|---|
| C 512, B 128, event, synthetic | 1024 | 727 / 1,276 / 1,368 / 2,325 | 0 | 10,667 | 18.7 ms | 1.0 % / 11.1 % | 0/59 | **pass** |
| C 512, B 128, event, **ML5 ×8** | 1024 | 1,135 / 2,310 / 2,761 / 3,909 | 0 | 10,667 | 17.1 ms | 0.8 % / 15.6 % | 0/58 | **pass** |
| C 512, B 128, poll, synthetic (quiet rerun) | 1024 | 1,515 / 2,246 / 2,549 / 3,320 | 0 | 10,667 | 17.6 ms | 0.8 % / 11.6 % | 0/59 | pass |
| C 512, B 128, poll, synthetic (first run) | 1024 | 1,512 / 2,235 / 2,578 / 6,484 | 0 | 10,667 | 14.8 ms | 0.7 % / 11.5 % | 21/59 | pass |
| C 512, B 64, event, synthetic | 1024 | 654 / 1,184 / 1,359 / 2,234 | 0 | 10,667 | 18.7 ms | 1.2 % / 11.1 % | 12/58 | pass |
| C 512, B 256, event, synthetic | 1024 | 859 / 1,231 / 1,416 / 2,029 | 0 | 10,667 | 18.5 ms | 1.1 % / 11.1 % | 7/58 | pass |
| C 256, B 128, event, synthetic | 512 | 437 / 681 / 893 / 1,871 | 0 | 5,333 | 7.9 ms | 1.2 % / 11.0 % | 0/59 | pass |
| C 64, B 128, event, synthetic (P9) | 256 | 306 / 408 / 618 / 1,391 | 0 | 1,333 | 1.69 ms | 2.1 % / 11.2 % | 9/58 | pass |
| C 64, B 128, poll, synthetic (P9) | 256 | 814 / 1,512 / 1,775 / 2,816 | 0 | 1,333 | **0.20 ms** | 1.0 % / 11.4 % | 0/58 | **fail** (p99) |
| Device-paced (WASAPI shared, cpal, 480-frame period), B 128, event, synthetic | 1024 | 605 / 1,183 / 1,331 / 2,526 | **8, all at start** | 10,000 | 8.0 ms | 3.2 % / 10.0 % | 0/59 | pass after start-up (finding 1) |

What the columns mean:
- **C** is the callback size and **B** the block size.
- **Min margin** is the smallest gap between a result's publish and the moment its first frame was needed.
- **Per-helper CPU** with the synthetic load is mostly the busy-wait itself. The wake cost is measured separately below.
- No run had an echo mismatch or a helper error. Every hand-off quantile is over all 8 helpers: 1.8 million blocks at B 128, 3.6 million at B 64, 0.9 million at B 256.

**Pass criterion (Step 3, with 8 helpers per P23):** at block 128, `P` = 2 callbacks, zero underruns in 10 minutes and a p99 hand-off of at most one callback. **Met**, with the synthetic load and with ML5, both on a quiet machine.

## Events versus polling

| C 512, B 128 | Wake p50 / p99 (µs) | Hand-off p99 (µs) | Underruns | CPU, echo helpers (2 min, quiet): app / all 8 helpers / total |
|---|---|---|---|---|
| Event (`SetEvent`, auto-reset) | 99 / 879 | 1,276 | 0 | 1.17 % / 1.64 % / **2.8 %** of one core |
| Poll (500 µs high-resolution timer) | 890 / 1,252 | 2,246 | 0 | 0.68 % / 4.52 % / **5.2 %** of one core |

- **Events win on p99 at equal underruns**, at 512-frame and 64-frame callbacks. They also cost about half the total CPU: each idle polling helper burns 0.56 % of a core against 0.21 % for an event-woken one.
- **The cost of events.** `SetEvent` moves about 0.5 % of a core onto the app's callback thread with 8 helpers.
- **Polling at a 500 µs period** wakes after about 0.9 ms in practice, which is timer granularity. At 64-frame callbacks that left a minimum margin of 0.20 ms, close to an underrun.

## Findings for later tasks

1. **The first WASAPI callback is the whole device buffer (Tasks 9, 11, 13; P8, P32).** In shared mode, cpal's first callback asked for 1,056 frames. Later ones were 480 frames, the 10 ms period.
   - With `P` sized from the 480-frame period (2 × 480 = 960, rounded up to 1,024), block 0 was due inside the same first callback that published it. Each helper underran once, at frame 1,024. There were no underruns in the 10 minutes after that.
   - So either size `P` from the largest callback seen, which is device-level `max_callback_frames` per P32 and includes this start-up fill, or treat the first callback after start or attach as priming under P8.
   - Otherwise every play start reports a spurious underrun and crossfades to the built-in tone.
2. **The app's real thread setup differs from the spike's.** cpal's WASAPI thread runs at `THREAD_PRIORITY_TIME_CRITICAL`. It does not join MMCSS. The device-paced run used it as is, and its steady state matched the MMCSS timer runs: p99 1.18 ms.
3. **E-cores on hybrid CPUs (Task 8).** Between 10 % and 49 % of helper blocks ran on E-cores (logical CPU 16 and up) despite MMCSS "Pro Audio".
   - In the ML5 run, the three helpers with the most blocks on E-cores (18–29 % of their blocks) had a hand-off p50 of 1.24–1.40 ms, against 1.02–1.08 ms for the other five. They also used 16.7–18.1 % of a core against 14.3–14.9 %.
   - It did not cause underruns.
   - Not tested: whether opting the helper's audio thread out of power throttling (`SetThreadInformation`, `ThreadPowerThrottling`) keeps it on P-cores.
4. **The margin left for the app's own render.** The spike's callback publishes every block almost at once. In the app, the renderer publishes a block when it reaches that block's last frame, so a heavy render uses up part of the margin.
   - The margin was at least 17 ms at 512-frame callbacks and 7.9 ms at 256.
   - At 64-frame callbacks it was only 1.69 ms, and under partial build load. There a slow render or a late callback is the risk, more than the helper.
   - 1,236 timer callbacks (0.3 %) started more than 1 ms late in that run.
5. **Ring size (Task 6).** At block 128, P9's 66 blocks hold 2 × 66 × 128 × 8 B = 135 KB of samples per helper, plus headers.
   - The spike's 1.2 MB of histograms are spike-only.
   - The pipeline used at most 1,024 frames, 8 blocks, far below the 8,192-frame cap.
6. **Handles (Task 6).** The spike opens the mapping and the event by name in `Local\`. The plan's `Load { ring, input_event, … }` passes handle values instead. Use inherited or duplicated handles so that no other process can open them by name.

## Limits

- **Timer pacing for most runs.** Callback sizes were exact, but callback start jitter came from the timer: p50 about 290 µs late and p99 about 600 µs. That is in the range of a real device, but it is not a device.
  - Only one run was device-paced, at the device's own 480-frame period. Fixed 512, 256 and 64-frame device buffers were not tried.
- **Partial build load in four runs.** Builds overlapped part of the 64-frame and 256-frame block runs, the 64-frame event callback run and the first poll run.
  - Those runs passed anyway. The quiet poll rerun matched the first one: p99 2,246 against 2,235 µs.
  - The headline numbers come from quiet runs.
- **One real plug-in**, ML5 ×8, for one 10-minute run. Other plug-ins may have worse tails.
- **Spike-only parts.** No watchdog, flush, epoch change, priming crossfade or helper crash was exercised. Named kernel objects were used instead of inherited handles. The app-side render is trivial.
- **CPU percentages** come from Windows' process and thread time accounting over 120 s or 600 s. Treat sub-1 % differences as approximate.

## Reproduce

These commands assume `.analysis/vst-spikes/ipc/` as described above; it is not committed.

```powershell
$env:RUSTUP_TOOLCHAIN = '1.90.0'; $env:CARGO_TARGET_DIR = '<cargo-target>/slot-1'
cargo build --release --offline --features device --manifest-path .analysis/vst-spikes/ipc/Cargo.toml
# copy vst-spike-ipc.exe to .analysis/vst-spikes/ipc/ipc.exe, then:
.analysis/vst-spikes/ipc/run-all.ps1 -Seconds 600
# one configuration by hand:
.analysis/vst-spikes/ipc/ipc.exe app --helpers 8 --callback 512 --block 128 --depth 2 --seconds 600 --wake event --mode synth:0.11
```

Logs per run (`app.log`, `monitor.log`, `helper-N.log`) are in `.analysis/vst-spikes/ipc/runs/` (not committed).

# VST spike 3: loop-wrap continuity with delay compensation (THE-71), 2026-11-08

Task 3 of `docs/superpowers/plans/2026-11-08-vst-hosting.md`, under pre-flight rulings P2 (the device's `seek(end)`) and P21 (where the spike builds). Branch `feature/vst-hosting` at `8e72414`. Windows 11 Pro (10.0.26300).

## Result

**PASS. A seamless loop wrap is possible under the spec's design. Today's call sites would break it, in the places listed below, and that is what Task 12 has to change.**

- With the delay lines kept across the wrap, and every output frame (pass, count-in and drain) clocking them, all four criteria held at every delay tried (D_max = 0, 64, 1,024, 4,800, and a mixed 1,024 / 4,800), with the count-in off and on, over ten passes. Numbers are below.
- With the lines flushed the way the device would flush them (every `seek` flushes, once Task 12 makes `Renderer::seek_tick` flush them), the wrap loses the last D_max frames of every pass, and the count-in click is not delayed. Those failures come from today's unpatched call sites. They are expected, so they are Task 12's list, not a failed spike.
- Fixing only the wrap's own `seek(start)` is not enough: the `seek(end)` that runs just before it flushes too (P2, confirmed below).

## What was built

An untracked `src-tauri/tests/spike_wrap.rs` (excluded through `.git/info/exclude`, deleted after these numbers were taken), built in the default `src-tauri/target` with `cargo +1.90.0 test --locked --test spike_wrap`. No product code changed. A ten-pass run takes about 25 s.

- **Score.** Two bars of 4/4 at 120 bpm, 48 kHz, ppq 960. The loop is bar 1 (ticks 3,840 to 7,680), so the wrap seeks back into the middle of the score. One pass is 96,000 frames.
- **Stems of the real `Renderer`**, in `render_stems_and_mix_until` order: track 0, track 1, a backing track, and the click (metronome on, volume 0.4).
  - Both tracks play a one-frame impulse sample on each beat (frames 0, 24,000, 48,000 and 72,000 of the pass) and three pickup notes at frames 95,000, 95,950 and 95,975, so that the last D_max frames of a pass carry audio.
  - The backing track is a 4 s buffer with an impulse on every beat.
- **Control flow.** `CallbackTransport::render_block` (device.rs:1417-1512) is replicated: the count-in with the real `CountInClock` and `ClickVoice`, the loop-end check, the block split at 512 frames, `seek(end)` and `wrap`. Every `seek_tick` call is recorded with its kind (user, end of pass, wrap start, end of score).
- **Delay lines.** The renderer has no insert hook, so each stem has an insert line and a compensation line downstream of the recorded stream, with a total of D_max for every stem. Track 0 carries the insert (D frames) in the main configuration and the other stems are compensated by D. One mixed configuration has inserts of 1,024 on track 0 and 4,800 on track 1. A policy decides what each recorded seek does to the lines.
- **Reference.** One fresh pass of the loop, rendered once by a separate renderer, repeated ten times. With the count-in on, a count-in click (one bar, 96,000 frames) precedes every pass, including the first, because Play and every wrap start one. The expected output is that stream delayed by exactly D_max.
- **Count-in on** means one bar with `between_loops` set; **off** means zero bars.

## Fidelity of the model

- The recorded stream equals the fresh-pass reference bit for bit, for all ten passes, count-in off and on. A pass after `seek_tick(end)` and `seek_tick(start)` is identical to a fresh one.
- Callback sizes 509 (the wrap falls inside a block) and 128 give the identical stream.
- The real `CallbackTransport` (headless, `SetLoop` then `Play`, same renderer, 509-frame callbacks) produces a mix that equals the model's mix: 0 of 960,000 frames (off) and 0 of 1,920,000 (on) differ.
- The stem sum differs from that mix by at most 0.227, only where the impulses coincide above 0.9 and `master_limit` acts. The delay model works on the stems before the limiter, so the criteria compare stem sums.

## Pass criteria (Task 3 Step 2), delay lines kept (policy `Keep`)

Ten passes of 96,000 frames. All five delay configurations gave the same numbers.

| Criterion | Count-in off | Count-in on |
|---|---|---|
| Output equals the continuous reference delayed by exactly D_max | **yes**: 0 of 960,000 frames differ, max difference 0.000 | **yes**: 0 of 1,920,000 frames differ, max difference 0.000 |
| No gap at any wrap | **yes**: 0 frames silent where audio is expected; output length equals input length exactly | **yes**: 0 silent frames; length exact |
| Backing and track impulses frame-aligned on every pass | **yes**: 120 checks (10 passes, 4 beats, 3 stems), 0 off the expected frame, 0 differing between stems; every stem peaks at the beat frame + D_max | **yes**: the same, 120 checks, 0 and 0 |
| Count-in clicks delayed by D_max; the previous pass's last D_max frames play out during it | not applicable | **yes**: 10 of 10 count-ins start exactly D_max frames after their input position; 9 of 9 wraps play the previous pass's last D_max frames, equal to the reference tail frame for frame, during the first D_max frames of the count-in |

The tail check has audio in it for every D_max of 64 and above (the pickups). At D_max = 0 there is nothing to play out.

## What breaks with the device as it stands

The same recorded stream, with the lines handled the way today's call sites would handle them. Counts are over ten passes (nine wraps with audio after them).

| Policy | Count-in off | Count-in on |
|---|---|---|
| `Today`: every `seek` flushes the lines; count-in frames bypass them | D_max 0 passes. D_max 64: 450 frames differ (50 per wrap, the pickups). D_max 1,024 and above: 900 (100 per wrap). The last D_max frames of each pass are replaced by silence. | D_max 0 passes. Above 0: the tail is lost at every wrap (0 of 9), the count-in click is undelayed, and 98,520 to 192,820 frames differ (D_max 64 to 4,800). The click is the larger part of that count. |
| `KeptButStalled`: `wrap_to_tick` keeps the lines but the count-in still bypasses them | passes (no count-in to stall) | the same failures as `Today`: the tail does not play (0 of 9) and the click is undelayed |
| `EndSeekOnly`: the wrap's own seek is fixed, `self.seek(end)` before it stays | **fails**: 450 frames (D_max 64) or 900 (D_max 1,024 and above) differ, the same as `Today` | **fails**: the same counts. The click is delayed (10 of 10) but the tail is lost (0 of 9). |

End of a score with no loop (192,000 frames, then D_max frames of drain):

| D_max | `Today` and `EndSeekOnly` (flush at `seek(end)`) | `Keep` (no flush, lines drained) |
|---|---|---|
| 64 | 50 frames differ; the drain is silent (tail energy 0 of 4.785) | 0 differ; tail energy 4.785 of 4.785 |
| 1,024 | 100 differ; silent drain (0 of 7.178) | 0 differ; 7.178 of 7.178 |
| 4,800 | 100 differ; silent drain (0 of 7.178) | 0 differ; 7.178 of 7.178 |

So the two flush points in P2, `seek(end)` before `wrap` and `seek(end)` at the end, each lose the same D_max frames, and either one alone is enough to break a wrap.

## Keep and reset list for the wrap path

`Renderer::seek_tick` (renderer.rs:1430-1607), one line per field or state. "Reset" means the wrap keeps resetting it, as today; this is what makes every pass identical to the reference. "Keep" means the field is not touched. The last block is state Task 12 adds, which a wrap must not touch.

| State | Where | Today at a wrap | Wrap with a VST insert |
|---|---|---|---|
| MIDI output tap `on_seek()`: notes released, state re-sent | :1436 | reset | reset (external MIDI, unrelated to the insert) |
| `seconds` set from the tick | :1439 | reset | reset (position) |
| `clock_origin_seconds`, `clock_origin_tick`, `clock_frames` (`reset_clock_origin`) | :1440, :1661 | reset | reset (maps frames to time; the device frame count continues) |
| `tail` flag | :1441 | cleared | reset |
| `slots` and `active`: all sounding voices and pending release samples | :1442-1445 | cut | reset |
| Per-track built-in effects `mix.channels[i].dsp.reset()`: gate, compressor, amp, cabinet, EQs, chorus, delay, reverb tails | :1446-1448 | cut | reset (a built-in tail is cut as today; the insert's own tail is not, see below) |
| `Track.kit_rendered` and `settle_idle_kit()`: drum kit level ramps | :1449-1454 | set to target | reset |
| `mix.master.reset()`: master effect tails, limiter gain and leaving gain | :1455 | reset | **open, see limits**: if the master bus follows the delay lines, this reset falls inside delayed live audio |
| `next_note`, `next_midi` cursors | :1456-1457 | reset | reset |
| Per track: `channels`, `drum_used`, synth and drum synth `reset()` with program setup, `ranges`, `rpn_msb`, `rpn_lsb` | :1458-1489 | reset | reset |
| MIDI events before the tick replayed, held and sustained notes struck again | :1490-1563 | rebuilt | reset (rebuilt) |
| Notes begun before the tick that are still sounding: `start_note` and `seek_elapsed_seconds` | :1565-1602 | rebuilt | reset (rebuilt) |
| `backing.seek(seconds)`: filter, grain state, tails cleared | :1603-1605 | reset | reset |
| `reset_click_position()`: `last_click`, click voice | :1606, :1844 | reset | reset |
| Not touched by `seek_tick`: `tempo`, `midi_fade`, per-channel `Gain` smoothing, backing gain, master level, `parked_mix`, metronome settings, the MIDI tap object, plan, timeline, resources | | kept | keep |
| **Bridge to the helper**: link, epoch, sequence counters, input and output blocks in flight (the P pipeline) | Tasks 6, 11 | does not exist | **keep**: the input stream is the concatenated loop, so nothing is cut at a wrap |
| **Insert delay lines (P + L) per stem, and their contents** | Task 12 | does not exist | **keep**: the last D_max frames of the pass are still in them |
| **Compensation lines** for tracks without an insert, the backing track, the click and the count-in click | Task 12 | does not exist | **keep**, and clock them on every output frame |
| **Plug-in instance state**: its processing, internal tails, parameters; no `setProcessing` cycle, no state reload | helper | does not exist | **keep**: its own tail rings through the wrap |
| D_max and each stem's latency value | Task 12 | does not exist | **keep**: constant across a wrap |
| Priming and crossfade state (P8, P32) | Tasks 11, 13 | does not exist | **keep**: a wrap is not an attach |

What flushes the new state: a user seek, a stop, a fault restore, and an install without preserve (P2). An install with preserve keeps streaming.

## Device call-site findings (P2)

`CallbackTransport` in `src-tauri/src/audio/device.rs`.

| Call site | Line | What it does now | What Task 12 has to do |
|---|---|---|---|
| `render_block`, loop end already reached when a block starts | :1457-1461 | `wrap(start)` | nothing beyond `wrap` |
| `render_block`, nothing left to render before the end | :1474-1475 | `self.seek(end)`, then `wrap(start)` | replace `seek(end)` with a position update that does not touch the lines (not reached in a steady loop) |
| `render_block`, after the last frame of a pass | :1501-1503 | `self.seek(end)`, then `wrap(start)` | **replace `seek(end)`**: it is the first of two `seek_tick` calls per wrap and flushes the lines (model: `EndSeekOnly` fails) |
| `render_block`, end of score with no loop | :1475, :1502, :1505-1510 | `self.seek(end)`, then `playing = false` and phase `Ended` | no flush at the end; keep pulling the lines for D_max more frames (a drain) after `Ended`, then idle (model: the drain keeps the tail) |
| `wrap` | :1390-1397 | `passes + 1`, `resolve_renderer`, `self.seek(start)`, `start_count` if between loops | call `wrap_to_tick`: the renderer resets above, not the flush. `resolve_renderer` may change the tempo ratio (progressive tempo); that moves `clock_origin` only, and the lines count frames, so it does not touch them. |
| `render_block`, count-in frames | :1439-1456 | the click is written straight to `output` and nothing else runs | stay in the delay path: push silence for the tracks and backing, put the click through the click compensation line, and clock every line, so the previous pass's tail plays out (model: `KeptButStalled` fails) |
| `seek` | :1361-1368 | `renderer.seek_tick` | keep as the flushing path for user seeks. Callers: `Invalidate` :1188, `PlayRange` :1240, `Play` :1265, :1268, :1270, `Stop` :1290, `SeekTick` :1298, `SetLoop` jumping into the loop :1328, fault restore :1596. |
| `install_with_practice`, preserve | :1061-1062 | `renderer.seek_tick(self.tick)` on the new renderer | position the new renderer without the flush; the lines and bridge belong to the link, not the renderer (P2, with P8) |
| `install_with_practice`, no preserve | :1063-1076 | transport state reset, new renderer | flush (as P2 rules) |

A fix therefore needs `seek_tick` split into a reposition part (every row marked "reset" above) and a flush part (the lines, bridge and insert), or `wrap_to_tick` and an end-of-pass equivalent with the same effect as the reposition part.

## Limits

- **Replicated flow, not the device's.** The real `CallbackTransport` has no place for the lines, so the control flow of `render_block` is replicated. Its mix matches the real transport's mix exactly, which supports the replica, but the count of two `seek_tick` calls per wrap (`self.seek(end)` at :1502 and the `seek(start)` inside `wrap` at :1393) comes from the replica and from reading the code. Task 12 owns the device-level tests, which drive `render_into` with a headless output.
- **The insert is a pure delay.** No plug-in processing, no helper process, no P-block jitter, no underrun or priming. The equality checks are bit-exact for that reason; a real insert will not be bit-exact.
- **Stems are summed before the master bus.** The master bus sits after the sum in the renderer and `mix.master.reset()` runs at every wrap today. If Task 12 puts the delay lines before the master bus, that reset lands in the middle of delayed live audio. This was not modelled, and it needs a ruling: keep the master state at a wrap when an insert is active, or place the lines after the master bus. A default master has no effects and a limiter at unity, so it may be inaudible, but a configured master bus could step.
- **One configuration.** A constant 120 bpm at speed 1.0, one 4/4 bar loop starting at tick 3,840, 48 kHz. Progressive tempo, fixed tempo, a loop that is not on a bar line, and a loop whose end falls inside a held note were not run. The reference cuts voices at the wrap, as the renderer does, so no note rings across it.
- **Callback sizes 509 and 128** only, with `BLOCK` = 512.
- **Pause and resume** were not modelled. The device renders nothing while paused, so the lines would simply freeze; whether that is wanted is a Task 12 question.
- **The `:1475` path** (nothing left to render when a block starts) is not reached in a steady loop.
- **Test profile.** Built at the repository's test profile (no optimisation); only equality was measured, not time.

## Reproduce

The spike file is deleted; these commands assume it has been rebuilt from the description above.

```powershell
$env:RUSTUP_TOOLCHAIN = '1.90.0'
cargo test --locked --manifest-path src-tauri/Cargo.toml --test spike_wrap -- --nocapture
# SPIKE_PASSES=2 shortens the run; the default is 10
```

The worktree needed `src-tauri/resources/library` (git-ignored, like `resources/audio`) for `build.rs`; it is a junction to the main checkout's copy.


# VST spike 4: cross-process editor focus on Windows (THE-71), 2026-11-08

Task 4 of `docs/superpowers/plans/2026-11-08-vst-hosting.md`, under pre-flight rulings P5 (message-only window), P21 (build location) and P29 (editor HWND, app pid). Branch `feature/vst-hosting`, run between `252bda3` and `9e33bc1`. Windows 11 Pro (10.0.26300), one display, 2560x1440 at 144 DPI (150 %). The foreground lock timeout reads 2147483647 ms (read only; no display or system setting was changed).

## Result

**PASS for (a), (b), (c), (d), (e) and (f)**, with the limits below. (d)'s "typing works" half was exercised in one plug-in (Amped ML5), and (f) at the one scale this machine has (150 %).

| Criterion | Result | Numbers |
|---|---|---|
| (a) unowned, unparented | **PASS** | On all 7 plug-ins opened: `GW_OWNER` = 0, `GetParent` = 0, `GetAncestor(GA_PARENT)` = the desktop, no `WS_CHILD`, window pid = helper pid. |
| (b) 10 s helper hang | **PASS** | Real app on CDP 9223, three 10 s hangs: CDP round trip max 16.3, 11.4 and 19.8 ms (p99 15.6, 9.3 and 12.1), against 200 ms allowed. The page painted at 209-238 frames/s throughout (about 240 without a hang) and 76 of 76 screenshots differed. |
| (c) front after `AllowSetForegroundWindow(helper pid)` | **PASS** | 10/10 opens in front (and 6/6 with no extra input). Without the call the helper's `SetForegroundWindow` returned 0 and the editor did not come to the front. |
| (d) typing, no TabPlayer shortcuts | **PASS** (typing tested in ML5 only) | "tabplayer", Space, "x" typed into ML5's preset-name field: the field showed `tabplayer x`. The stand-in saw 0 key events; the real app saw 0 keys with the editor in front and 5 of 5 when it was in front itself. |
| (e) focus back after close | **PASS** | Helper `AllowSetForegroundWindow(app pid)`, then app `SetForegroundWindow`: stand-in in front within 0-1 ms, for a command close and a close-button close, on 5 plug-ins. Windows also restored it unaided in every run. |
| (f) 150 %, per-monitor v2 | **PASS** | Client area equals the plug-in's requested size, with no clipped child, for ML5, Gojira X, SLAMP, DI Crank, NadIR, Emissary and the test plug-in. |

No licence, activation or login dialog appeared in any run.

## Method

Everything is under `.analysis/vst-spikes/editor/` (git-ignored, not committed), built with `cargo +1.90.0` into `<cargo-target>/slot-1`. The desktop test app was built from this worktree with `scripts/build-desktop-test.ps1` (default target).

- **`helper.exe`** is Spike 1's SoundCraft-derived FFI in its own process. The main thread runs a `GetMessage` loop. A reader thread takes commands on stdin, queues them and posts `WM_APP` to an `HWND_MESSAGE` window (P5). Commands are `open`, `close`, `raise`, `info`, `snap`, `quit`. It sets per-monitor v2 DPI awareness first (`SetProcessDpiAwarenessContext(-4)`), creates the editor with a null owner, and is told the app's pid (P29).
- **`app.exe`** is a stand-in parent: a plain top-level window that counts `WM_KEYDOWN`, `WM_CHAR` and `WM_PAINT`, and a driver that spawns a helper per scenario. It reads `GetForegroundWindow`, `GetWindowThreadProcessId` and `GetGUIThreadInfo`, and synthesizes input with `SendInput` (typing only while `GetForegroundWindow` is the editor). The stand-in is needed because the real app has no plug-in code yet, so nothing in it can call `AllowSetForegroundWindow(helper)`.
- **(b) used the real app**, launched from `.analysis/desktop-smoke/tabplayer.exe` with `--remote-debugging-port=9223` (nothing listened before; nothing after). A Node script (`cdp-hang.mjs`) spawned a separate helper with `TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS=10000` and `open`, and for 12.5 s ran: `Runtime.evaluate("1+1")` every 40 ms, `Page.captureScreenshot` every 500 ms, and an on-page `requestAnimationFrame` counter drawn in a corner. The editor was shown before it attached so the hung window was visible, and Windows marked it not responding (`IsHungAppWindow` true).
  - **Why this is equivalent:** the app and the helper share nothing but the desktop, so the only paths from a hung helper to the app are window links (owner, parent) and activation. The helper runs the real helper code path with the real hanging plug-in. What is not exercised is the app's own future pipe code (Task 15).
  - The CDP probe times the renderer, not the native UI thread. The stand-in covers that: 310 `SendMessageTimeout(WM_NULL)` probes during the hang took max 1.5 ms (7.8 ms with the first test-plug-in build), and minimize, restore, move and `SetForegroundWindow` of the stand-in took 0-11 ms.
- **Plug-ins** (all already installed; none registered or logged into): the test plug-in (`tabplayer_test_plugin.dll` copied to `testplug.vst3`; the hang runs inside `attached`), Amped ML5, Archetype Gojira X, SLAMP, AtlasDSP DI Crank (JUCE), and Emissary and NadIR (VSTGUI).
- **Test plug-in provenance.** The first runs used a build of `252bda3` plus uncommitted edits to `lib.rs` by another agent (since committed as `9e33bc1`; `view.rs`, which holds the hang, is unchanged). (b) was rerun with the `9e33bc1` build: CDP max 19.8 ms, stand-in max 1.5 ms.

## (a) Unowned and unparented

The editor window is a plain top-level window (`WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_CLIPCHILDREN`, `0x16c80000`), created with a null owner. `GetParent` also reports an owner, so the check reads `GW_OWNER`, `GetParent` and `GetAncestor(GA_PARENT)`; the last must be the desktop. `GetWindowThreadProcessId` named the helper's pid every time (P29).

- **Consequence: a taskbar button.** An unowned top-level window gets one. `WS_EX_TOOLWINDOW` (`SPIKE_EX_TOOLWINDOW=1`) removes it (`exstyle` 0x180) without changing (a), (c) or (e). Task 15 should rule on this; nothing here decides it.
- **Control that shows why (a) matters.** The same 10 s hang with the editor owned by the stand-in's window (`--owner-control`): `ShowWindow(SW_MINIMIZE)` on the stand-in **blocked 8,043.9 ms**, against 1.8-4.9 ms when unowned. A cross-process owner lets a hung helper stall the app's UI thread.

## (b) Responsiveness during a 10 s hang

| Real app, CDP | samples | RTT p50 / p99 / max | frames/s | max frame gap | screenshots different |
|---|---|---|---|---|---|
| Baseline, runs 1 / 2 / 3 | 76-77 | 1.79 / 11.87 / 12.55; 1.37 / 7.06 / 7.2; 1.42 / 7.22 / 9.87 ms | 238-241 | 9.7-18.4 ms | 8/8 |
| Hang 10 s, run 1 (first test-plug-in build) | 215 | 2.77 / 15.61 / 16.33 ms | 209 | 19.7 ms | 26/26 |
| Hang 10 s, run 2 (first build) | 236 | 1.54 / 9.27 / 11.42 ms | 239 | 13.5 ms | 25/25 |
| Hang 10 s, run 3 (`9e33bc1` build) | 236 | 1.47 / 12.14 / 19.81 ms | 238 | 20.6 ms | 25/25 |
| Gojira X's own slow open (4.3 s inside `open`) | 160 | 1.51 / 10.66 / 11.14 ms | 240 | 14.7 ms | 17/17 |

The limit is 200 ms, so the worst case is a tenth of it. The editor was visible and partly over the app window.

## (c) The editor comes to the front

Sequence that worked: a user action in the app, the app calls `AllowSetForegroundWindow(helper_pid)`, sends `OpenEditor`, and the helper calls `ShowWindow` then `SetForegroundWindow` on the new window. The editor was in front when `open` returned, 13-23 ms after the command for the test plug-in and 40-223 ms for the lighter JUCE plug-ins (the time is the plug-in's; Gojira X took 3.6-4.3 s).

- **Control:** with no `AllowSetForegroundWindow`, the helper's `SetForegroundWindow` returned 0 and the editor stayed behind, in every run that tried it.
- **A trap in the harness, not the design.** The first stand-in tapped Alt to gain foreground rights. An Alt tap toggles the window's system-menu mode, and every second `open` then failed (5 of 10). With a harmless key (F24) it was 10 of 10, and 6 of 6 with no synthetic input at all (the stand-in was already in front). The real app needs neither: the user's click that asks for the editor is the input.

## (d) Typing, and shortcuts that must not fire

- **Typing.** After clicking ML5's SAVE button its preset name turns into an editable field. Two clicks, then "tabplayer", Space and "x" with `SendInput` virtual-key events, made the field read `tabplayer x` (365 pixels changed in the field). Nothing was saved: the editor was closed without Enter.
- **Shortcuts.** With the editor in front, the stand-in's window procedure saw 0 `WM_KEYDOWN` (Space included) and 0 `WM_CHAR`, for all five plug-ins. The real app, with a `keydown` listener in the page, saw 0 keys after a real click on the editor activated it, and 5 of 5 when the same keys were sent with the app in front.
- **Focus inside the helper after attach.** `GetGUIThreadInfo` showed the focus on the host window (`SoundCraftVst3Editor`), not the plug-in's child, for every plug-in until a click. A key typed before any click goes to the host window and is dropped, never to the app. ML5 took focus into its JUCE child after the click. Whether the other three accept typing after a click was not tried.
- **Not usable as evidence:** `document.hasFocus()` stays true under Playwright's CDP focus emulation, so the key counts are the evidence.

## (e) Focus back to TabPlayer

On close the helper calls `AllowSetForegroundWindow(app_pid)`, tears the view down and sends `EditorClosed`. The app calls `SetForegroundWindow(main)`. The stand-in was in front within 0-1 ms in every run, for a close command and for a `WM_CLOSE` (the close button), on all five plug-ins; no visible helper window was left each time.

- **Windows restores it unaided.** The stand-in was already in front before the app called anything, in every run, including with the stand-in pushed to the bottom of the z-order and with the helper not allowing anything. So these runs show that the sequence works; they cannot show that it is needed.
- **The case that would show it was not built.** It needs another process's window to be the one Windows picks, and the previously active window to be gone.
- **Do not take focus the user moved away.** If the user switched to another app while the editor was open, the app should not call `SetForegroundWindow`. The helper knows whether the editor was in front when it closed, so `EditorClosed` should say so.

## Focus hand-off sequence for Task 15

**Open**
1. The app calls `AllowSetForegroundWindow(helper_pid)` just before it sends `OpenEditor`, in response to a user action. Any thread will do.
2. The helper, on its main thread, creates the window unowned and top level (null owner, no `WS_CHILD`), reads `GetDpiForWindow`, then sizes it as under DPI handling below.
3. The helper shows the window, calls `SetForegroundWindow` on it, checks that `GetWindowThreadProcessId` names its own pid (P29), and replies `EditorOpened { hwnd }` with the result of `SetForegroundWindow`.
4. Optional, untried: `SetFocus` on the plug-in's first child, or `onFocus(true)`, so typing works before a click.

**Close** (the app's `CloseEditor`, or the close button, which is `WM_CLOSE`)
1. The helper decides whether the editor was in front, calls `AllowSetForegroundWindow(app_pid)` (the pid comes in `Load`), then `removed`, `setFrame(null)` and `DestroyWindow`.
2. The helper sends `EditorClosed { was_foreground }`.
3. If `was_foreground`, the app calls `SetForegroundWindow` on its own main window with a direct `windows-sys` call. tao's `set_focus` was not tried; it presses Alt, which this spike showed toggles menu mode.

**Never:** an owner or parent link to the app's window (the 8 s stall above); `PostThreadMessage` (P5); Alt taps.

## DPI handling

- The helper sets per-monitor v2 awareness before it makes any window. Task 15 should embed a manifest, or call the API first in `main`; the two are equivalent here.
- Order that worked at 150 %:
  1. create the window (any size) to learn its DPI;
  2. `setContentScaleFactor(dpi / 96)` if the view offers `IPlugViewContentScaleSupport`;
  3. `getSize`, then size the window with `AdjustWindowRectExForDpi` and `GetDpiForWindow` so the **client area** equals the view size;
  4. `setFrame`, `attached`, then **read `getSize` again** and resize if it changed;
  5. honour `resizeView` the same way.
- Sizes are physical pixels. Seen at 150 %:

| Plug-in | `getSize` before scale | after `setContentScaleFactor(1.5)` | after attach | Client area | Clipped |
|---|---|---|---|---|---|
| Amped ML5 | 1200x675 | 1800x1013 | same | 1800x1013 | no |
| Archetype Gojira X | 1024x782 | 1536x1173 | same | 1536x1173 | no |
| SLAMP | 1024x690 | 1024x690 | 1536x1035 | 1536x1035 | no |
| AtlasDSP DI Crank | 387x556 | 581x834 | same | 581x834 | no |
| NadIR (VSTGUI) | 1335x730 | no scale support | 1335x731 | 1335x731 | no |
| Emissary (VSTGUI) | 1202x408 | no scale support | same | 1202x408 | no |
| Test plug-in | 300x200 | no scale support | same | 300x200 | no |

  - SLAMP reports its unscaled size after the scale call and corrects itself on attach, so a host that reads the size once clips it.
  - ML5 without the scale call (`--no-content-scale`) also corrects itself on attach, from 1200x675 to 1800x1013.
  - Emissary draws at 1:1 pixels (it did the same DPI-unaware), so it looks small at 150 %.
- A DPI-unaware helper (the Spike 1 setup) gets `dpi=96` and Windows bitmap-scales the window. ML5 then opened at 1200x675 and was stretched by the system, which is blurry. Per-monitor v2 is the right choice.
- `WM_DPICHANGED` is handled (move to the suggested rectangle), but it was never fired: there is one monitor. Calling `setContentScaleFactor` again after a move is not implemented.

## Blank-editor retest (Spike 1, finding 2)

**Not reproduced.** Emissary and NadIR drew their full interfaces in every run here (112,720 and 7,793 distinct colours; both images were looked at), with:

- the per-monitor v2 helper, active and inactive (the helper not allowed to take the foreground), and the DPI-unaware helper;
- the `GetMessage` loop and the 10 ms `PeekMessage` pump;
- **the unchanged Spike 1 host binary, run again today**, which also drew Emissary (`logs/s4-retest-emissary`).

So the blank windows in Spike 1 were not caused by the Spike 1 host's code, its DPI setting or its message pump, since the same binary draws them now. The cause is unknown: it may have been something in that session's graphics state, or in the plug-ins' first run. The C++ arm was never run, so that comparison stays open; it is no longer needed to explain a failure that cannot be reproduced, but if the blank editors come back, treat Spike 1's finding as live.

## Limits

- **One monitor, one scale (150 %).** No other scale was tested, no monitor move, and no `WM_DPICHANGED` in practice. Nothing was changed to get another scale.
- **(d) typed text in one plug-in.** ML5 only. Gojira X, SLAMP and DI Crank were checked for shortcut leakage only. No plug-in asked for a licence, so none was skipped for that reason. Typing was synthesized with `SendInput`, not real keyboard hardware.
- **(e) cannot show the sequence is needed here.** Windows restored the app unaided in every run (see above). A user who switched to another app, or a closed previous window, was not tested.
- **(b) used the real app but not its future code.** The app had no plug-in or pipe code, so the hung helper was started by the script, and the editor was shown before attach to be visible. The hang is a sleep in `attached`, plus Gojira X's real slow open. A plug-in that hangs inside a paint message or in a modal loop was not tried.
- **The stand-in is not WebView2.** Foreground rights, keyboard routing and message-queue responsiveness are Win32 behaviour and shown on the stand-in. The real app was used for (b) and the keyboard check only.
- **Test plug-in build.** Runs before `9e33bc1` used an uncommitted build of the test plug-in; (b) was rerun on the committed one.
- **Window position.** The editor was placed to the right of the stand-in. A hung editor stacked over the app's window was seen only in the real-app (b) run, where it partly overlapped.
- **Input moves the user's cursor and goes to the foreground window.** It was sent only after `GetForegroundWindow` named the editor (or the app, for the control).

## Reproduce

These commands assume `.analysis/vst-spikes/editor/` as rebuilt from the description above; it is not committed.

```powershell
$env:RUSTUP_TOOLCHAIN = '1.90.0'; $env:CARGO_TARGET_DIR = '<cargo-target>/slot-1'
cargo build --release --manifest-path .analysis/vst-spikes/editor/Cargo.toml   # helper.exe, app.exe
# copy src-tauri/target/debug/tabplayer_test_plugin.dll to .analysis/vst-spikes/editor/plugins/testplug.vst3
# (a), (c), (d) shortcuts, (e), (f) with the stand-in; add --click "x,y;x,y" --text tabplayer for a text field:
app.exe <plugin.vst3> --scenario focus --label x --snapdir snaps
# repeated open/close, z-order test, hang with an owner control, window snapshot:
app.exe <plugin.vst3> --scenario repeat | bury | hang [--owner-control] | shot
# (b) and the real-app key check (needs the desktop test app and a free port 9223):
node .analysis/vst-spikes/editor/cdp-hang.mjs <helper.exe> <plugin.vst3> 10000 hang
node .analysis/vst-spikes/editor/cdp-hang.mjs <helper.exe> <plugin.vst3> 0 keys
```

The worktree's `src-tauri/resources/library` was a junction (Spike 3) and `prepare-library.mjs` refuses symlinks, so it is now a real copy of the main checkout's 16 files (git-ignored). Logs and images are in `.analysis/vst-spikes/editor/logs` and `snaps` (not committed).

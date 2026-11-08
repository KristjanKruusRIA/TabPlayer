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
- **Build.** `RUSTUP_TOOLCHAIN=1.90.0`, `CARGO_TARGET_DIR=E:/cargo-target/slot-1`, release, `--offline`. Dependencies are the Spike 1 pins plus `cpal =0.18.2`, which the app already locks and which was already in the cache, for the device-paced run. Nothing was downloaded.

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
$env:RUSTUP_TOOLCHAIN = '1.90.0'; $env:CARGO_TARGET_DIR = 'E:/cargo-target/slot-1'
cargo build --release --offline --features device --manifest-path .analysis/vst-spikes/ipc/Cargo.toml
# copy vst-spike-ipc.exe to .analysis/vst-spikes/ipc/ipc.exe, then:
.analysis/vst-spikes/ipc/run-all.ps1 -Seconds 600
# one configuration by hand:
.analysis/vst-spikes/ipc/ipc.exe app --helpers 8 --callback 512 --block 128 --depth 2 --seconds 600 --wake event --mode synth:0.11
```

Logs per run (`app.log`, `monitor.log`, `helper-N.log`) are in `.analysis/vst-spikes/ipc/runs/` (not committed).

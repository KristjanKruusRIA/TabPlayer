# VST3 plug-in hosting (THE-71) - validation, 2026-11-08

Branch `feature/vst-hosting`. VST3 audio effects can run on any track in TabPlayer, replacing the track's Drive, Amp, and Cabinet stages while leaving all other effects and the master board intact. Plug-ins run in dedicated out-of-process helper processes to insulate the main application and real-time audio playback from crashes, memory corruption, and UI hangs. This document records the architecture and user-facing behavior, desktop proof evidence, real plug-in acceptance results, benchmark and resource metrics, and the full list of limits and deliberate constraints.

**Status after the review fix (branch `fix/vst-c`, 2026-11-09).** A review found that the first version of this document quoted numbers from the wrong run and that the export, hang and editor checks did not prove what they claimed. The text below has been corrected against the code and the recorded `result.json` files. The two desktop drivers were changed in that fix (export with a gain that changes the sound, hang checked through the Rust side, editor window and state actually checked), and **they have not been run since: they need to be run again** before any of the desktop evidence below counts as evidence for the current drivers. Every run number in "Evidence" is from before this fix and is marked so. The local `tauri build` with the plug-in overlay and the packaged-resource check (plan Task 17 Step 4) have also not been run.

## Behaviour

- **Slot and UI Placement:**
  - In the Sound task / inspector panel, each track features a dedicated **Plug-in slot** (`details.sound-plugin-slot`).
  - Users can select any imported plug-in from a dropdown picker or choose "None" to restore the built-in Drive, Amp, and Cabinet stages.
  - Adding a plug-in ("Add plug-in…") invokes a native Windows file dialog restricted to `.vst3` bundles or single-file packages. There is **no background filesystem scanning**; discovery is strictly on-demand.
  - Probing occurs in an isolated, disposable helper process that checks format compatibility and verifies that the plug-in exposes `Fx` sub-category classes (audio effect processors). Synth and instrument classes are excluded.
  - When a plug-in is selected on Track 1, the Rig view reflects this substitution with a banner (`.rig-replaced-banner`) indicating that Drive, Amp, and Cabinet are replaced by the active plug-in. Board 2 (the second board) is unaffected and cannot host plug-ins.

- **Out-of-Process Execution & IPC Architecture:**
  - Each active plug-in runs inside `tabplayer-plugin-host.exe`.
  - Audio exchange is governed by `ShmRing`—a bidirectional lock-free Windows shared memory ring buffer paired with Win32 auto-reset wake events (`SetEvent` / `WaitForSingleObject`).
  - Audio crosses the ring in blocks of 128 frames (`BLOCK_FRAMES = 128`). The pipeline depth `P` is two device callbacks, rounded up to a whole block (`limits::pipeline_frames`), so it depends on the output device's callback size, not on a fixed number of frames.
  - Control messages and non-realtime events (state serialization, parameter manipulation, window lifecycle) are length-prefixed JSON frames (`u32` little-endian length, then the body) over the helper's **stdin and stdout** (`src/plugins/helper.rs`). There is no named pipe.
  - Watchdog heartbeat supervision monitors helper health; a stall of more than 250 ms (`STALL_GAP` in `plugins/supervisor.rs`) is the trigger it uses.

- **Vendor GUI & Parameter Persistence:**
  - Clicking "Edit plug-in" opens the vendor's graphical user interface inside an unowned top-level Win32 window spawned and managed by the helper process.
  - Closing the editor retrieves the updated plug-in state stream and commits one undo step to the project's edit history when the state differs from the last one; a session that changes nothing records nothing. "Save plug-in settings" (new in the review fix) commits the same way while the editor stays open.
  - Undo and Redo revert and re-apply plug-in settings transparently.
  - Settings history per document is capped at 64 MiB to bound document memory.

- **Latency Compensation & Real-Time Alignment:**
  - The audio engine queries plug-in latency via `IComponent::getLatencySamples()` and reports it in `audio_status` as `pluginDelayFrames`.
  - Tracks without plug-ins or with lower latency are pre-delayed via circular ring buffers so that all audio tracks remain in phase.
  - If a plug-in dynamically reports a latency change during playback, the audio engine re-aligns ring buffers with a crossfade dip of up to `D` frames to eliminate clicks.

- **Document Model, Presets, and Safety:**
  - The track's sound holds a plug-in slot of `{ format, classId, name, vendor, active, inputDb, outputDb, state }` (`PluginSlot` in `src-tauri/src/settings.rs`). `state` is the lowercase SHA-256 id of a **separate document asset** (media type `application/x-tabplayer-plugin-state`), not inline data. The slot has no version field. The document never embeds the raw `.vst3` binary or absolute file paths.
  - Plug-in assignments are stripped when copying sounds (`copySound`) and when saving a named sound (`saveSoundPreset`, fixed in this pass), and are not serialized when exporting to Guitar Pro formats (.gp, .gp5, .gpx).
  - Opening a project containing a plug-in state from an unverified source displays a non-modal `needsConsent` notice banner. The user can click "Allow plug-ins" to activate it. Consent is keyed per `(plug-in, state)`.
  - Older TabPlayer versions refuse documents with plug-in entries.

- **Fault Isolation & Fallback Policy:**
  - **Missing plug-in:** If a plug-in binary is removed or uninstalled, the track status marks `missing`. The engine seamlessly falls back to running the built-in Drive, Amp, and Cabinet models at the plug-in's position. Document edits and state remain unchanged.
  - **Crashed helper:** If a plug-in crashes (e.g. access violation), the host automatically retries launching it up to 3 times (`MAX_CRASH_RETRIES`). If failures persist, the slot latches the `crashed` state, displays an inspector banner, and falls back to built-in tone so playback never goes silent. Clicking "Try again" resets retries and restarts the plug-in. Document edits remain unchanged.
  - **Hung helper:** If an uncooperative plug-in blocks or loops indefinitely, the watchdog reports the status `hung`, the helper is ended, and the built-in tone plays. The first desktop run only evaluated `2 + 2` inside the WebView page, which never reaches the Rust side, so it showed that the renderer was responsive and nothing about the watchdog, the helper or the audio. The corrected driver checks `plugin_status` and `audio_status` (both go through the Tauri core), the helper process and the audio; it has not been run yet.
  - **Live Line-In and Auditions:** Real-time Line-In monitoring and sound palette pitch auditions bypass plug-ins and use the built-in tone to ensure zero-latency monitoring.

---

## Evidence

### 1. Desktop Test Driver (`tests/desktop/parity-vst-plugin.mjs`)

**These numbers are from the run before the review fix, made with the earlier driver (run folder `vst-plugin-c9B0pS`, 2026-11-08 21:15:53 to 21:16:39 UTC, `results/result.json`). The driver has changed and must be run again; this section is not evidence for the current driver.**

Executed against the desktop-test build (`tabplayer.exe`) under `.analysis/desktop-smoke/`:

```powershell
node tests/desktop/parity-vst-plugin.mjs
```

What that run recorded (quoted from its `result.json`; status `passed`, no page errors, no fallbacks), against the test plug-in bundle `TestGain.vst3` (the repository's own `tabplayer-test-plugin`, class ID `7ABB1A7E57E5701C8E5700000000A001`):

| Step | Recorded evidence |
|---|---|
| 1. Add plug-in and choose on track | class ID `7ABB1A7E57E5701C8E5700000000A001` |
| 2. Play, status `ready`, delay frames above 0 | `pluginDelayFrames` 2176, `outputPeak` 0.2999565303325653 |
| 3. Open and close the editor | edits 1 before, 2 after |
| 4. Undo, redo, save, reopen | saved `.tabplayer`; reopened status `ready` |
| 5. Crash mode | notice shown, `outputPeak` 0.2999565303325653 (identical to step 2, see the limit below) |
| 6. Hang mode | `evalElapsedMs` 1.81 for `page.evaluate(() => 2 + 2)` |
| 7. Consent | no numbers recorded |
| 8. Missing | no numbers recorded |
| 9. Export | 288,000 frames both for the plug-in export and the built-in one; `rms` 0.04442280860937364, `peak` 0.20562744140625 |

What this does and does not show:

- **Step 9 proves less than it said.** `export/with-plugin.wav` and `export/builtin.wav` in that run are byte-identical (SHA-256 `d61f93c13e0b...`). The test plug-in at its default settings is an exact pass-through, and, for this score and sound, the built-in path gives the same bytes, so the run cannot tell "the plug-in is in the export" from "the export used the built-in tone". The rms 0.04442 and peak 0.20563 are the numbers of that identical file. (An earlier version of this document quoted rms 0.03517 and peak 0.17072 for this step. Those are the numbers of the AtlasDSP DI Crank acceptance run in section 2, not of this run.) The corrected driver sets the test plug-in's gain to 0.5 through the editor, then asserts that the plug-in export differs from the built-in one, that its level is 0.5 times the built-in level, and that it matches 0.5 times the built-in export sample by sample, which also checks the delay trim. That assertion has not been run.
- **Step 6 proved renderer responsiveness only.** See the hung-helper note above.
- **Step 3's extra edit** came from the test plug-in's editor, which reports an edit when it attaches (`TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT` switches that off); the run did not change a parameter. The corrected driver runs with that switch on, asserts that an open and close without a change records no edit, and that a gain change records exactly one.
- **The live and fallback peaks do not separate plug-in from built-in sound.** Steps 2 and 5 and the SLAMP run all report the same `outputPeak` 0.2999565303325653, so that meter does not show what the plug-in did. The corrected hang step also requires the rendered-frame count to advance after the helper is killed, but the peak remains a weak signal.
- **Step 7 wrote `{}` into `app-data/plugins/consent.json`** (the driver's own file write), not a deletion of `plugin-consent.json`.

The nine step names in the earlier run's output were: add and choose, play with ready status and delay, open and close editor adds one undo step, undo/redo/save/reopen, crash fallback and retry, hang keeps UI responsive, consent, missing, export. They have been renamed in the driver where their meaning changed (steps 3, 6 and 9).

---

### 2. Real Installed Plug-in Acceptance (`tests/desktop/acceptance-vst-real-plugin.mjs`)

Executed against real third-party VST3 plug-ins installed in `C:\Program Files\Common Files\VST3\`. These are run results from before the review fix, taken from each run's `results/real-plugin-report.json`: AtlasDSP DI Crank is run folder `vst-real-acceptance-x5vmlw`, SLAMP is `vst-real-acceptance-wTxLAr`, both on 2026-11-08. The reports' `pluginVersion` is `""` because the earlier driver read a `version` the slot does not have, and `editorVerified: true` was set unconditionally after a 1.5 s sleep, so neither the editor window nor the state was checked in these runs. The versions below come from the earlier spike measurements, not from these reports. Both real plug-ins' exports differ from the built-in baseline (`builtin-baseline.wav` `d61f93c13e0b...`, AtlasDSP export `2a85580c19dd...`, SLAMP export `b606a97c4989...`), so real plug-ins do reach the export; trim alignment was not checked. The driver now checks the editor window, the edit count, the state after reopening and the library version, and it has not been run again.

#### A. AtlasDSP DI Crank
- **File:** `C:\Program Files\Common Files\VST3\AtlasDSP DI Crank.vst3`
- **Vendor / Version:** AtlasDSP, version 1.0.0 (built with VST SDK 3.7.8, JUCE GUI toolkit)
- **Class ID:** `01EFCDAB8291EBFA4D616E754469634B`

**Execution Output:**
```
[Acceptance] Testing real plug-in: C:\Program Files\Common Files\VST3\AtlasDSP DI Crank.vst3
[Acceptance] Found real plug-in option: "AtlasDSP DI Crank (AtlasDSP)" (classId: 01EFCDAB8291EBFA4D616E754469634B)
[Acceptance] Playback active: outputPeak = 0.3074, delayFrames = 2432
[Acceptance] Editor open and close verified.   (unconditional in this driver version, see above)
[Acceptance] Document saved with real plug-in state: ...\real-plugin-saved.tabplayer
[Acceptance] Reopened document verified with status ready.
[Acceptance] Export verified: frames = 288000, rms = 0.03517, peak = 0.17072

REAL PLUG-IN ACCEPTANCE PROOF RESULTS:
{
  "pluginPath": "C:\\Program Files\\Common Files\\VST3\\AtlasDSP DI Crank.vst3",
  "pluginName": "AtlasDSP DI Crank",
  "pluginVendor": "AtlasDSP",
  "pluginVersion": "",
  "classId": "01EFCDAB8291EBFA4D616E754469634B",
  "status": "passed",
  "latencySamples": 2432,
  "livePeak": 0.3074074387550354,
  "editorVerified": true,
  "reopenVerified": true,
  "exportFrames": 288000,
  "exportRms": 0.035168056930985764,
  "exportPeak": 0.17071533203125,
  "startedAt": "2026-11-08T21:14:41.178Z",
  "finishedAt": "2026-11-08T21:14:59.774Z"
}
```

#### B. SLAMP
- **File:** `C:\Program Files\Common Files\VST3\SLAMP.vst3`
- **Vendor / Version:** Oracle Sound, version 1.2.0 (built with VST SDK 3.8.0, JUCE GUI toolkit)
- **Class ID:** `01EFCDAB8291EBFA4D616E75736C6D70`

**Execution Output:**
```
[Acceptance] Testing real plug-in: C:\Program Files\Common Files\VST3\SLAMP.vst3
[Acceptance] Found real plug-in option: "SLAMP (Oracle Sound)" (classId: 01EFCDAB8291EBFA4D616E75736C6D70)
[Acceptance] Playback active: outputPeak = 0.3000, delayFrames = 2176
[Acceptance] Editor open and close verified.
[Acceptance] Document saved with real plug-in state: ...\real-plugin-saved.tabplayer
[Acceptance] Reopened document verified with status ready.
[Acceptance] Export verified: frames = 288000, rms = 0.04212, peak = 0.18689

REAL PLUG-IN ACCEPTANCE PROOF RESULTS:
{
  "pluginPath": "C:\\Program Files\\Common Files\\VST3\\SLAMP.vst3",
  "pluginName": "SLAMP",
  "pluginVendor": "Oracle Sound",
  "pluginVersion": "",
  "classId": "01EFCDAB8291EBFA4D616E75736C6D70",
  "status": "passed",
  "latencySamples": 2176,
  "livePeak": 0.2999565303325653,
  "editorVerified": true,
  "reopenVerified": true,
  "exportFrames": 288000,
  "exportRms": 0.042123718357383,
  "exportPeak": 0.1868896484375,
  "startedAt": "2026-11-08T21:15:12.706Z",
  "finishedAt": "2026-11-08T21:15:31.483Z"
}
```

---

### 3. Spikes and Benchmark Numbers

- **Spike 1 Measurements (Hosting Core & Plug-in Profiles):**
  - **State Container Overhead:** Exactly 20 bytes: the 8-byte magic `TPVST3ST`, a 4-byte version, a 4-byte component length and a 4-byte controller length (`STATE_OVERHEAD = 8 + 4 + 4 + 4` in `plugin-protocol/src/state.rs`). There is no CRC; the document asset id is the SHA-256 of the container.
  - **Plug-in State Sizes and Load Times:**
    | Plug-in | Vendor & Version | State Size (Container) | Latency | Load (Warm) | Process / Block |
    |---|---|---|---|---|---|
    | Gain Example | vst3-rs 0.3.0 | 20 B | 0 | 0.3 ms | 0.1 µs |
    | Ignite Emissary | STL Tones 2.0.2 | 6,909 B | 6 samples | 14 ms | 33.6 µs |
    | AtlasDSP DI Crank | AtlasDSP 1.0.0 | 1,130 B | 256 samples | 9 ms | 7.4 µs |
    | SLAMP | Oracle Sound 1.2.0 | 1,007 B | 0 samples | 22 ms | 89.9 µs |
    | Archetype Gojira X | Neural DSP 1.0.2 | 4,626 B | 36 samples | 4,886 ms | 205.0 µs |
    | Amped ML5 | ML Sound Lab 2.0.0 | 3,180 B | 0 samples | 47 ms | 292.4 µs |
    | Toneforge Menace | Joey Sturgis Tones 1.5.2 | 2,261 B | 0 samples | 25 ms | 53.3 µs |
  - All measured plug-in states were well under the 1 MiB review mark and the 8 MiB per-instance hard limit.
  - State serialization round-trip produced identical bytes on all plug-ins.

- **Spike 2 Measurements (IPC Timing & Ring Sizing):**
  - Block size: 128 frames (`BLOCK_FRAMES = 128`).
  - Pipeline depth: `P = C + max(C, BLOCK_FRAMES)` frames for a device callback of `C` frames, rounded up to a whole block (`limits::pipeline_frames`). That is two callbacks whenever `C` is at least 128, so `P` follows the device callback and is not a fixed number of frames (see Behaviour). The spike ran at 64- and 512-frame callbacks; 64 frames gives 256 (`docs/validation/2026-11-08-vst-spikes.md`).
  - Win32 auto-reset events yielded a p99 IPC hand-off time of 1.28 ms for synthetic workloads and 2.31 ms with 8 real amp plug-ins (Amped ML5) running concurrently over a 10-minute continuous run with **zero underruns**.

- **Resource Budget Verification:**
  - `selected_real_100bar_fourtrack_resource_budget` test passed within budget allocations.

---

## Limits and Exclusions

1. **Platform and Format Scope:** Windows x64 and VST3 format only. Audio Units, CLAP, AAX, and VST2 are not supported. Only 64-bit binaries are loaded. Exactly one plug-in is supported per track, and plug-ins can only replace Drive/Amp/Cabinet on Board 1 (none permitted on Board 2).
2. **On-Demand Discovery Only:** Plug-ins are selected via a file picker dialog targeting single files or bundles. There is no automatic filesystem scanning, monitoring, or background plugin database.
3. **Category Filtering:** Probing evaluates only classes within the `Fx` sub-category. Instrument, MIDI synth, and generator plug-ins are excluded.
4. **Playback Cursor Delay:** The score cursor and playhead positions on screen track raw timeline playback and are not delay-compensated against plug-in latency.
5. **Pre-Seek Tail Bleed:** If a plug-in implementation ignores `setProcessing(false)` or `setActive(false)` during seek operations, a brief audio tail from its internal delay lines or reverb buffers may bleed across seeks.
6. **Dynamic Latency Change Dips:** When a plug-in dynamically reports a latency change during playback (`kLatencyChanged`), the audio engine crossfades and re-aligns ring buffers, introducing a brief audio dip of up to `D` frames on the affected tracks.
7. **Fallback Processing:** When a plug-in fails, crashes, or is missing, the fallback mechanism runs the built-in Drive, Amp, and Cabinet stages grouped together at the plug-in's insertion point.
8. **Line-In and Auditions:** Live Line-In monitoring and sound palette pitch auditions bypass third-party plug-ins and execute through built-in tone stages to preserve zero-latency performance.
9. **Interchange and Preset Stripping:** Plug-in assignments are not exported into Guitar Pro files (.gp, .gp5, .gpx) and are not retained in sound presets (`copySound` deliberately strips the `plugin` field).
10. **Document History Limit:** Plug-in settings history within document undo/redo streams is capped at 64 MiB per document.
11. **Consent Granularity:** Security consent is recorded per `(plug-in, state)` pair in app data.
12. **Version Compatibility:** Older builds of TabPlayer refuse documents containing plug-in configurations.
13. **Windows Error Reporting (WER) Lag:** Under heavy CPU load, a crashed helper process may temporarily report as `Hung` while Windows Error Reporting or post-mortem dump creation delays process termination.
14. **`kReloadComponent` Limit:** The host does not reload the component when a plug-in sends `kReloadComponent`. It treats it like `kIoChanged` and `kLatencyChanged`: it parks the audio thread, deactivates the plug-in, sets it up again and activates it (`restart_plan` in `plugin-host/src/vst3_core.rs`), then tells the app the latency that follows. A plug-in that needs a full reload of its component instance is not served by that. This path has not been exercised with a real plug-in that sends the flag (Task 8 report).
15. **Endless Latency Announcers:** A plug-in that keeps announcing a latency change that does not change the latency is not stopped. Each unchanged reconfigure doubles the wait before the next one, from 1 s up to 32 s (`backoff_interval`), so the effect is a brief dip in that track at growing intervals, for as long as the plug-in keeps announcing. There is no cut-off after a number of tries.
16. **Test Hook Bounds:** The test hook (`TABPLAYER_TEST_PLUGIN_BUNDLE`) substitutes the file picker dialog with the designated bundle path; it does not simulate user dialog cancellation or picking multiple distinct plug-ins within one session.
17. **Untested Configurations & CI Bounds:** Live dynamic DPI scaling changes during active display, dragging editor windows across monitors with mismatched scaling factors, mono-only plug-ins without stereo bus negotiation, and cross-process OS focus switching remain outside CI automation. CI cannot test physical audio devices or proprietary vendor plug-in licensing. Offline WAV export with real plug-ins is **not** verified for alignment: the two acceptance runs checked that the export is not silent, has the baseline's frame count, and differs from the built-in baseline, and nothing more. Trim alignment is checked only by the test-plug-in driver's new gain step, which has not been run.
18. **Drivers Need a Re-run:** Both desktop drivers changed in the review fix and have not been run since (another session held port 9223). All run numbers in this document are from the earlier drivers.
19. **Placeholder Size in the Edit Preview:** The plug-in state asset candidate that the UI hands to the preview has a placeholder `byteLength` of 20, because the native commands do not return the asset's real size. Nothing in the UI shows that number.
20. **Library Gaps (not part of this pass):** library entries are not marked "missing" in the list, and the "moved to another file" note on an entry never clears. These are Rust-side and belong to the library owner. (`previous_bundle` is now checked like the bundle, and a library that would not fit its 1 MiB file with it is written without it: commit 19fd9c2, `plugins/library.rs`, and `docs/validation/2026-11-09-vst-review-fixes.md`.)
21. **Untested Status Change Behaviour:** `record_status` in `plugins/service.rs` now emits a status change event on every status change from `ensure` (shipped in the docs commit ff786b4). No test covers that it settles or that an unchanged status emits nothing. That belongs to the Rust service owner.
22. **Device Fault Pause:** `renderer.pause()` in the device fault path (`audio/device.rs`) has no test of its own.

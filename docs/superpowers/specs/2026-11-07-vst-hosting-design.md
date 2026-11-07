# Plug-in hosting on tracks: design (THE-71)

Status: draft for decision, 2026-11-07. Requested on 2026-10-30 so a full guitar amp plug-in can run on the clean tone (`docs/backlog.md`, "Load VST plug-ins on a track"). The research behind this design was read from the code at `0f43a53` and from web sources accessed on 2026-11-07. Citations below are repo `file:line` or URLs.

## Goal

The user loads one VST3 effect onto a track, in place of the built-in drive, amp and cabinet. It plays live and in exports, and its editor opens from the sound panel. Its settings are saved in the document. A crash, hang or missing plug-in never takes down the app or stops playback: the track falls back to the built-in tone with a notice.

## Facts that shape the design

- **Licence.** The VST3 SDK has been MIT since 3.8.0 (2025-10-20, [vst3sdk README](https://github.com/steinbergmedia/vst3sdk/blob/master/README.md), [Steinberg forum](https://forums.steinberg.net/t/vst-3-8-0-sdk-released/1011988)). Pre-3.8 copies were GPLv3 or proprietary and must not be used. CLAP is MIT. VST2 cannot be supported: its SDK and licences were withdrawn in 2018, and no new host licences are issued.
- **No hosting crate is ready to depend on.** Every Rust VST3 host crate is from 2026, small, and untested on Windows or Linux. The raw `vst3` bindings (coupler-rs, MIT OR Apache-2.0, 0.3.0, no SDK checkout needed) and `clack-host` for CLAP (MIT OR Apache-2.0) are usable building blocks. `vst3-sys` is GPLv3 and dormant, so it is rejected. JUCE is AGPL or commercial, so it is rejected.
- **The renderer is per-sample with zero latency, and has no delay compensation** (`audio/renderer.rs:1109`, `audio/ir_convolver.rs:1`, `audio/master.rs:72-75`). The audio thread never allocates, locks or loads (`audio/tone.rs:3-4`, `audio/midi_out.rs:15-18`).
- **The callback renders its whole device buffer in a burst** (`audio/device.rs:1401-1415, 1758`). So a plug-in's wet output for one callback can only be ready for the next one.
- **Precedents to copy:**
  - The cabinet IR shows how a document names a resource on this machine and falls back when it is missing (`audio/dsp.rs:50-97`, `audio/cabinet_ir.rs:1027-1031`, `src/audio/CabinetNotices.tsx`).
  - MIDI out shows a route opened off the audio thread before install (`audio/device.rs:2386, 2656-2661`).
  - Content-addressed assets hold the plug-in state (`assets.rs:6-12`, `project.rs:518-524`).

## Design

### Process model: one helper process per plug-in instance

- A separate small executable, `tabplayer-plugin-host`, ships as a Tauri `externalBin`. It is not the main exe re-launched, because single-instance mode, WebView dependencies and macOS entitlements are all per executable.
- Exactly one plug-in instance runs in each helper. Audio crosses in a shared-memory ring, and control messages cross a pipe.
- On Windows, helpers run in a Job Object with kill-on-close so they die with the app. On Unix, a helper exits when the parent pipe closes.
- The helper's audio thread joins MMCSS "Pro Audio" on Windows.
- **Watchdog.** The helper's audio thread bumps a heartbeat in shared memory. A non-realtime supervisor in the app kills a helper that misses its deadline. The heartbeat must not come from the UI thread, or a plug-in's licence dialog would read as a hang.
- In-process hosting is rejected: a crash or hang there takes down the app or the audio callback.

### Audio path

- The plug-in replaces the track's Drive, Amp and Cabinet stages (`audio/dsp.rs:1962-1973`). It sits where the first of those three stands in the track's effective stage order. The board is split there, so the stages before it feed the plug-in and its output feeds the stages after it.
- The built-in blocks stay in the document, so falling back means switching them back on.
- The `second` board cannot hold a plug-in in v1.
- **Pipelined bridge.** Frames are collected into blocks of 128 and handed over through a lock-free shared-memory ring. Results are read back `P` frames later, with `P` set to two device callbacks. The helper's own latency `L` is added on top, so the track's delay is `D = P + L`.
- **Delay compensation.** Every other track's output, the backing track (read at `seconds − D/rate`), the click and MIDI-out frame stamps are delayed by `D_max − D_i`. The delay is reported in the native status.
- **Loop wrap and seek.** The delay lines and the bridge keep streaming through a loop wrap and are flushed only on a user stop or seek. Otherwise every loop would start with a silent gap.
- **Underrun, NaN or crash.** The track crossfades to the built-in chain over 10 ms, as `TrackDsp` transitions do (`dsp.rs:1595`), and reports the reason. Output never drops to silence.
- **Latency.** The latency is read at load. A latency-changed notice from the plug-in is treated as a re-prepare. Latency above 100 ms is refused with a notice.
- Tempo, meter and transport state go to the plug-in through `ProcessContext`, using the renderer's per-frame BPM and meter.

### Editor

- The helper owns a separate top-level window on every platform.
- On Windows, the window is not parented or owned by the Tauri window. A parent or owner link joins the two windows' input queues, so a hung plug-in UI would freeze TabPlayer ([Raymond Chen](https://devblogs.microsoft.com/oldnewthing/20130412-00/?p=4683)).
- On macOS, an `NSView` cannot cross processes.
- On Linux, the editor runs as a top-level X11/XWayland window with a host-provided `IRunLoop`.
- The sound panel has "Edit plug-in" and a status line. Focus and shortcuts are not shared with TabPlayer, and the UI says so.

### Document

- `TrackSound.plugin?: PluginSlot` has these fields:
  - `format` is `"vst3"`, with `"clap"` reserved;
  - `classId` is the plug-in's 32-hex class ID;
  - `name` and `vendor` are shown when the plug-in is missing;
  - `active`;
  - `inputDb` and `outputDb` range from −12 to +12 dB;
  - `state` is the asset id (SHA-256) of a container holding the component and controller state.
- The field is `deny_unknown_fields`, and an absent field round-trips byte-identical. Old projects replay unchanged. An older build refuses a project holding a plug-in, which is the documented fail-closed behaviour.
- **Never a path.** The document never holds a path or file name. The app maps `(format, classId)` to a bundle in its own per-user plug-in library, built from files the user chose. An untrusted document therefore cannot make the app load arbitrary native code.
- **State is an asset, not inline.** It is staged with the edit, named by `EditCommand::asset_id()` so a save keeps it, and capped at 8 MiB per blob before decoding. The hash is checked, and the bytes are passed only to the helper.
- **One edit per editor session.** Choosing or removing a plug-in is one `SetTrackSound`. Tweaks inside the plug-in's editor become one edit when the editor closes, or on "Save plug-in settings". A state that hashes to the current one records nothing.
- **Consent.** The first time a document that came from elsewhere names a plug-in on this machine, the user confirms before any plug-in code loads. The consent is remembered per document and plug-in.
- **Edit lock.** In edit-locked documents plug-in edits are refused like other sound edits. The editor still opens, read-only in effect: changes are not saved.

### Fallback and notices

- `plugin_status` reports one of `ready`, `missing`, `unreadable`, `crashed`, `hung`, `needsConsent`, `unsupportedPlatform`, `tooMuchLatency` or `rejectedState`.
- The notice appears in the sound panel, in the document-level notices and in the export dialog. It names the plug-in and says the built-in tone plays and the document is unchanged.
- All text goes through `src/i18n` with `en`, `et` and `de`.

### Export

- Exports include plug-ins. A fresh helper runs in offline mode with no pipeline. The reported latency is trimmed, and the tail is flushed through the existing tail setting. Stems are aligned the same way.
- A missing plug-in exports with the built-in tone and a warning.
- Audition clips use the built-in tone, because a plug-in per note click is not acceptable.
- The render-equals-playback bit-exactness tests exclude plug-in tracks.

### Testing

- CI covers these on all three operating systems:
  - the document schema and old-document round trips;
  - asset staging and pruning;
  - hostile-input caps;
  - the ring protocol, with no allocation on the callback side;
  - fallback and notice text;
  - end to end against a **test plug-in** built from the `vst3` crate's MIT/Apache `examples/gain.rs`, extended with a state blob, a latency parameter, and triggers for crash, hang and NaN.
- The end-to-end tests cover load, processing, delay alignment of an impulse, state round trips, crash and hang fallback within a bounded time, export trim and tail, and missing bundles.
- CI cannot test real vendor plug-ins, real devices, cross-process focus, or notarisation. A local acceptance script checks a real amp plug-in and records the results in `docs/validation/`.

## Slices

1. **Spikes.** These decide the hosting approach before any feature code:
   - a Rust COM host on `vst3` versus a small C++ helper on the SDK's MIT hosting classes, judged by loading the test plug-in and two or three real amp plug-ins;
   - IPC hand-off timing at block sizes 64, 128 and 256;
   - loop-wrap continuity with delay compensation;
   - cross-process editor focus on Windows;
   - real state sizes and latency reports.
2. **First shippable slice (Windows x64, VST3).**
   - The user chooses a plug-in file, which goes into the plug-in library through a throwaway probe helper with a timeout.
   - The helper, the bridge and delay compensation.
   - One plug-in per track, a helper-owned editor, and state as an asset.
   - Consent, fallback and notices.
   - Offline export.
   - On macOS and Linux the helper builds as an `unsupportedPlatform` stub, so CI stays green and documents fall back with a notice.
3. Scanning the standard VST3 folders, with a per-file probe timeout, a cache and a blocklist.
4. macOS helper (an NSWindow, the library-validation entitlement on the helper only, notarisation) and Linux helper (X11 and `IRunLoop`).
5. CLAP through `clack-host`, using the same helper protocol.
6. Later: macro knobs and automation, `.vstpreset`, A/B against the built-in tone, Line-In through a plug-in, shared helpers, several plug-ins per track, and freezing a plug-in track to audio.

## Decisions for the user

1. Ship Windows first (recommended), or wait for all three platforms?
2. Also, or instead, load **NAM captures** (`.nam`, Neural Amp Modeler Core is MIT) through the built-in amp slot. This gives "a full amp" with no plug-in hosting, no helper process and no added latency. It is a separate, much smaller feature. Recommended as a cheaper first step that does not replace VST3 hosting.
3. Is a Rust-only host required, or may the helper use the SDK's C++ hosting classes? C++ adds CMake and a C++ toolchain to the build. Recommended: decide after spike 1, with Rust preferred.

## Rulings already made (recommendations from the research, adopted)

- One helper per instance.
- The plug-in replaces Drive, Amp and Cabinet at the first of their positions.
- No plug-in on the second board.
- An 8 MiB state cap.
- Consent before the first load.
- Seamless loop wrap.
- No VST2.
- "VST3" appears as plain text with no logo, and the Steinberg MIT notice goes into `THIRD_PARTY_NOTICES.md`.
- Any new dependency, and the bridge, get a hot-path review.

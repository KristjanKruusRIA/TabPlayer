# VST3 instrument hosting on drum tracks (THE-218) - validation, 2026-11-17

Branch `agy/the-218-instrument-hosting`. A drum track can hold a VST3 instrument (a drum sampler or synthesizer) in the plug-in slot that effects already used (THE-71, `2026-11-08-vst-hosting.md`). The instrument plays the track in place of the built-in kit; the score's notes reach it as MIDI note events. Windows and VST3 only. This note records what was built, how each claim was checked, and what is not done. The only plug-in that has been run is the repository's own synthetic test plug-in; no commercial instrument has been tried.

Results below were obtained on Windows on 2026-11-17. The Rust and Vitest results are from commit `39736fe`; the desktop results are from the same commit plus the small interface and driver changes listed under "Desktop run".

## What was built

- **Protocol v2 note events** (`plugin-protocol`: `event.rs`, `ring.rs`, `control.rs`, `limits.rs`). The input ring carries MIDI words (NoteOn, NoteOff, controller, AllNotesOff) with a frame offset inside the block, alongside the audio. The strict decoder rejects anything malformed. Events cannot be lost silently, and a failed block releases its notes (review findings below).
- **Helper** (`plugin-host`: `notes.rs`, `audio.rs`, `vst3/instance.rs`, `probe.rs`). The probe now admits instrument classes (`Instrument` sub-categories) next to effects, and the helper negotiates an event input bus and a stereo output for them. A note guard sits between the ring and the plug-in: it never forwards a NoteOff for a key it did not start, turns a retrigger into a NoteOff then a NoteOn, drops controllers, and releases every sounding key on a new epoch, a lapped or torn read, a pause and a stale block. A block that failed releases its notes.
- **Slot `kind`** (`settings.rs`, `edit_types.rs`, `plugins/library.rs`, `src/edit-types.ts`). The slot and the library entry say `instrument`; an effect has no `kind` key, so files that never used an instrument are unchanged. A library that holds an instrument is written as version 2, which an older build reads as a newer library and leaves alone. An instrument slot on a track that is not a percussion track is refused before any helper starts, takes none of the eight places, and has a status of its own (`instrumentNeedsDrums`) that says the track's own sound plays.
- **Staging, priming and placement** (`audio/plugin_insert.rs`, `audio/instrument.rs`, `audio/dsp.rs`). An instrument sits at the board's input, an effect where Drive, Amp and Cabinet are. The insert stages the note events for the block it gathers and sends them with it. After a flush the first hit is the plug-in alone, not a blend with the built-in kit. A priming instrument whose first result is late is held silent and played whole, and rejoins the timing grid at the frame the grid is at. A switch between an instrument and an effect is click-free, and the crossfade state has one writer per frame. The plan's channel, key and velocity pass through unchanged (an identity map, `instrument.rs`).
- **Renderer seam** (`audio/renderer.rs`, `device.rs`, `runtime.rs`). The renderer sends a drum track's notes to its instrument, lets go of the keys at a loop wrap, at a stop and at the end, and ends the keys an edited plan no longer holds while keeping the others. An edit while playing hands the notes and events between the old renderer's last frame and the next to the new renderer: the last dispatched tick is carried forward, so nothing is lost or sent twice, even across two hand-overs before a frame is rendered.
- **Export** (`export/audio.rs`). An export renders the instrument with its first hit on the exact sample, and a missing or failing instrument behaves as an effect does (the built-in kit plays, with a warning).
- **Interface** (`src/audio/PluginSlotPanel.tsx`, `PluginNotices.tsx`, `DrumKitPicker.tsx`, `src/rig/*`, `src/mixer/MixerView.tsx`, `src/i18n`). A drum track's plug-in select has two groups, Instruments and Effects; any other track lists effects only. The library list shows a kind label per entry. An instrument slot hides the input trim, shows the output trim, shows a banner in the Rig and a kit note that says the kit and its mix apply to the built-in kit only, and has notices that end in "the built-in kit plays instead". Text is in English, Estonian and German.

## How it was checked

### Rust and Vitest, at `39736fe`

| Check | Command | Result |
|---|---|---|
| Format | `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | clean |
| Workspace tests | `cargo test --locked --workspace --no-fail-fast` | exit 0, 100 test programs ok |
| Real helper, export | `plugin_export` (ignored tests, run with `--ignored`) | 9 passed |
| Real helper | `plugin_helper` (ignored) | 17 passed |
| Real helper, instrument | `plugin_instrument` (ignored) | 5 passed |
| Real helper, playback | `plugin_playback` (ignored) | 11 passed |
| Helper crate | `tabplayer-plugin-host -- --ignored` | 3 + 37 passed |
| Resource budget | `selected_real_100bar_fourtrack_resource_budget` (ignored, release) | passed |
| Types | `npm run typecheck` | clean |
| Secrets | `node scripts/secret-scan.mjs` | 0 findings |
| Everything in Vitest | `npm test` | 7457 passed, 8 skipped |

The tests that carry the instrument claims: `src-tauri/tests/audio_plugin_instrument.rs` (renderer, priming, placement, hand-over, loop, stop and end releases, at plug-in latencies of 0, 64, 100, 128 and 192 and every lateness up to the fault deadline, with a fake instrument helper that has the real guard's lapped, torn and stale-block releases); `src-tauri/tests/plugin_instrument.rs` (the real helper and the test plug-in's drum class, played and exported at latencies of 0, 100 and 128, two exports compared byte for byte); `src-tauri/plugin-host/src/notes.rs` and `src-tauri/plugin-protocol/src/event.rs`, `ring.rs` (unit tests of the guard and the codec); `src-tauri/tests/plugin_document.rs` and `plugin_export.rs` (slot kind, refusal on a non-drum track, export warnings); `src/audio/plugin-instrument.test.tsx` and `plugin-slot.test.tsx` (select groups, trims, banner, notices); `tests/plugin-slot-protocol.json` (the shared fixture both sides read).

### Two adversarial reviews

Two fresh-context adversarial reviews were made and their findings fixed (commit messages in brackets):

1. Effects are listed before instruments, so the 64-class cap never costs an effect its place (`126dc73`).
2. Events cannot be lost silently and a failed block releases its notes (`1225466`).
3. Held notes are re-synchronised to the new plan at an edit hand-over (`959994d`).
4. No event is lost or sent twice across a hand-over, also across two hand-overs before a frame (`c1c2e52`, `f624633`, `39736fe`).
5. The instrument rejoins the timing grid after a late first block, instead of trailing it (`0dd89b5`, `8f16d71`).
6. The plug-in crossfade state has one writer per frame (`0be18f2`).
7. An instrument slot on a non-percussion track is refused, takes no place, and has its own status, with an export warning (`880db35`, `d8e1fd5`); a slot named as another kind than the running helper loaded replaces that helper (`d489908`), and a faulted slot remembers the kind it was asked to load (`1c82ca6`).

### Desktop run (slice S9)

Driver `tests/desktop/parity-vst-instrument.mjs`, run from the checkout root against `.analysis/desktop-smoke/tabplayer.exe`, which `scripts/build-desktop-test.ps1` builds with the `desktop-test` feature, with the helper and the synthetic test plug-in beside it. It launches the app, attaches over CDP on port 9223 and drives the real interface. The score has a guitar track of rests and a drum track with a kick and a snare on every beat, 8 bars at 120 bpm. The plug-in is the test plug-in's drum class, "TabPlayer Test Drum": a square wave whose amplitude says which key was played and how hard.

```powershell
node tests/desktop/parity-vst-instrument.mjs
```

Result: status `passed`, seven checks and the screenshots.

| Step | What the run recorded |
|---|---|
| 1. Library | Adding the bundle lists "TabPlayer Test Gain" with the label "effect" and "TabPlayer Test Drum" with the label "instrument". |
| 2. Select | On the guitar track the select offers the built-in tone and the effect, with no groups. On the drum track it has two groups, "Instruments" (the drum) and "Effects" (the gain). |
| 3. Choose | One `setTrackSound` edit; Undo takes it back (edits 0 then 0, select back to the built-in kit), Redo restores it, choosing the same instrument again records nothing. The slot has `kind: instrument`. The input trim is not in the page; the output trim is. The kit note is in the sound panel and in the Rig's drum kit popover. The Rig shows the banner "This plug-in plays this track. The built-in kit plays when the plug-in is unavailable." and no "Drive, Amp and Cabinet are replaced" text. |
| 4. Play | Status `ready`, `pluginDelayFrames` 2176, rendered frames advance with no audio error, `ready` after Stop and after a seek to bar 5, and after playing again. The live peak reaches 0.214, above anything the built-in kit reaches on this score (0.13). |
| 5. Crash | With the test plug-in in crash mode the slot reports `crashed`, the notice reads "The plug-in "TabPlayer Test Drum" crashed, so the built-in kit plays instead. The document is unchanged.", playback goes on (frames advance, peak above 0.001), the edit count does not change, and Try again returns the slot to `ready`. |
| 6. Save and reopen | After saving, closing the app and opening the file in a new run, the slot is the instrument, `ready`, with the same delay of 2176 frames, and plays (peak 0.203). |
| 7. Export | 864,000 frames for both the instrument export and the built-in kit's. The instrument export is not silent (rms 0.197 against 0.014 for the built-in kit, peak 0.214 against 0.130), differs from the built-in file, begins on the first frame (sample 0.203), and starts the snare on frame 24,000 (beat 2 at 120 bpm) at 1.054 times the kick's level, which is the ratio of keys 38 and 36 at the same velocity. |
| 8. Screenshots | Written under `.analysis/desktop-smoke/<run>/shots/` (git-ignored, not committed): the sound panel, the select open as a list box showing its two groups, the Rig banner, the Rig kit note popover and the crashed notice, each in English, Estonian and German. |

What was seen in the screenshots, and what was fixed:

- **Fixed.** The page-level plug-in notices (a crash, a missing plug-in, the built-in kit playing instead) had no style: the text sat against the window edge with no padding and the Try again button under it, and pushed the whole workspace down. This is older than this branch (effects used the same notices), but an instrument notice is the longest. `.plugin-notices` now has the box style of the cabinet notices (`src/audio/sound-panel.css`), checked by `src/audio/plugin-notices-style.test.ts` and by a screenshot.
- Seen and left, not defects of this work: the slot's select cuts a long plug-in name ("TabPlayer Test Drum (T..."); the Rig's drum kit popover is mostly English in Estonian and German (existing strings of the kit popover that were never translated); the Rig still shows the Drive, Amp and Cabinet pedals for a drum track with an instrument, which is right (they process the instrument's output) but nothing says so.
- The app has one dark theme, so there is no light screenshot.
- Estonian and German texts of the instrument notices, the banner and the kit note appear whole and unclipped; their wording is not reviewed.

Driver notes, stated plainly:

- The live level meter keeps the last playback's peak until new audio arrives. The first reading of step 4 (0.1206) is the built-in kit's from the previous playback; the driver waits for 0.19 or more, which the built-in kit does not reach.
- The export's master stage scales the plug-in's output (about 0.72 of the drum's own amplitude), so the driver does not decode keys from samples; it checks that the first hit and the beat-2 hit start on their exact frames and compare as keys 36 and 38.
- Playing back a drum note is not the same as hearing it. Nothing here was listened to.

The existing effect driver `tests/desktop/parity-vst-plugin.mjs` still opened the track's sound in the inspector, which has been a modal "Sound and pedalboard" dialog for some time, so it could not run at all on this build. Its `openSound` now opens the dialog, and it closes or opens the dialog where its steps need the page behind it. With that change `node tests/desktop/parity-vst-plugin.mjs` ran to status `passed`, all nine steps: add and choose, play with `pluginDelayFrames` 2176, editor open and close as one undo step, undo/redo/save/reopen, crash, hang, consent, missing, and the export with gain 0.5 (288,000 frames for both exports, rms ratio 0.50000, worst sample error 3.05e-05). Effects therefore still pass with instruments in the build. This is also the first run of that driver since the review fix described in `2026-11-08-vst-hosting.md`, which had asked for one.

## Limits

1. **Windows only.** macOS and Linux have no helper. They run only the cross-platform tests in CI, and that CI run has not happened yet for this branch.
2. **Only the synthetic test plug-in has been run.** No commercial instrument has been loaded, so what real drum libraries do (their output buses, their presets, their sample streaming, their editor) is untested.
3. **No warm-up, no streaming-sampler support.** A drum library that loads its samples in the background may give silent first hits, or a silent start to an export. Nothing waits for it.
4. **Load timeout and state size untested at scale.** The 30 second load timeout (`LOAD_TIMEOUT`) and the 8 MiB state limit (`MAX_STATE_BYTES`) have not been exercised against a large library; the test plug-in's state is a few dozen bytes.
5. **No drum map.** Notes are sent on the percussion channel as written in the plan, with the General MIDI keys; the map is the identity (`audio/instrument.rs`). Articulations that share a key cannot be told apart. The drum map is THE-219.
6. **Only notes.** Controllers (hi-hat openness), program changes and pitch bend are not sent; the helper drops controllers by design (`notes.rs`).
7. **Only the main stereo output.** A kit preset that routes drums to other outputs is silent on those. A mono output is accepted; more than the main stereo bus is not used.
8. **Per-drum-element mix applies only to the built-in kit.** The kit note says so in the interface.
9. **One slot per track.** An instrument replaces an effect on that track. Instruments are for drum tracks only; a slot on another track is refused and the track's own sound plays.
10. **A hit that began just before a seek is not re-struck.** The built-in kit re-strikes held notes after a seek or at the start of a range export; an instrument does not receive them, so a long note that is already sounding at that point is silent until the next hit. The same holds at the start of a range export.
11. **Sampler that ignores note-off.** A one-shot sampler that ignores NoteOff is cut at the end of the export tail.
12. **Swapped out mid-note.** When an instrument is replaced while a note sounds, it is not sent a release while it fades out; its helper is shut down afterwards.
13. **Library version 2.** A library file that holds an instrument is written as version 2. An older TabPlayer treats it as a newer library and does not list, change or write it.
14. **Unreviewed text.** The Estonian and German texts are unreviewed.
15. **Not tried by ear.** The owner has not yet listened to it. The desktop run proves status, levels, frame positions and notices; it does not prove that it sounds right.
16. **Desktop run scope.** One run of each driver on one machine; port 9223 held by nothing else. The effect driver was adjusted to the dialog in this pass and has passed once; the run numbers quoted in `2026-11-08-vst-hosting.md` are still those of the earlier driver.
17. **Build script.** `scripts/build-desktop-test.ps1` fails in a worktree at `scripts/prepare-library.mjs`, which refuses the junctioned `src-tauri/resources/library` as a destination. The first attempt had already run the asset, font and audio-verify steps and prepared `public/library`. The desktop app for this run was then built with the same script text and test configuration, except that the pre-build command was replaced by the notice step, the type check and the Vite build; the audio and library resources behind the junctions were verified, not rewritten.

## Silent output for the desktop tests (added 2026-11-17)

**What.** The desktop test build (`desktop-test` feature) hands the output device silence. The stream callback still renders, meters, counts frames and keeps device-rate pacing, so timing, underruns, peak meters and "frames rendered" are those of a normal run; only the samples copied into the device buffer are zeroed (`OutputCallback::render_with`, after `render_into` has metered the block, using `audio::silent_output::silence_block`). It is on by default; `TABPLAYER_TEST_SILENT_OUTPUT=0` in the shell that starts a driver turns it off. The variable is read once at start-up (`run`), off the audio thread, into an atomic the callback loads without locking or allocating.

**Why.** The drivers press Play and the owner hears them. They read status, meters and exported files, never the speakers. The synthetic drum was also a full-level wave near 11 kHz. It is now a square wave of 96 frames per period (a few hundred hertz); its level, which the tests decode, is unchanged. A lower level would have broken the driver's separation of the drum (about 0.2) from the built-in kit (0.13).

**Guard.** Without the feature there is no flag, no environment read and no zeroing: `silent_output::active()` is a `const fn` returning `false` and a `const` assertion checks it, so a shipping build fails to compile if that changes. The `desktop_test_silent_output` command exists only with the feature and the drivers ask it before pressing Play: `harness.mjs` `connect()` and the three plug-in drivers call `assertSilentOutput` (`tests/desktop/silent-output.mjs`), and the shared launch helpers (`harness.mjs` `launch`, `stringCountEnvironment`) set the variable. Drivers that launch the app themselves without those helpers rely on the app's default.

**How verified.** Unit test `silent_output_zeroes_the_device_but_not_the_meters_or_the_frame_count` (run with `--features desktop-test`) plays a click through a callback twice: the silent run's device buffer is all zeros while `output_peak`, `rendered_frames` and `tick` equal the audible run's. Pure-function tests cover `f32`, `i16` and `u16` blocks and the variable's meaning. With silent output asserted by the driver first, `parity-vst-plugin.mjs`, `parity-vst-instrument.mjs` (full), `parity-drum-map.mjs`, `inspector-fixes.mjs` (14 checks) and `parity-midi-out.mjs` all passed on the rebuilt test app, with no selector fixes needed after the Plug-in dialog split. The ignored real-helper Rust tests (`plugin_*`, plug-in host `helper`) passed with the new drum period.

**Limits.** The real-helper Rust tests never open an output device, so the mode does not apply to them. Silence is checked through the app's own report, not by recording the device. Drivers that launch the app without the shared helpers, and the two PowerShell-launched ones, were not run in this pass. macOS and Linux were not built with the feature. The test app was built with a copy of the build script kept outside the repository, whose frontend step ran only the notices step, `tsc` and `vite build`.

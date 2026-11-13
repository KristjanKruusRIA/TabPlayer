# Antigravity handoff: VST hosting, Tasks 12 to 18

TabPlayer can now host VST3 plug-ins in a separate helper process. Tasks 1 to 11 of the plan are done and reviewed on `feature/vst-hosting`: spikes, document field, protocol crate, test plug-in, helper, client and supervisor, plug-in library, and the real-time insert in `TrackDsp`. This handoff covers the rest of the plan.

- **Plan:** `docs/superpowers/plans/2026-11-08-vst-hosting.md`. Every task has its exact files, interfaces, tests and values.
- **Spec, the authority when the plan is unclear:** `docs/superpowers/specs/2026-11-07-vst-hosting-design.md`. Linear THE-71.
- **Decisions so far:** `.superpowers/sdd/2026-11-08-vst-hosting/progress.md`. It is git-ignored, but present in this worktree. Each task's carried items are copied below, so you don't need to search it.

The tasks build on each other. Do them **one per job, in order**: 12, 13, 14, 15, 16, 17, 18. After each job, Claude reviews the diff before the next job starts.

| # | Task | Tier | Notes |
|---|---|---|---|
| 12 | Delay compensation, wrap, seek, count-in and end | pro | real-time audio code |
| 13 | Plug-in service, prepare, consent and statuses | pro | largest task; many carried items |
| 14 | Export through offline helpers | pro | |
| 15 | Editor sessions | pro | Windows window focus; see the Spike 4 rulings |
| 16 | Sound panel, notices and i18n | pro | UI; en, et and de |
| 17 | Packaging, CI, notices and docs | pro | CI change, so it is hot path for review |
| 18 | Desktop proof, acceptance script and validation doc | pro | needs the desktop app on port 9223 |

## Starting a task

The worktree already exists, with `node_modules` linked. From `<checkout>\.worktrees\vst-hosting`, in Git Bash:

```bash
agy-job.sh start --tier pro --yolo --dir . --timeout 180m "Read docs/handoffs/2026-11-08-antigravity-vst.md. Follow its Shared rules, then do Task 12 only."
```

Change the task number for each job. `agy-job.sh status <id>` shows progress, and `agy-job.sh result <id>` fetches the report.

## Shared rules

- **Branch:** work on `feature/vst-hosting` only. Commit only there. Never merge it into develop, and never push.
- **Requirements:** read your task's section of the plan in full. Its file list, interfaces, test names and values are the requirements. Use them exactly. If the plan and the spec disagree, follow the spec and say so in the report.
- **Tests first:** write the task's failing tests, run them and see them fail, then implement. Never delete, skip, loosen or `#[ignore]` an existing test to get a pass. If a test seems wrong, explain why in the report and leave it alone.
- **Real-time safety:** code on the audio thread must not allocate, lock, block or make system calls. Use the counting allocator from `src-tauri/tests/audio_tone.rs` as Task 11 does. Do not retune `src-tauri/src/audio/tone.rs`. With no plug-in, audio must stay bit-identical.
- **Untrusted input:** everything the helper or a plug-in sends is untrusted: indices, sizes, latency, samples, names and state. Imported files are untrusted too.
- **Cargo:** keep build output in the default `src-tauri/target`. If it is busy, use `<cargo-target>/slot-1` to `slot-3`, but only for `cargo test`. Never use a temp or scratch folder for builds. Never run a full `cargo test --workspace`. Run single targets (`--lib`, `--test <name>`) with `-j 2`. `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` must pass.
- **Vitest:** run the files you touched. Restore `src/audio/__snapshots__/plan.performance.test.ts.snap` with `git restore` if a run rewrites it.
- **Missing fixtures:** this worktree has no `.analysis/compatibility` fixtures, so `plan.test.ts` and some audio Rust tests fail here for that reason alone. Name them; don't "fix" them.
- **Project rules:**
  - Old `.tabplayer` projects and edit logs must stay replayable.
  - One gesture is one undoable edit, and choosing the current value records nothing.
  - New UI text goes through `src/i18n` with `en`, `et` and `de` entries.
  - A control holding focus never gets `disabled` for busy; use `src/ui/useBusyGuard.ts`.
- **Safety:** do not install, buy, register or sign in to any plug-in or software, and do not change system settings. Only use plug-ins already installed, and the repository's own test plug-in. Never commit plug-in binaries, private scores or generated test output.
- **Desktop app:** don't run desktop drivers (CDP port 9223) except in Task 18. Kill any `tabplayer.exe` you start.
- **Report:** finish each job with a report written to `.superpowers/sdd/2026-11-08-vst-hosting/task-<N>-report.md`. Include:
  - the commits;
  - every test command and its result;
  - each place you departed from the plan, and why;
  - Limits, stated plainly.

  Partial work is reported as partial.

## Carried items per task

These are rulings and hand-offs from Tasks 1 to 11. They are part of each task's requirements.

### Task 12
- **Delay shift:** compensate the track's overall shift by `D` when a plug-in is added or removed. Task 11 leaves this to you.
- **Seek and stop:** after a stop or seek, the stand-in primes on `D` frames of silence. Lining that up is this task's job.
- **Master bus at a wrap:** a wrap does not reset the master bus (`mix.master.reset()`, around `renderer.rs:1455`), so master state stays continuous across a wrap. Only a user seek or stop, a fault restore, or an install without preserve resets it. Test this.
- **Seek to the end:** flushing at a device seek to the end is lossy (Spike 3, P2). Fix it here.
- **Wrap test cases:** use Spike 3's results (`D_max` of 0, 64, 1024, 4800 and mixed; count-in off and on) as test cases.
- **Delay compensation check:** if an installed amp plug-in such as Gojira X is available, time a click through it before trusting delay compensation. Earlier runs measured 57 vs 36 frames. If none is installed, list it under Limits.

### Task 13
- **Helper errors:** `HelperError::status()` returns `Option<PluginStatus>`. `None` means leave the slot's status as it is.
- **Helper lifetime:** keep a `HelperProcess` alive until `exited()` after `shutdown()`. `MAX_IN_FLIGHT` is 4.
- **Faults:** restart the helper on any fault code. A fault carries over when the same link is prepared again (Task 11 ruling I3).
- **Latency announcements:** a plug-in that keeps announcing an unchanged latency causes a dip about once a second. Add a back-off in the helper's reconfigure rate limit (`src-tauri/plugin-host/src/vst3_core.rs`), with a test. Never rebuild the mix with a different `P` on an unchanged latency announcement, because that flushes and re-primes the plug-in.
- **Library errors:** an `Err` from `PluginLibrary::open` is an error, never "every class is Missing".
- **Off the UI and audio threads:** call `resolve` and `reprobe(class_id, probe)` off both. `reprobe` is the step to run after consent; `resolve` never runs plug-in code (P13). The UI thread sends no helper requests.
- **Stuck main thread:** the helper's main thread can get stuck while audio keeps running (RR7). Decide a policy and record it.
- **Restored state:** apply it right after the plug-in is added, so a fresh plug-in and a reopened one sound the same.
- **Timeouts:** loading and opening the editor get 30 s, a probe 60 s, everything else 5 s (P16).
- **Track limits:**
  - Line-In accepts a plug-in slot today, and it must refuse it (P37).
  - Duplicating a track copies its slot, so count the cap of 8 active plug-ins over the replayed settings.
- **State checks:** state that fails `decode_state` must reach the user as a notice. Test that path.
- **Optional nits from Task 5:** the type-check ordering comment (`project.rs:642`), the TypeScript `mediaType` check (`engine.ts:81`), and the saved-only type check in `from_checkpoint` (`project.rs:511`). Fix them only if you touch those lines.

### Task 14
- **Offline faults:** offline mode plays from frame 0 with no priming crossfade (Task 11 ruling). A fault in offline export must fail the export with a clear message. It must never write silence or the built-in tone in its place.

### Task 15
- **Focus:** after attaching the editor, call `SetFocus` on the plug-in's child window, trying `IPlugView::onFocus(true)` too.
- **Size:** read `getSize` again after attaching, and resize to it.
- **Taskbar:** don't use `WS_EX_TOOLWINDOW`. Keep the taskbar button, so an editor hidden behind other windows can still be found.
- **Foreground:** keep the `AllowSetForegroundWindow` return sequence.
- **Messages:** `EditorClosed` can arrive as a reply or unsolicited.
- **History:** map `HISTORY_FULL_MESSAGE` to the i18n key `plugin.history_full`.
- **Display scaling:** don't change system display settings. Test 150% scaling only if the display is already set to it. Otherwise list it under Limits.

### Task 16
- **Library errors:** the list and remove commands in `src/audio/plugin-host.ts` can reject when the library file is unreadable or comes from a newer TabPlayer. Show that message, not an empty list.
- **Moved plug-ins:** show a plug-in whose class moved to another file.
- **Error text:** map the helper's and the library's English error strings to i18n keys.
- **Sound editing:** `useSoundEditing` currently drops the plug-in, so fix it. `copySound` carries the plug-in across documents; decide whether it should, and record the decision.

### Task 17
- **CI:** the `--ignored` step must run the plugin-host unit tests too.
- **Build-id handshake:** add the P33 build-id handshake between the app and the helper.
- **Licences:** keep the licence notices for `vst3`, `pluginterfaces` and `com-scrape-types`. Cite the upstream tag or commit of the Steinberg text, and keep that text verbatim.

### Task 18
- **Limits to name in the docs:**
  - a real crash can show as Hung while Windows Error Reporting delays the exit under load;
  - the `kReloadComponent` limit;
  - the desktop hook can't simulate cancel or multiple picks;
  - plug-ins that announce latency without end;
  - probing offers only Fx sub-category classes;
  - DPI changes, monitor moves, mono plug-ins and offline export with a real plug-in are untested.
- **Spike doc:** correct the container overhead in the spike doc: it is 20 bytes, not 16.
- **Device fault:** a device fault stops playback without clearing `sounding` (`device.rs:1377-1384`), so adding a plug-in before pressing Play replays the opening. Call `renderer.pause()` from `fault()`, and add a test. It is minor; fix it here, or earlier if you touch that code.
- **Real-app proof:** use only installed plug-ins and the test plug-in, and record each plug-in's name and version.

## After the last task

Claude runs a whole-branch review of Tasks 1 to 18 on the most capable model. Merging into develop is the user's decision, not part of this handoff.

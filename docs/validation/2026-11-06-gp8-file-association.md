# GP8 parity: file association and open at launch (W13)

**Date:** 2026-11-06.
**Branch:** `feature/w13-file-association`, from `develop` at `04a681f`.

> **Superseded for Windows packaging on 2026-11-08.** Windows now ships as an MSI only (see `2026-11-07-ci-failures.md`). Everything below about the installer describes the NSIS installer. Reading Tauri's WiX template (not tested by installing), the MSI differs:
> - It registers one ProgID per extension: `TabPlayer.tabplayer`, `TabPlayer.gp` and so on. The `name`, `mimeType` and `role` values are ignored.
> - It installs for all users, so it needs administrator rights.
> - It neither backs up nor restores a previous `.gp*` default.
>
> The app-side opening of files is unchanged.

## What changed

### Installer associations

The Windows installer associates TabPlayer with these file types (`bundle.fileAssociations` in `src-tauri/tauri.conf.json`):

| Extensions | ProgID |
|---|---|
| `.tabplayer` | `TabPlayer.Project` |
| `.gp`, `.gpx`, `.gp5`, `.gp4`, `.gp3` | `TabPlayer.GuitarProScore` |

Each one opens `"tabplayer.exe" "%1"`.

### Ways a file reaches the app

All of these go into one native queue (`src-tauri/src/launch.rs`, at most 128 files):

- **Launch arguments.** Paths on the command line are queued. Options are skipped, relative paths are taken from the launch folder, and `file://` URIs become paths.
- **A second launch.** It hands its files to the running app through `tauri-plugin-single-instance` 2.4.5, focuses the window and exits. The plugin is registered first, so the second process exits before it creates any window, session or Library store.
- **macOS.** `RunEvent::Opened` file URLs are queued.

### How queued files are opened

- **Taking files.** Native code emits `launch-files`, and the frontend takes the next file with `launch_files_take`. Each file is its own drop batch, so a slow open (a password prompt) never lets the next file's 30-second drop token run out. The file goes back and waits:
  - while an export runs;
  - while the Library cannot admit work (for example, the window is closing);
  - while a drag-and-drop batch is still being opened, so it is not replaced.

  These checks run under the same lock as the capture.
- **The same checks as drag-and-drop.** Taken files go through the existing dropped-file intake: the extension allowlist, the 32-file cap, and canonical, size-limited and re-checked reads.
- **Opening loop.** `src/main.tsx` opens launch files in one serialized loop, one batch at a time.
- **Waiting.** The loop retries every 500 ms while any of these is true:
  - the workspace is starting, pending, closing or resuming;
  - another editor operation or document action is running, such as Save As or the export dialogs;
  - the Library dialog is busy.

  A file opened at those times opens when they end.
- **Settling.** The queue lends each file until it is settled. Staging a file marks its loan, even when the intake refuses it (an unsupported file), so it is never offered twice. After every open the frontend calls `launch_files_settle`. A file the intake never received goes back to the front and is tried again. That covers an open refused as something started, a drag-and-drop that replaced its batch, and a closing tab that ended it. If the settle itself fails, or the page reloads, the next take puts the file back first.
- **Too many files.** The queue keeps 128 files. It counts any beyond that and reports them with `launch.too_many`.
- **The Library dialog.** An idle one, such as the first-run welcome, closes for the opened file (`WorkspaceLibrary.openLaunched`). One that is opening a score, scanning, saving a template, changing its catalog or picking a folder makes the file wait.
- **Messages.** Failures are shown with the new `launch.failed` and `launch.no_library` messages in en, et and de.

### Desktop test build

The desktop test build now uses its own identifier, `dev.tabplayer.desktop-test`. With the shared one, a test launch would have handed its files to an installed or `tauri dev` TabPlayer as a second instance. Test app data now lives under that identifier.

## Evidence

- **Native tests** (`launch::`, 2 tests):
  - options and empty arguments are skipped;
  - relative paths are resolved from the launch folder;
  - a `file://` URI becomes its path;
  - files go out one at a time, the queue keeps 128 files and counts and reports the rest once;
  - taking empties the queue, and a file put back goes ahead of later files;
  - an unstaged loan comes back for its own token only, once; a staged one does not; a loan never settled comes back on the next take.
- **Drop intake tests:**
  - ending a drop batch leaves another batch alone;
  - a live batch with items left is busy, and an expired or emptied one is not;
  - a launch capture waits, unconsumed, while the Library is retired or a drag-and-drop is live;
  - staging counts an item as handed out even when it is refused, such as an unsupported file.
- **Frontend tests:**
  - **`main.tsx` startup test** (`src/workspace/WorkspaceApp.test.tsx`):
    - nothing is taken before the session is resolved;
    - the queue is taken once the workspace and Library exist;
    - a `launch-files` event while the Library is blocked takes nothing, and the files are taken on the retry and opened;
    - every opened file is settled, and the next take waits until the settle has finished;
    - after an opened file the loop takes the next one;
    - a failed settle is reported and retried, and refused overflow is reported.
  - **Library gate:** over an open Library, a pending document action makes the files wait.
  - **`openLaunched` test:**
    - it closes the first-run welcome and opens the drop;
    - during another editor operation it returns false without consuming the drop, and is free again once that ends;
    - a plain drop still refuses while the Library is open.
- **Desktop** (`tests/desktop/parity-file-association.mjs`, Windows desktop-test build):
  - **Starting with a file:** the app was started with `launch first.gp` on its command line. The space in the name checks quoting. The score opened next to the startup blank, with no alert or page error.
  - **A second launch:** `tabplayer.exe launch-second.gp`, started while the app ran, exited with code 0 and the file opened in the running app. The first file stayed open once.
  - Result: `{"openedAtLaunch":["blank","launch first.gp"],"afterSecondLaunch":["blank","launch first.gp","launch-second.gp"],"secondLaunchExit":0}`.
  - Before the welcome fix, this driver showed the file refused behind the first-run Library welcome.
- **Installer:** `tauri build --bundles nsis` produced `TabPlayer_0.2.0_x64-setup.exe`. Its `installer.nsi` holds one `APP_ASSOCIATE` per extension with the ProgIDs above and the `"%1"` command line.
- **Full suites:**
  - `cargo test --locked`: 1 120 passed, 0 failed, 13 ignored, before the round-5 changes.
  - After the final changes, `cargo test --lib`: 455 passed, 0 failed, 4 ignored.
  - `cargo fmt --check` is clean.
  - The ignored resource budget test passes.
  - `npm run typecheck` passes.
  - `npm test`: 5 306 passed, 20 failed. All 20 failures are in the 5 files that time out on `develop` on this machine (THE-173), and 14 of them report a timeout.
  - Run alone, 4 of those 5 files pass, along with the new launch tests.
  - `App.test.tsx` contains no launch code. Alone it still timed out in 2 different tests on each run, while another process held the machine busy.

## Review

The review covered the dependency, the untrusted paths and the timing paths. It was fresh, read-only and adversarial (Opus, extra-high effort), and ran eight rounds.

**Round 1 found:**
- the first double-click refused behind the welcome Library, and lost;
- several files launched at once losing all but the first;
- files stranded with no message when the workspace was busy;
- files consumed and refused during an export;
- the test build sharing the installed app's identifier.

All five are fixed as described above. It also led to the `file://` handling, the ProgIDs without spaces and the i18n messages.

**Round 2 found:** document actions such as Save As and export were not counted as busy, and a file taken just as an operation started was lost. Both are fixed: the loop now uses the controller's own conflict check, and a batch taken in that moment is held. Round 2 also led to:
- the Library's own pending work (template save, catalog change, folder picker) now making files wait;
- the Library-failure message appearing only when files waited;
- the native admission check;
- a retry after a failed take.

**Round 3 found:** a file that arrived while a held batch reopened was left queued, because the waiting flag was cleared too early. Fixed: the flag is cleared only when taking, and a test covers a held batch plus a new arrival. The Library-failure branch now retries while a session operation is pending.

**Round 4 found** the hold design fragile. It was replaced by giving the batch back to the native queue.

**Round 5 found** that the give-back read the batch from the drop slot, so a drag-and-drop or a tab close in between lost it. Fixed: the queue keeps its own copy of what it lent. Round 5 also led to:
- the readiness check moving under the capture's lock;
- a retry after a failed give-back;
- answering `waiting` only when files are queued;
- batches of at most 32.

**Round 6 found** that files could still be lost after the open had started: a 30-second expiry during a slow open, a refusal after the check, and a failed give-back. Fixed by lending one file at a time until it is staged and settled, as described above. Round 6 also led to:
- launch captures waiting for a live drag-and-drop;
- counting and reporting overflow;
- the pending-action check over an open Library;
- tests for the native capture.

**Round 7 found** that an unsupported launched file was never counted as staged, so it would have been retried forever and blocked the files behind it. Fixed, with a test. Round 7 also led to:
- the Library-unavailable path ending its drop batch;
- the argument list no longer being cut before the queue counts it.

**Round 8 approved** the final design. It confirmed:
- a refused item counts as handed out;
- ordinary drag-and-drop behaves as before;
- the lock order has no cycle, so it cannot deadlock.

**Found sound:**
- nothing is opened twice;
- the queue is taken atomically, and the extension and size checks still apply;
- the second instance exits before touching session files and never claims the CDP port;
- all added crates are MIT or Apache-2.0, need Rust 1.87 at most, and only add to the lockfile.

## Limits

- **Installer not installed here.** Installing changes the registry, so I have not run a real double-click through Explorer. The command line Explorer uses is the one the driver exercised.
- **Guitar Pro defaults.** The installer takes over `.gp*` defaults where the user has made no Explorer choice. The Tauri NSIS template backs up the previous default and restores it when TabPlayer is uninstalled.
- **macOS and Linux are unchecked** (THE-73).
  - Neither the macOS open event nor the Linux associations have been tested.
  - The Linux Guitar Pro entry has no MIME type, so it is likely not registered there.
- **Inherited from the single-instance plugin:**
  - A second launch's non-Unicode argument makes that process panic, so its file is dropped.
  - Another local user can occupy the plugin's fixed macOS socket.
  - A second launch waits forever if the running app hangs.
  - Linux startup panics on a malformed `DBUS_SESSION_BUS_ADDRESS`.
- **Startup blank tab.** A file opened at launch opens next to the startup blank rather than replacing it.
- **Several double-clicked files.** They may open as several batches.
- **Very large requests.** Files past the 128th waiting are not opened. They are counted and reported.
- **Reload during an open.** A file whose staging has started when the page reloads is treated as opened. If the reload lands before it opens, it is not opened.
- **A refused drag-and-drop.** One the Library refused stays live for up to 30 seconds, and launched files wait for it.
- **Library dialog text.** Closing an idle Library dialog for an opened file discards any template name or folder rename typed but not submitted.

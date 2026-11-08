# THE-184 and THE-183: resumed-playback driver, and the missing Unsaved score dialog

Date: 2026-11-08. Branch `test/the-184-resume-driver`, from develop 27d9945. Windows 11, WebView2 157.0.4341.42, Rust 1.90.0, Tauri 2.12.5, tauri-plugin-dialog 2.8.4, rfd 0.17.2.

Summary: `tests/desktop/parity-resume-playback.mjs` is repaired and passed 5 of 5 runs. THE-183 is a test artefact, not a product bug: the dialog appears for every kind of close that was tried. The symptom is reproduced exactly, and only, when the dialog's own IPC request is held.

## THE-184: what the driver proves

Read from the driver and its history (`cb6081b` added it, `e415733` bound it to the build packet). With a nondefault editor state (two edits, one undone, zoom 115, a typed but unapplied fret draft) it:

1. Closes the window with unsaved changes and answers the real Unsaved score dialog with Discard.
2. Lets the real `session_shutdown` run, then makes the one remaining step, `window.destroy()`, fail.
3. Proves the app resumes: the same React shell is retained, the real `session_resume` is acknowledged, the workspace snapshot equals the one before the close, the fret draft and zoom survive, a fresh stopped audio generation is prepared (`audio_prepare` for the owner, one note, tick 0 to 960, no range or loop), a new recovery epoch holds the same project and view, and nothing autoplays.
4. Plays and pauses through the UI without any edit and checks that nothing changed.

All assertions are kept. Only the fault seam and the close mechanism changed.

### Rework

- **Fault seam.** Tauri 2.12 made `window.__TAURI_INTERNALS__` immutable, so the in-page wrapper is gone. The driver opens a CDP session on the page and pauses only `http://ipc.localhost/plugin%3Awindow%7Cdestroy` (Fetch domain, request stage). The first such POST is fulfilled with `Tauri-Response: error`, a JSON body `"Injected window destruction failure"`, and the CORS headers Tauri itself sends. Every other request, including the CORS preflight of the destroy call, is continued untouched. The request never reaches native code, as before.
- **Observation.** Every `ipc.localhost` POST is recorded from Network events (`requestWillBeSent`, `responseReceived`, `Tauri-Response: ok` means acknowledged), with the payload kept for `session_shutdown`, `session_resume`, `audio_prepare` and `audio_command`. This replaces the `calls` array the in-page wrapper kept, and feeds the same assertions (one destroy call, one injected, none acknowledged; one acknowledged shutdown and resume; no `play`, `playRange` or `pause` before the UI Play; the last acknowledged `audio_prepare` payload). The shell identity is kept with a page-side reference. The old "restore the internals" step becomes "Fetch interception disabled".
- **Close.** `tests/desktop/post-window-close.ps1` (new, byte-pinned like the dialog helper, with a `-text` entry in `.gitattributes`) re-checks the captured process identity (path and start ticks), lists the process's top-level windows, requires exactly one unowned window titled `TabPlayer Test`, and posts `WM_CLOSE` to it. `Process.CloseMainWindow()` is gone. Its `-Mode List` prints every window of the process.
- **Dialog answer.** `answer-unsaved-dialog.ps1` is unchanged, but is now started asynchronously, so Node keeps serving CDP while it waits.

### A design pitfall found on the way

The first rewrite paused every IPC request (both stages) to observe them, and ran the dialog helper with `execFileSync`. It failed with "No owned Unsaved score dialog appeared within 10 seconds". The Unsaved score dialog is itself an IPC request (`plugin:dialog|message`, see THE-183 below). Pausing it while the blocked Node event loop could not continue it meant the dialog never opened. The final design avoids both: only the destroy request is ever held, and observation uses Network events.

### Run results

Built from this worktree with `scripts/build-desktop-test.ps1` (default `src-tauri/target`), then the build packet from `tests/desktop/string-count-build.mjs` at source revision 01e1ea7 (the driver commit), executable sha256 `03188befa964...` copied to `.analysis/desktop-smoke/tabplayer.exe`. Port 9223 was free before each run. Command: `node tests/desktop/parity-resume-playback.mjs --run --build=<packet>`.

| Run | Exit | History steps | Page errors | Destroy requests (injected) | Shutdown / resume acknowledged | Shell retained | Recovery epoch | Close to resume check |
|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 8 | 0 | 1 (1) | 1 / 1 | yes | 1 to 3 | 1.4 s |
| 2 | 0 | 8 | 0 | 1 (1) | 1 / 1 | yes | 1 to 3 | 1.4 s |
| 3 | 0 | 8 | 0 | 1 (1) | 1 / 1 | yes | 1 to 3 | 1.4 s |
| 4 | 0 | 8 | 0 | 1 (1) | 1 / 1 | yes | 1 to 3 | 1.4 s |
| 5 | 0 | 8 | 0 | 1 (1) | 1 / 1 | yes | 1 to 3 | 1.4 s |

5 of 5 passed (every assert in the driver). The resumed native generation was 11 in every run, and no tabplayer process or 9223 listener remained afterwards.

Limits: Windows only; one build; the destruction failure is a fabricated IPC answer, not an OS failure; no audio is heard. A copy of the driver with the packet check removed was used for iteration before the packet existed (it passed once); the five runs above are the real driver.

## THE-183: is the Unsaved score dialog missing?

**Verdict: test artefact. The dialog appears for a real user close.**

### The close path

1. `src/main.tsx` registers `window.onCloseRequested`. It calls `preventDefault()`, then `workspace.requestWindowClose()`, and only on `true` calls `window.destroy()`. On an error it calls `resumeAfterWindowCloseFailure`.
2. `WorkspaceController.requestWindowClose()` runs a transition (sets `busy: true`), flushes views, and for each document calls `controller.requestClose()`, which asks `bridge.askUnsaved(title, path)` when the document is dirty.
3. `askUnsaved` (`src/bridge.ts`) is `message(...)` from `@tauri-apps/plugin-dialog` with the title "Unsaved score" and Save, Discard and Cancel buttons. That is not an in-page dialog. It is an IPC request to the async Rust command `plugin:dialog|message`, which shows a native rfd task dialog (`blocking_show_with_result`, parented to the window) and answers when a button is pressed.
4. So the app is `busy` from the moment the close is requested until the person answers. If the `plugin:dialog|message` request never completes, the app stays busy with no dialog anywhere. That is the reported symptom.

### Comparison against the desktop test build

The same build, always a dirty document (one note entered), process launched hidden with `Start-Process -WindowStyle Hidden` as the harness does (the Tauri window is nevertheless visible, `IsWindowVisible` true). The dialog was detected by enumerating every top-level window of the process, hidden ones included.

| Close method | Result |
|---|---|
| `WM_CLOSE` posted to the `Tauri Window` titled `TabPlayer Test` | Dialog `#32770` "Unsaved score", visible, owned by the main window, 1.1 s later; app busy until answered |
| Same, posted immediately after clicking Set note, without waiting for idle | Dialog appears |
| `Process.CloseMainWindow()` | Returned true, `MainWindowHandle` was the Tauri window here, dialog appears |
| Real mouse click on the title-bar Close button (`mouse_event`, window foreground, point hit-tested as `HTCLOSE`, `WindowFromPoint` is the app window) | Dialog appears at 1.2 s |
| `WM_SYSCOMMAND SC_CLOSE` | Dialog appears |
| Synthesized Alt+F4 | Dialog appears |
| `WM_CLOSE`, clean document | Window closes, process exits |
| UI Automation Invoke on the Close button | Not possible: the window's UIA tree holds only the `WRY_WEBVIEW` pane, with no title-bar or Close button. The hit-tested mouse click replaces it |
| `WM_CLOSE`, dirty, while a Fetch interceptor holds the dialog IPC request (the plugin:dialog message command) and never continues it | `aria-busy="true"`, no dialog, for as long as it is held. **This is the reported symptom.** |
| Same, but the interceptor continues every request (request stage only, or both stages, with or without `Network.enable`) | Dialog appears |

The first rewrite of the driver (above) produced the same symptom through the same mechanism: its pause-everything interceptor could not continue the dialog request while Node was blocked in `execFileSync`.

### Why the original probe saw nothing

Any CDP request interception that holds or delays IPC requests suppresses the dialog, because the dialog is an IPC request. The sweep note records that the driver's replacement seam used request interception when it saw the missing dialog. That is enough to explain that run. The same note's separate standalone probe is not described in enough detail to rule out the same thing (or a blocked event loop) there, and it could not be reproduced here by any close method without a held request. So the standalone probe's cause is inferred, not proven.

The sweep note's remark that `CloseMainWindow()` now reaches the single-instance helper is plausible but not reproduced: it takes the first visible unowned window in z-order, and the helper window (`dev.tabplayer.desktop-test-siw`) is also a visible top-level window of the process. In this session the Tauri window happened to be first. Posting `WM_CLOSE` to the title-matched window is deterministic, which is why the driver does that.

### What this does not cover

- No person clicked the button by hand. The click used `mouse_event` on the hit-tested caption button, which goes through the same non-client path, but it is synthesized input.
- Only the desktop test build on Windows 11 was tried. The release build uses the same `askUnsaved`, but was not run.
- No product code was changed, and none needs to be.

## Reproducing

```powershell
# worktree root; src-tauri/resources/audio is a junction to the main checkout, library is a real directory
$env:RUSTUP_TOOLCHAIN = "1.90.0"; $env:PATH = "$HOME\.cargo\bin;$env:PATH"
powershell -File scripts/build-desktop-test.ps1
$env:STRING_COUNT_TARGET = "<abs path>/src-tauri/target"; node tests/desktop/string-count-build.mjs   # prints the packet path
Copy-Item <packet dir>\runtime\tabplayer.exe .analysis\desktop-smoke\tabplayer.exe -Force
node tests/desktop/parity-resume-playback.mjs --run --build=<packet path>
```

Rebuild the packet after any edit under `tests/desktop`, because the source manifest covers it.

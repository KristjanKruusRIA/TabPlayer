# Reload recovery: a reload keeps the live session (2026-10-30)

The L08 desktop run found that a webview reload left the app on "Recovery unavailable", and Start new session did not leave that screen. WebView2 leaves its reload keys enabled in release builds, so this slice fixes it. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build. This fix belongs to no parity row.

## Behavior
- **Reload:** the page attaches to the running session through `session_attach`, with the same open documents, the same active document, and unsaved edits and history intact.
- **Recovery prompts:** a genuine crash still prompts, and first startup never attaches.
- **Reload during a prompt:** the prompt stays.
- **Reload during a resolve:** if resolving fails, the page reads startup again and attaches when the session has resumed.
- **Save picker:** it now has the main window as parent, so the page cannot reload behind it.

## Evidence
- **Rust:** 848 tests passed on the merged branch, none failed.
- **Frontend:** `tsc` was clean, and `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout. `src/workspace/session-startup.test.tsx` covers a failed resolve that attaches once, and a genuine prompt that never attaches.
- **Desktop:** `tests/desktop/parity-reload-recovery.mjs` passed on a Windows desktop-test build of the merged source. Each reload is proved by `performance.timeOrigin` changing and a window marker disappearing. The run covered a reload with an unsaved edit, a crash that still prompts, and a reload during the prompt.

## Review
- **Code review:** an adversarial Opus review approved the code with three Mediums.
- **Findings and fixes:**
  - **Medium, fixed:** the driver could pass with no reload at all.
  - **Medium, fixed:** a reload during an in-flight resolve still dead-ended.
  - **Medium, fixed:** a reload behind the save picker left the app refusing edits and close.
- **Desktop run:** synthetic F5 and Ctrl+R never caused a reload, so the driver covers `page.reload()` only. A further check failed because it compared a record after an edit and an undo with the record before them; it now names the fields that legitimately change.

## Limits
- **Keys:** F5 and Ctrl+R themselves are not driven, because synthetic input does not reach WebView2's accelerators.
- **Save picker:** no automated test covers its new parent window.
- **Lost on reload:** recovery issues, practice settings and the clipboard.
- **Failed attach:** audio keeps playing with no interface, and close skips the unsaved-work prompts.
- **Clean phase:** attach cannot succeed in that phase, because `session_resume` is not called.

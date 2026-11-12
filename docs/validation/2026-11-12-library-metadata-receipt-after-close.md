# Library metadata alert after opening a score (2026-11-12)

## Symptom

On a desktop test build of `develop` (20a66f7), opening a file showed the alert
`Library: Metadata requires the exact successful file operation for this document revision.`
`tests/desktop/parity-stylesheet.mjs` stopped at its first `open()` and `tests/desktop/parity-notation.mjs` stopped when it reopened its saved `.tabplayer` file.

## Finding

This is a product bug, not a harness artefact. A user hits it on the first score opened after every start.

1. Since THE-198 (4c517fe, 2026-11-08), opening a score while an untouched Untitled tab exists adds the score and then closes that tab (`WorkspaceController.add`).
2. Adding the score records its receipt in the Library (`workspace_add` → `FileLibrary::record_success`).
3. Closing the blank tab runs `workspace_close`, which called `FileLibrary::retire`. `retire` cleared every receipt, including the one for the score just opened.
4. The frontend then sends the score's title, artist and track names (`WorkspaceLibrary.acknowledge` → `file_library_metadata_ack`). `metadata_ack` found no receipt and refused.

The effect for a user: the alert appears, and the score's Recent entry keeps no title, artist, album or track names. The score itself opens correctly, which is why the stylesheet driver passed once the alert was tolerated.

The drivers were last brought up to date on 2026-11-01 (e415733), a week before THE-198, so they were correct to fail.

## Fix

- `FileLibrary::retire` no longer clears receipts. It still pauses the Library, moves the epoch on, cancels scans and retires drop tokens and staged candidates.
- New `FileLibrary::forget_closed` drops the receipts of documents that are no longer open. `workspace_close` and `session_shutdown` call it after the close and before `resume`, while the Library is paused and no new receipt can arrive.
- New `DocumentWorkspace::is_open`.

The check against stale metadata is unchanged. `metadata_ack` still requires the workspace's current receipt for the document to match the callback's revision, and a recorded receipt with the same document revision, path and digest. A receipt of a closed document can match nothing, because the workspace no longer has that document.

No harness or driver file changed.

## Tests added

In `src-tauri/src/file_library/service_tests.rs`:

- `closing_another_document_keeps_the_receipt_of_a_score_that_stays_open`. Before the fix it failed with the exact alert text.
- `closing_a_score_forgets_its_receipt_and_the_others_still_refuse_stale_metadata`.
- `a_refused_close_keeps_every_receipt`.

These tests repeat the Library steps of `workspace_close` (`retire`, close, `forget_closed`, `resume`) on the workspace directly. They do not go through the Tauri command or `SessionRuntime::close`, so removing the `forget_closed` call from `lib.rs` or `session.rs` would not fail a unit test. Only the two desktop drivers cover the command itself.

No Vitest test was added: the frontend sequence is correct and did not change.

## What was run

All on Windows, in the worktree `.worktrees/library-metadata-receipt` (branch `fix/library-metadata-receipt`).

| Check | Result |
|---|---|
| `node tests/desktop/parity-stylesheet.mjs` on the existing `develop` build, before the fix | Failed at the first `open()` on the alert |
| New test `closing_another_document_…`, before the fix | Failed with the alert text |
| `cargo test --locked -p tabplayer --lib`, after the fix | 889 passed, 0 failed, 7 ignored |
| `cargo test --locked -p tabplayer --lib file_library::`, after adding the third test | 84 passed, 0 failed |
| `cargo test --locked -p tabplayer --test document_workspace`, after the fix | 5 passed, 0 failed |
| `cargo fmt --all -- --check` | Clean |
| `scripts/build-desktop-test.ps1` in the worktree, with the fix | Built |
| `node tests/desktop/parity-stylesheet.mjs`, as committed, on that build | Passed |
| `node tests/desktop/parity-notation.mjs`, as committed, on that build | Passed |
| `npm test` (run before the Rust fix; no TypeScript changed) | Node resource tests passed. Vitest: 6413 passed, 2 failed, 7 skipped |
| `npx vitest run src/interchange/midi-import.test.ts src/workstation/TrackSettingsPanel.test.tsx` | 87 passed |

The two Vitest failures were 5-second timeouts in `midi-import.test.ts` and `TrackSettingsPanel.test.tsx`, while a Cargo test build was compiling on the same machine. Both files pass when run alone. A full `npm test` was not repeated on an idle machine.

## Review

One independent read-only review of the diff approved it. It found no path that accepts metadata the old code refused, and no lock-order risk. Its findings:

- The test gap described under "Tests added"; the refused-close test was added in answer.
- `forget_closed` in `session_shutdown` removes nothing today, because shutdown does not take documents out of the workspace. It is kept so the rule holds if that changes.
- Two older behaviours outside this change, not addressed here: a second `workspace_close` that fails early can resume the Library while the first is still running; and reopening a file that is already open with unsaved edits sends the edited title to that file's Recent entry.

## Not run

- The full lib run (889 tests) and the two desktop drivers were not repeated after the third test was added. That change is test code only.

- The full Cargo workspace test run (`--workspace`), the other integration tests in `src-tauri/tests/`, and the other desktop drivers.
- macOS and Linux.
- No check by hand in a production build that a first open now stores the Recent entry's title. The Rust test asserts it on the service, and the drivers assert only that no alert appears.
- The stylesheet driver's own visual acceptance of its screenshots stays pending, as its output says.

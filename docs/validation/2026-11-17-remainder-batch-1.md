# Left-over items, batch 1 - validation, 2026-11-17

Branch `agy/remainder-batch-1`, cut from `develop` at `88f48e3`. Seven small items that needed no decision, listening or hardware. Each was
implemented by one engineer and reviewed by a second, read-only one; the fixes after review and the final checks were done by the orchestrator.
Nothing here was tried in the desktop app, and nobody listened to anything.

## What changed

| Item | Change | Files |
|---|---|---|
| A dropdown recorded one edit per typed letter | Type-ahead letters and digits on a closed dropdown are browsing, like the arrow keys: one edit when the dropdown is left or Enter is pressed, none when the value ends where it started. Space is not counted, because it opens the list. | `src/ui/CommitSelect.tsx` |
| Arrow keys on drum tab followed storage order | On a drum track shown as tab, Up and Down move to the hit drawn on the next line above or below in the same moment. Hits left off the tab are skipped. Guitar tracks and drum tracks without tab are unchanged. | `src/engraving/drum-tab-cursor.ts`, `src/App.tsx` |
| ASCII tab left drum tracks out (tracker row F14) | A drum track is written as a six-line drum tab (Cr, Rd, HH, Tm, Sn, Bd) with the same numbers and lines as on screen; surplus hits are counted in a note under the track. The export note and the help say so in en, et and de. | `src/export/ascii-tab.ts`, `src/i18n` |
| Export dialog and Page layout panel were English only | Their labels, options and messages are in the catalogue with en, et and de entries; the tablature refusal of the projection is translated too. | `src/export/ExportDialog.tsx`, `src/engraving/PageLayoutPanel.tsx`, `src/engraving/projection.ts`, `src/i18n` |
| `controller.faults.test.ts` failed under load | The two real-time waits use fake timers; real timers are restored after every test. | test only |
| `plugin_helper` timing test got `Timeout` under load | The test waits for the helper to have read the request instead of sleeping 300 ms. | `src-tauri/tests/plugin_helper.rs` |
| Tracker row L08 and the test build in worktrees | The stale "Plus/Minus Keys Behavior is not implemented" statement is removed. `prepare-library.mjs` verifies a library reached through a junction read-only instead of refusing it, and never writes through one. | `docs/validation/2026-10-15-gp8-parity-progress.*`, `scripts/prepare-library.mjs` |

## Checks (orchestrator's run, on the final tree)

- `npm run typecheck`: clean.
- `npm test -- --testTimeout=60000`: node tests 78 pass, 0 fail; `Test Files 456 passed | 4 skipped (460)`, `Tests 7685 passed | 5 skipped (7690)`.
  The first run failed two tests that asserted drums are left out of the ASCII tab; both were updated to the new behaviour.
- `node scripts/secret-scan.mjs`: 0 findings.
- `cargo fmt --all -- --check`: clean. `cargo test --test plugin_helper`: 26 passed; with `--ignored --test-threads=1`: 17 passed.
- `node --test scripts/prepare-library.test.mjs`: 11 pass.

## Review findings

- Fixed: Space set the browsing flag although it opens the list, so a following mouse pick could be recorded late or lost.
- Fixed: the drum tab projection tests depended on the system language; fake timers had no backstop.
- Left, low: AltGr characters are not treated as type-ahead; the ASCII drum tab groups hits by playback start while the screen groups by
  display start, so on-beat grace notes can land in another group; the cursor's grouping has no test for two voices or grace beats; the
  Up/Down handler in `App.tsx` has no component test; `prepare-library` reports a missing or stale library, not the link, when the
  junction target is unprepared.

## Limits

- Not run in the desktop app: the dropdown with a real keyboard, the arrow keys on a real drum tab, the translated dialogs, and
  `scripts/build-desktop-test.ps1` in a worktree (the audio folder junction is handled by other scripts and was not looked at).
- English remains in the page-layout validator messages (`src/engraving/page.ts`), the export selection errors (`src/export/types.ts`),
  the Guitar Pro 5 loss list and the other refusals of `projection.ts`.
- Ghost and dead drum notes are written as plain numbers in the ASCII tab. The note about surplus hits is English, like the rest of the
  exported text, and counts a simile bar's hits again.
- The loaded-machine run of `controller.faults.test.ts` still timed out in a CPU-heavy test without timers (the id-counter test) under
  56 busy loops; it passes unloaded.
- Estonian and German strings were written without a native review.

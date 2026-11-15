# THE-215: tuning as a row and a dialog, track actions as an icon row

Branch `agy/the-215-sidebar`, 2026-11-14 to 2026-11-15. Windows only.

## What changed

- **Track tab, tuning.** The preset select, notes field, headstock with pegs, per-string steppers, six note buttons, Saved tunings, Play tuning, Keep pitch and Apply tuning are gone from the sidebar. One row remains: the label, a button showing the saved notes (high to low, as everywhere in the app) and a play button that strums the saved tuning. The button opens the new **Tuning dialog** (`src/tuning/TuningDialog.tsx`, `tuning-dialog.css`).
- **Tuning dialog**, laid out like the Guitar Pro tuning dialog as far as our features go: a Library row (instrument, string count, preset, Saved tunings...), a Notes line (type the tuning, play it), one row per string (number, typed or stepped note, play button), and Cancel / Keep pitch / Keep fingering. It uses the app's `Dialog` (focus trap, Escape, backdrop, focus return, accessible name).
- **Nothing is recorded until an apply button.** Steps, typing and presets only change the draft. Cancel and Escape discard it. Applying the current tuning, name and string count records nothing. The dialog stays open with its draft if the edit is refused and closes when it lands.
- **Which of ours is which.** Guitar Pro's "Keep the Fingering" is our `setTuning` without `keepPitch` (fret numbers stay, notes sound different): button **Keep fingering**, which is also the default and what Enter does. Guitar Pro's "Adjust the Fingering" is our `keepPitch: true` (notes move so they sound the same): button **Keep pitch**. The old Keep pitch checkbox is gone from this tab (it remains in the Selection tab's Staff panel). When the typed notes change the string count, the dialog shows the "strings kept" choice and one **Change string count** button (`setStringCount`, which already keeps pitch).
- **Track actions.** Move up, Move down, Duplicate and Remove are one row of 28 px icon buttons with names and tooltips (same strings as before). Remove sits apart on the right in the error colour. They use `busyGuard`, so a focused one keeps focus when the app is busy.
- `src/ui/Dialog.tsx`: Escape and Tab are ignored by a dialog that has been made inert by one opened over it. Needed because Saved tunings opens over the Tuning dialog; before this, one Escape would have closed both.
- New glyphs in `src/shell/glyphs.tsx` (arrows, duplicate, bin, cog), drawn in the existing grammar.
- i18n: new `track_settings.*` and `tuning_dialog.*` keys in en, et, de; the help text for tuning in all three languages now describes the row and dialog.
- No edit type, schema or engine change. Old projects and edit logs replay as before.
- **Add instrument now uses the same row and dialog** (`src/tuning/TuningRow.tsx`, shared with the Track row; `TuningDialog` in `draft` mode). A new track has no notes to keep, so the dialog shows one **Use tuning** button, accepts any string count, and only fills the new-track draft. The row is named "Edit new track tuning (...)" so it cannot be confused with the track's row.
- **The Selection tab's Staff tuning was left on the old `TuningInput`, on purpose.** It is not the same control underneath: its tuning is one field of a larger form (capo, clef, partial capo, banjo drone, transposition, tab/notation toggles) that is applied together by "Apply staff settings", "Add staff" builds a new staff from the typed tuning, the engine refuses a string-count change there, and its pegs commit immediately. Moving it into the dialog means redesigning that form, which is the proposal's wider scope, not this ticket. The old component therefore still draws its headstock, steppers and six play buttons in that one place.
- The engine's refusal text in `structure.ts` ("... use Apply tuning to retune") now says "retune with Keep fingering or Keep pitch instead"; its unit test follows.
- README tuning paragraph updated for the row and dialog.

Deviation from the brief, on purpose: the first brief asked for a preset dropdown in the sidebar row that applies at once. The later message asked for the single Guitar Pro style row (button plus play). I followed the later one; presets are in the dialog's Library row and need an apply button. A one-click preset in the sidebar is easy to add if the owner wants it.

## Octave naming check (no change made)

- The app uses scientific pitch naming, MIDI 60 = C4. `formatPitch` is `floor(pitch / 12) - 1`, `parseTuning` is its inverse, the preset table is written through `parseTuning`, the placeholder and help text say E4 B3 G3 D3 A2 E2 for standard guitar and G2 D2 A1 E1 for bass, the tuner and the instrument view use the same formula, and MusicXML export uses `floor((value - alter) / 12) - 1`. GP5 export writes the raw MIDI numbers. I found no other convention in the code.
- That matches the Guitar Pro tuning dialog reference (standard guitar E2 A2 D3 G3 B3 E4, the same notes low to high).
- The owner confirmed the track in the screenshot really is drop D an octave lower (52 47 43 38 33 26). It is not a label bug: it shows as Custom because no preset has those pitches, and it plays an octave below standard because tunings are stored as MIDI numbers. New test: that tuning shows Custom in the dialog.
- Order: the app shows tunings high to low everywhere (notes field, saved tunings list, help, the sidebar row, the dialog's per-string rows with string 1 on top). Guitar Pro's short row reads low to high. I kept ours consistent; the proposal asks the owner whether to flip the sidebar row and the notes line.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | passes |
| `npx vitest run src/workstation/TrackSettingsPanel.test.tsx src/tuning-ui.test.tsx src/tuning-audition.test.tsx` | 19 + 5 + 6 tests pass |
| `npx vitest run src/help src/i18n src/ui` | pass (268 in help and i18n) |
| `npx vitest run src/App.test.tsx --testTimeout=60000` | the tests that touched the Track tuning field were updated; the file passes inside the full run |
| `npm test -- --testTimeout=60000` | 414 files passed, 4 skipped; 7265 tests passed, 8 skipped, none failed (including `plan.test.ts`; the run rewrote `plan.performance.test.ts.snap`, which I restored with `git checkout --`) |
| Desktop build, `scripts/build-desktop-test.ps1` | succeeded (exit 0) |
| `tests/desktop/parity-tuning-dialog.mjs` (new, real clicks and keys) | 10 checks pass: row shows the notes; four named action buttons; narrowest (240 px) and widest (560 px) sidebar with no covered control and no horizontal overflow; dialog (34 controls) with nothing covered; step records nothing; Cancel records nothing and focus returns to the button; Escape the same; a preset fills the draft only; Keep fingering records exactly one `setTuning` (`tuningName` Drop D) and focus returns; applying the same tuning again records nothing; Undo restores the tuning; Keep pitch sends `keepPitch: true`; Saved tunings opens over the dialog and Escape closes only it; the sidebar play button records nothing |
| `tests/desktop/inspector-inventory.mjs` (new, read only) | Song 1066 px, Track 2628 px, Selection 3338 px of content in a 510 px pane at 304 px wide |
| Existing drivers `parity-duplicate-track`, `parity-move-track`, `review-regressions` | pass, unchanged |
| Existing driver `parity-workstation` | passes after its hidden-pane draft check was moved from the tuning field to the track name field |

Second round (2026-11-15), after Add instrument moved to the same row and dialog, the engine message and README changed, and the desktop app and a string-count build packet were rebuilt:

| Check | Result |
|---|---|
| `npm run typecheck` | passes |
| `npm test -- --testTimeout=60000` | 414 files passed, 4 skipped; 7265 tests passed, 8 skipped, none failed (`plan.performance.test.ts.snap` rewritten by the run, restored with `git checkout --`) |
| `scripts/build-desktop-test.ps1` | exit 0 |
| `parity-tuning-dialog.mjs` (now 11 checks, adds Add instrument) | passes |
| `advanced-editor.mjs` (updated) | passes. It needs `TABPLAYER_TEST_GP`; I pointed it at the generated public score `.analysis/desktop-smoke/entry-mix-small.gp`, not the private score it was written for, so its tuning steps are checked against a standard-tuned guitar (applying standard tuning there records nothing, which the driver now allows) |
| `parity-string-count.mjs` (updated) | passes (`--run --build=` a packet built by `string-count-build.mjs` with `STRING_COUNT_TARGET` set to the worktree's default `src-tauri/target`) |
| `parity-saved-tunings.mjs` (updated) | passes, same packet |
| `parity-note-audition.mjs` (updated) | passes, same packet |
| `critique-fixes.mjs` (updated) | passes after `node tests/desktop/engraving-fixture.mjs` made its missing fixture (all under `.analysis/`) |
| `parity-workstation.mjs`, `parity-duplicate-track.mjs`, `parity-move-track.mjs`, `review-regressions.mjs` | pass |

How the three drivers that clicked the removed controls were changed: each opens the Track tab's `Edit tuning (...)` button and works inside the Tuning dialog. Saved tunings is reached through the dialog's "Saved tunings..." button, and its Cancel or Use leaves the Tuning dialog open, so the driver cancels that too. A refused string-count change now leaves the dialog open (it keeps the draft); `parity-string-count` cancels it and reads the app's alert. The "Strings kept in place" select is found by role with a name prefix, because Playwright's exact label match includes the option text.

Grep for leftovers (item 2): across `src/` and `tests/desktop/`, the removed labels "Apply tuning", "Tuning preset", "Tuning (notes, high to low)", "New track tuning", "Saved tunings for ...", the six `Play string` buttons and the four full-width action buttons are gone from every test and driver, except where the old `TuningInput` is still used on purpose (the Selection tab's Staff tuning and its tests in `panels.test.tsx` and `TuningInput.test.tsx`, plus `tuning-audition.test.tsx`'s staff-panel case). `Remove track`, `Move track up/down` and `Duplicate track` keep their names on the new icon buttons, so `native-audio.mjs`, `parity-staff-groups.mjs`, `parity-duplicate-track.mjs`, `parity-move-track.mjs` and `review-regressions.mjs` find them unchanged (the first two were not run). Fixed: the engine's "use Apply tuning" message, the README paragraph, `workstation-commands.mjs`'s list of Track-tab actions, and the help text. The catalog keys `track_settings.apply_tuning`, `tuning_label`, `tuning_preset_label`, `new_track_tuning` and `new_track_tuning_preset` are now unused and were left in place in all three languages.

Not run: `native-audio.mjs` and `parity-staff-groups.mjs` (they only use the unchanged action button names, but I did not run them); a keyboard-only and screen-reader pass; macOS and Linux.

CDP port 9223 was shared with the edit-speed and entry-mix agents. Runs that failed to start while their app held the port were repeated once it exited; one of my own apps was orphaned by a timeout and stopped by hand.

Third round (review fixes, 2026-11-15):

- **A refused edit says why inside the dialog.** The app's message for the last refused edit (`state.error`, passed to the panel as `refusal`) is shown in the dialog's own `role="alert"`, linked to the notes field, after an apply comes back refused. It goes as soon as the draft changes. If the app gave no message the dialog says "The tuning was not applied." Test with the engine's real "no playable string" refusal.
- **A note typed wrongly into a string row** is no longer dropped: it keeps its text, shows an error naming the string, and blocks both apply buttons until it is corrected or stepped.
- **A step that changes nothing is not a change.** Arrow up at the top limit, or up then down, leaves the draft and its name alone. The draft keeps the document's tuning name while its pitches still equal the document's, so applying an equal draft records nothing (a preset the player chose still sets its own name).
- **Step buttons** are 28 px high and wide (they were about 13 px high). Page Up and Page Down step an octave, Shift with an arrow steps an octave, and the wheel over the focused field steps a semitone, as the old control did.
- **The dialog belongs to a track by identity.** It follows the track if tracks are moved while it is open, applies to that track's new index, and closes without an edit if the track is removed.
- The tuning buttons carry `aria-haspopup="dialog"`.
- **Layout.** Saved tunings moved from the Library row to the foot of the dialog (left side) so a long label no longer squeezes the preset select; the foot wraps and the dialog is 600 px wide. The driver measures en, et and de at the narrowest and widest sidebar: with the dialog 600 px wide, the instrument, string-count and preset selects are 178/82/231 px (de), 194/73/252 px (et) and 184/85/240 px (en); step buttons 28 px; nothing outside the dialog, covered, clipped or overflowing. The sidebar row is 104-124 px wide at the narrowest sidebar and truncates the notes with an ellipsis (the tooltip and the dialog show them all), and about 425-445 px at the widest.
- Five unused catalog keys removed in en, et and de (`track_settings.apply_tuning`, `tuning_label`, `tuning_preset_label`, `new_track_tuning`, `new_track_tuning_preset`); nothing referenced them.
- Help text now takes the words for the buttons and the tab from the catalog (`{@dialog.cancel}`, `{@inspector.track}` and the dialog's own keys), so Estonian says "Loobu" like the button; the awkward Estonian opening sentence was rewritten.
- Drivers: `advanced-editor.mjs` asserts exactly one `setTuning` of the right pitches (it now applies a tuning that really differs); `parity-string-count.mjs` waits for the dialog to close or for the reason to appear inside the dialog, asserts which one it expected, and checks the reason text and the kept draft; `parity-tuning-dialog.mjs` adds the language and width matrix and the 24 px step check.

## Screenshots

Screenshots are not kept in `docs/validation/`. `tests/desktop/parity-tuning-dialog.mjs` writes them to a directory given on its command line (the Track tab at the default, narrowest and widest sidebar, the Tuning dialog, Add instrument, and the dialog in each language at both widths), and `tests/desktop/inspector-inventory.mjs` writes one per inspector tab. There is no "before" screenshot from this build; the old layout is the owner's screenshot and the measured heights in the proposal.

## Layout numbers

Track tab content at 304 px wide: 2628 px now, about 3170 px before (estimated from the old stack's measured parts), a saving of about 540 px. At 240 px the tab is 2766 px and at 560 px it is 2543 px. At 240 px the tuning button truncates the notes with an ellipsis; the full text is in its tooltip and in the dialog.

## Open points

- The Tuning dialog does not hold capo, partial capo or the banjo drone; those stay in the Selection tab's Staff panel (see the proposal).
- Not added from the Guitar Pro dialog: shift all strings, flat/sharp display, display label.
- The Selection tab's Staff tuning still uses the old component (reason above).

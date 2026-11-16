# Stale desktop drivers (2026-11-16)

Branch `agy/followups-drivers`, cut from `develop` 51925b7. Five real-app drivers in `tests/desktop/` failed on develop although the app
does what was intended: the UI had moved on under them. Only driver files changed; nothing under `src/` or `src-tauri/src/` did. No real
product defect was found in any of the five.

All runs were on one Windows machine, in the worktree's own default `src-tauri/target`, from a desktop test build made with
`scripts/build-desktop-test.ps1` (a first attempt was interrupted and left corrupt build files, so the worktree's target folder was cleaned
and rebuilt). The worktree has no `.analysis/compatibility` fixtures; none of these drivers needed them. A passing run counts only when it
follows the last edit; "3 in a row" below is three consecutive complete runs of the final driver.

## display-modes.mjs

Before: 679 checks, 19 failed.

- 18 failures, `tab digits stay at least 6px tall` in the resize section, at Fit page for the three page layouts, two scores, three window sizes
  (digits 3.7 to 5.1 px at 30 to 43%). Cause: Fit page shows a whole sheet in the area, so its digits are small by design. The 2026-11-08 display-modes note
  (THE-56) already records 6.6 (5.2) px at 1440x900 and 3.8 (3) px at 960x600 for it and flagged the same cells; the 6 px figure is the note's own "working
  heuristic". Not a change in the app.
- 1 failure, `native window size never changed`: 1441x900 against 1441x901. The comparison was between the window of the first app launch and the window
  of the app started again for the crash-recovery step; the two launches differ by one pixel in outer height, and nothing resized either window.

Change: for Fit page the check is now that the whole sheet fits in the area (`sheetHeight <= client height`) and that no digit is below 3 px (the height
at the 25% zoom floor); every other policy keeps the 6 px check. The window size is read again at the start of the resize section and compared with the same
app's size at the end.

Limits: for Fit page this replaces the 6 px legibility heuristic with a smaller floor. It no longer reports that Fit page digits are small; the note still does.

Runs after the change: pass (679 checks); one run ended with 4 errors after 263 checks (0 failed) because the app process was gone mid-run
(`Unable to capture screenshot`, then `Cannot find a process`); the cause was not found and it did not repeat; then pass, pass, pass (679 checks, 0 failed, 0 errors each).
The three consecutive passes are the last three runs.

## parity-staff-groups.mjs

Before: 17 passed, 1 failed (`driver`): `A notation system does not fit this page`.

- Cause: the step that sets the staff gap below Guitar6 to 300% exports to A4. The first system is then 966 px tall, the usable height of the page is 945 px,
  and `src/export/pdf.ts` (unchanged for a long time) refuses it. At 200% it is 927 px. The 2026-11-07 note recorded 78 = 2 x 39 at 300%, so the first system
  has grown since then (THE-199 added 3 px to it; the rest was not traced).
- With that step changed, two more stale steps showed up that had been hidden behind the first: (1) the click on a piano notehead selected nothing because the Score
  style dialog, left open by the settings steps, covered the score (the click landed on the dialog; confirmed by closing it and reading the status bar); (2) the parchment
  overlay check read staff lines from systems that a continuous layout had not painted yet (lazy painting of the systems in view; `system 2` or `system 4` had 0 lines).

Changes: the gap linearity check uses 225% (expects 1.25 times the space of 200%, within the same 0.2 px) instead of 300% (2 times); the dialog is closed before the click step;
the parchment step uses a 4000 px tall window so every system is in view, restores the size afterwards, and waits until each system has a brace and at least 10 staff lines
inside it before asserting (the assertions themselves are unchanged).

Limits: 300% itself is no longer exported by this driver, so the 300% setting is not exercised end to end. Nothing here shows that 300% on A4 is wrong: the guard fires with a clear message.
How the first system became 18 px taller was not traced.

Runs after the change: 47 passed, 0 failed, three times in a row.

## selection-playback-gestures.mjs and parity-selection-playback.mjs

Before: both stopped at `getByRole('button', {name: 'Loop selection'})` matching two elements. Cause: the transport has its own Loop selection toggle (THE-195,
`data-action="loop-selection"`) and the Selected playback panel still has a text button of the same name; both call `player.loopSelection` with the chosen occurrence.

`parity-selection-playback.mjs` then stopped at a second stale step: the `Editing location` card is gone; the cursor's track and place are read from the status bar.

Changes: both drivers click the transport toggle for `Loop selection`; the cursor check reads `.statusbar-track` and `.statusbar-position`.

Limits: the panel's own Loop selection button is no longer clicked by either driver. `parity-selection-playback.mjs` needs the debug `capture_loopback` example
(`cargo build --example capture_loopback`, default target) and records the shared audio output through the loopback device; it passed here with the machine otherwise quiet.

Runs after the change: `selection-playback-gestures.mjs` passed three times in a row; `parity-selection-playback.mjs` passed three times in a row (first run after the status-bar fix, then two more).

## parity-input-preferences.mjs

Before: could not run at all, then four stale steps in turn.

1. The build packet made by `string-count-build.mjs` had no identifier of its own, so with an installed TabPlayer running, the single-instance plugin handed the launch to it and the test
   process exited (`Owned process exited`). The packet's config now carries the test identifier already used by `build-desktop-test.ps1`.
2. A keypad digit with the keypad-durations preference off now writes the fret at once (a typed digit needs no Enter), so the check that it makes no edit was stale. It now asserts exactly one
   `setNote` edit with that fret on the cursor's beat and no duration change; the same at the end of the run, after the preference is turned off again.
3. The stored preferences object has a new key, `writeWhilePlaying` (default true, `src/editor/input-preferences.tsx`); the two expected objects include it.
4. The clipboard filter checks looked in an inspector section that no longer exists. The `Chord diagrams` filter is in the Properties dialog (Selection tab, Musical clipboard section); the check
   copies a bar, then reads the filter by opening and closing that dialog after each preference change.

Limits: the filter is read after each toggle by reopening the dialog, not watched live while the dialog is open. The driver needs a packet from `string-count-build.mjs`, which was built into
the worktree's default target; each edit to anything under `tests/desktop` needs a new packet.

Runs after the change: passed three times in a row.

## Summary

| Driver | Result | Real defect |
|---|---|---|
| display-modes.mjs | fixed (3 in a row; one earlier unexplained app exit mid-run) | none |
| parity-staff-groups.mjs | fixed (3 in a row), with 225% replacing 300% | none |
| selection-playback-gestures.mjs | fixed (3 in a row) | none |
| parity-selection-playback.mjs | fixed (3 in a row) | none |
| parity-input-preferences.mjs | fixed (3 in a row) | none |

One item for the owner: the display-modes Fit page digits at 960x600 (3.7 to 4.9 px) and the 300% staff gap on A4 are accepted by this note as intended, not verified as desirable.

# Inspector fixes (2026-11-17)

The owner tried the installed build with a six-track song and reported five problems; a sixth was found while investigating. Each is fixed on branch `agy/inspector-fixes`.

## 1. Selecting a track did not bring it into view

- Cause (confirmed): the score only revealed the one-beat edit-target box, nearest edge; and the playback scroll revealed the whole master bar, which for a system taller than the score area scrolls to the system top (the first track).
- Fix: when the edit target's track changes, the score centres that track's staves of the target's system in the score area (a staff taller than the area is aligned at its top); arrow keys inside a track keep the nearest-edge behaviour. In playback, a system taller than the score area is followed at the selected track's bars (the selected rendered track goes through the playback scroll context); a system that fits behaves as before, and so does a track that is not displayed.
- Tests: `ScoreView.test.tsx` (centring, tall staff, arrow keys), `screen-playback.test.ts` (tall system follows the track, no track or foreign track keeps the system top, fitting system unchanged).

## 2. The Track tab could not be scrolled with the wheel

- Cause (confirmed): `.track-settings` was a scroll container with `overscroll-behavior: contain` and auto height, so it never overflowed but swallowed the wheel before it reached `.workstation-inspector`.
- Fix: it is no longer a scroll container, has no padding of its own (the doubled 8 px gutters are gone), and the dead `.track-settings` selector in `gp-shell.css` was dropped. No other inspector panel has the pattern (checked every stylesheet).
- Test: `inspector-scroll.css.test.ts`.

## 3. Add instrument leaves the sidebar

- Now an "Add track" dialog (`AddTrackDialog.tsx`) opened from the dock's + and from Track > Add track…; it holds the name, MIDI instrument, tuning row (nested draft Tuning dialog) and the pitched and percussion notation tracks. The name field has focus, Enter adds, adding is one edit that closes the dialog and selects the new track, Escape and Cancel add nothing.
- No keyboard shortcut was added: the menus show none, and the free ones are not obvious.

## 4. The Information arrows

- They now select the previous and next track (the same step as Ctrl+Up and Ctrl+Down, now one function), stay focusable and inert with a tooltip at the ends (`aria-disabled`, not `disabled`), and record no edit. Reordering is Track > Move track up and Move track down (the same `moveTrack` edit, one undo step each, inert at the ends).
- The Overview track rows have no context menu or drag handle, so there is no other reorder control now.

## 5. Adding a VST plug-in

- The Sounds section has a Plug-in row (chosen plug-in with its status when not ready, or None) and a "Plug-in…" button; Sound > VST3 plug-in… does the same for the selected track. The dialog opens with the plug-in choice focused. In the dialog the plug-in slot, with the drum map directly after it, is now above the sound source and My sounds.

## 6. Test plug-in in the installer

- Confirmed: the MSI built from the main checkout on 2026-11-17 lists `tabplayer_test_plugin.dll` at the install root, and its `main.wxs` takes it from `src-tauri/target/release`. Neither `externalBin`, `resources` nor a build script names it. It is there because the desktop test build compiled the test plug-in into the same `target/release` folder, and Tauri's Windows bundler packed it. (The packing mechanism is inferred from the build files; it was not reproduced with a new installer build. CI is not affected: it builds the plug-in in the debug profile.)
- Fix: `scripts/build-desktop-test.ps1` builds the test plug-in into `src-tauri/target/test-plugin`; the shipping `build-plugin-host.mjs` removes a stale test plug-in from `target/release`; `verify-packaged-resources.mjs` fails if a `tabplayer_test_plugin` file is in a package. The debug-profile plug-in used by the real-helper Rust tests is untouched.

## Verification

Real app (desktop test build), generated score of five guitar tracks and drums over 52 bars, real mouse wheel, mouse and key input, with the window emulated at 1366x768 and 1920x1080 (`tests/desktop/inspector-fixes.mjs`): see the result lines in the final report. Screenshots (sidebar Track tab for a guitar and a drum track, the Add track dialog, the Sound dialog opened from the Plug-in row, in English, Estonian and German) are kept in `.analysis/desktop-smoke/inspector-fixes/` and not committed.

## Limits

- The viewport size was set with CDP device metrics, not by resizing the OS window.
- "Add plug-in…" was checked to be in view and enabled; its second click opens a native file picker and was not driven.
- Centring is checked from the position of the edit-target box against the middle of the score area (within one staff), not from the staff lines themselves.
- The Rust side was not changed; only the node tests of the changed scripts were run for build scripts.

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

## Follow-up: the Plug-in dialog is separate from Sound and pedalboard

Owner's report: "Also Sound and Pedalboard and Plugin open the exact same window. Plugin should only have the plugin and the sound and pedalboard everything else."

What changed:

- Two dialogs now. **Plug-in** (`PluginPanel`, class `plugin-dialog`) holds only the track's plug-in slot (choice with instrument and effect groups, Add plug-in…, Remove from library, Active, trims, Edit plug-in, status and notices, the library disclosure) and, for an instrument on a drum track, the drum map directly after it. **Sound and pedalboard** (`SoundPanel`) has no plug-in slot and no drum map: sound source, preset, drum kit and its mix, copy/paste, My sounds, the signal chain and the output device.
- One term, "Plug-in" (et and de "Plugin"), for the sidebar row, its button, the Sound menu item and the dialog title. The select inside keeps its descriptive label "VST3 plug-in".
- The sidebar's Plug-in… button and Sound > Plug-in… open the Plug-in dialog; Sound and pedalboard… opens the other. Only one is open at a time (one state in `SoundSummary`, distinct React keys); opening one from inside the other replaces it.
- Cross-links: in the sound dialog an effect plug-in keeps the per-pedal "Replaced" markers and a one-line note ("Drive, Amp and Cabinet are replaced by the plug-in.") with a small Plug-in… button; the drum kit note for an instrument has the same button. Both open the Plug-in dialog in its place, and focus goes back to the control that opened the first dialog.
- The "open scrolled to the plug-in section" mechanism (`openPlugin`, `reveal`, the details wrapper) is gone; the slot is a plain section, and its choice takes initial focus (`data-autofocus`). The Plug-in dialog is 480 px wide and sized to its content; its body scrolls inside the dialog when the drum map's Keys are open.
- Help text for the Sounds section was reworded for the two dialogs (en, et, de).

Verified: Vitest for each button and the menu item (right dialog, right content, the other's content absent), the drum map only for an instrument on a drum track, the cross-links, focus return, one `setTrackSound` for a plug-in choice and none for the current value, i18n completeness and source-literal tests. Desktop drivers `parity-vst-plugin`, `parity-vst-instrument`, `parity-drum-map` and `inspector-fixes` were changed to open the Plug-in dialog (new helpers `openPluginDialog` and `closePluginDialog` in `workstation-commands.mjs`).

Limits: `tests/desktop/acceptance-vst-real-plugin.mjs` still drives the old left-hand Sound task (`revealLeftTask`) and was already out of date; it was not changed.

### Plug-in dialog layout (owner feedback on the first version)

Before: an empty band and a stray divider under the header (the global `.sound-panel` top border and margin), the select squeezed into the right half of a two-column label grid and truncated, Add plug-in… and Remove from library touching, trims pushed right with no row gap, and library rows whose names wrapped onto three lines beside a long "Remove <name> from library" button.

After (`PluginSlotPanel`, `sound-panel.css`): one column on the Add track dialog's spacing (16 px body, 14 px between sections, 8 px between neighbours). The select has its label above it and the full width, with Add plug-in… beside it. Active comes first under the select with the status ("Ready") quietly at the right of the same row; notices and their Allow or Try again buttons follow. Input and Output trim are a two-column grid with labels above the fields and a "dB" unit (an instrument has Output trim only). Edit plug-in is a normal button with the focus note beneath it. "Plug-in library (N)" is collapsed by default and shows the count; each row is one line (name with ellipsis and full name in the tooltip, the quiet kind label, a bin icon button, 36 px high). The bin's accessible name and tooltip stay "Remove <name> from library". The separate "Remove from library" button was removed: it only removed the chosen class, which the bin in its row already does, so there is one way. The drum map follows with the same spacing. Texts: new `plugin.unit_db`, `plugin.dialog_title`; `plugin.manage_library` takes the count; `plugin.remove_plugin` is gone (en, et, de).

Desktop: `tests/desktop/parity-vst-instrument.mjs` with `PLUGIN_DIALOG_SHOTS_ONLY=1` takes the layout pictures (guitar with an effect, drum instrument with its map, library open, Keys open at 1366x768 asserting the dialog stays inside the window and its body scrolls) in en, et and de without starting playback. The owner heard the synthetic test drum instrument (a full-level square wave) during earlier driver runs and the test build has no silent or null output device, so after that report no step that plays a test plug-in was run; offline export is silent and was not repeated. Pictures were looked at and the spacing fixed (a global `summary{margin:12px 0}` had left a 24 px gap under the library line; a second `.sound-panel .drum-map` rule had kept its 12 px margin).

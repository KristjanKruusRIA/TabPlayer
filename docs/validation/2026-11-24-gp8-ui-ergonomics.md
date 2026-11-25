# GP8 UI ergonomics verification

The five slices in the [2026-11-24 plan](../superpowers/plans/2026-11-24-gp8-ui-ergonomics-parity.md) were implemented in the TabPlayer `develop` worktree.

## Reference

Guitar Pro 8.0.0 Build 18 was launched through its portable launcher. Windows UI Automation invoked New File and Create on a temporary score. The control tree and DPI-aware window captures covered the menu bar, Edition Palette, Inspector, Global View and Add Track dialog. The reference application closed through its window and the portable launcher exited. Captures remain under the ignored `.analysis/gp8-ui-oracle/` folder.

## TabPlayer desktop checks

The drivers run serially against the Windows desktop-test build with silent output. WebView2 captures use 1366×768 and 1920×1080 viewports.

| Slice | Driver | Runtime assertions |
|---|---|---|
| Score editing | `gp8-ui-slice1-editing.mjs` | TAB caret follows six strings and clicks on empty strings. Rhythm and technique keys work from the score. ArrowRight adds a beat or measure. Cursor copy and cut use a single beat. Pointer and keyboard toolbar activations preserve the intended focus. |
| Palette and Inspector | `gp8-ui-slice2-panels.mjs` | F2/F3/F6/F7/F8 toggle the panels. The two Inspector tabs fill the row. Lyrics has space for its label and the selected voice has a visible fill. |
| Toolbar, menus and tabs | `gp8-ui-slice3-toolbar-menus.mjs` | The toolbar fits on one row. Score display opens and closes from the toolbar. The stopped LCD displays BPM. The plus button creates a score tab and transfers focus to it. |
| Dock, Mixer and Sound | `gp8-ui-slice4-dock-mixer-rig.mjs` | Track names have a wider column. Master and track volume controls align. Mixer and Sound render within both widths and preserve focus on the view control. |
| Dialogs and Preferences | `gp8-ui-slice5-dialogs.mjs` | Ctrl+, and View open Preferences. Escape restores the invoker. Add Track, nested Tuning, Properties, Score Style and Export open and close with the expected focus. |

TabPlayer captures are under the ignored `.analysis/desktop-smoke/` folder. The dock driver also captures Mixer and Sound, and the dialog driver captures Preferences, Tuning and Export.

## Behavior at the edges

- ArrowRight retains the current rhythm when it fits. It uses a shorter rest if needed and lets later user navigation take precedence over the edit's cursor follow-up.
- Cursor-only copy and cut require an exact single-beat range. Multi-track cut still requires an explicit selection.
- At smaller widths the toolbar can use additional rows to keep translated controls reachable. The paused and playing LCD uses playback tempo, and the stopped LCD uses the written tempo at the displayed bar.

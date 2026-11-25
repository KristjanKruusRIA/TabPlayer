# Master Plan: Guitar Pro 8 Oracle UI & Ergonomics Parity (All 5 Slices)

- **Date:** 2026-11-24
- **Branch / Scope:** `develop` — TabPlayer React/Tauri workstation UI & keyboard/mouse editing ergonomics
- **Reference Oracle:** Portable Guitar Pro 8 (`Version 8.0.0 - Build 18`, `%USERPROFILE%\Downloads\Guitar Pro Portable\Guitar Pro 8\`) captured live via Windows UI Automation + DPI-aware (`SetProcessDpiAwarenessContext(-4)`) `PrintWindow` screenshots alongside TabPlayer Playwright WebView2 CDP captures at `1366×768` and `1920×1080`.

## Methodology & Ground Rules

1. **Two-stage GP8 Oracle -> TabPlayer Playwright loop:**
   - **Stage 1 (Oracle extraction):** Capture live portable GP8 screens, widget hierarchies, menus, shortcuts, click counts, and focus rules using Windows UI Automation and screenshots.
   - **Stage 2 (Playwright automation & UI fixes):** Encode each slice's behavioral, layout, focus, and workflow assertions in dedicated `tests/desktop/gp8-ui-sliceN-*.mjs` drivers (using `tests/desktop/harness.mjs` over WebView2 CDP), fix every mismatch or ergonomic friction in `src/`, visually verify screenshots at `1366×768` and `1920×1080`, and re-run regression suites until green.
2. **Product & legal constraints (`PRODUCT.md` & `CLAUDE.md`):**
   - Match GP8 behavior, shortcuts, layout comfort, and visual clarity using TabPlayer-owned UI and SVG assets — never copy or redistribute GP8 proprietary artwork, icons, or scores.
   - Keep all user-facing strings localized across `en`, `et`, and `de` (`src/i18n/`) with zero missing keys (`src/i18n/i18n.test.ts`).
   - Do not retune `src-tauri/src/audio/tone.rs`.
   - Run desktop Playwright drivers strictly one at a time (single WebView2 CDP port `9223`) with silent output (`TABPLAYER_TEST_SILENT_OUTPUT`).
3. **Portable GP8 inspection hygiene:**
   - Always launch portable GP8 via `GuitarProPortable.exe`, interact via UIA `InvokePattern` (not foreground cursor clicks), close cleanly via `WM_CLOSE` (dismissing any save prompt), and wait for `GuitarProPortable.exe` to exit so `Data\guitarpro8` and `PortableApps.comLauncherRuntimeData-GuitarProPortable.ini` are never left in a dirty state.

---

## 5-Slice Roadmap & Status

| Slice | Area | Key Parity & Ergonomics Targets | Desktop Playwright Driver | Status |
|---|---|---|---|---|
| **Slice 1** | Score Editing Ergonomics | GP8-style amber TAB string caret on the active TAB line (no obstructive `"String 6"` pill); click-on-empty-TAB-string hit testing (`tabStringAtPoint`); always-on GP8 rhythm/edit/technique keys (`+`/`-`/`=`/`_`, `.`/`Ctrl+.`, `/`, `R`, `L` tie, `O` ghost, `B` bend, plain `Delete`, plain `Insert`); `ArrowRight` continuous beat insertion & end-of-score measure append; single-beat `Ctrl+C`/`Ctrl+X`; pointer-click focus retention back to `.score-workspace` | `tests/desktop/gp8-ui-slice1-editing.mjs` | **Completed** |
| **Slice 2** | Left Edition Palette & Right Inspector | Fix `.inspector-tabs` 3-column grid hole for 2 tabs (`SONG`/`TRACK`); fix low-contrast active Voice `1` button; polish cramped `Lyrics`/`Chords` layout; replace OS color emojis in `palette-actions.ts` with crisp monochrome SVGs/glyphs; polish bottom `Tempo` button focus/highlight styling & shortcut tooltips; align GP8 panel toggle shortcuts (`F2` Palette, `F3` Dock/Global View, `F6` Inspector, `F7` Fretboard, `F8` Keyboard) with existing test contracts | `tests/desktop/gp8-ui-slice2-panels.mjs` | **Completed** |
| **Slice 3** | Top Toolbar, Transport/LCD, Menus & Document Tabs | Eliminate 2-row toolbar wrap at `1366×768` by compacting Score Display into GP8-style dropdowns; fix clipped `"Speed Tempo una..."` caption at `1366×768` & `1920×1080`; fix dim Metronome (`Click`) contrast; show actual stopped bar tempo in LCD (`♩ = BPM`); enrich sparse menus (`Bar`, `Note`, `Effects`, `Section`, `Tools`) with direct commands & right-aligned shortcut hints; add `+` new-tab button on Document Tabs strip | `tests/desktop/gp8-ui-slice3-toolbar-menus.mjs` | **Completed** |
| **Slice 4** | Bottom Global View / Track Strip, Mixer, Status Bar & Sound/FX Rig | Widen track name column to prevent truncation at `1366×768` & `1920×1080`; clarify Mute/Solo/Eye icons and align Master row controls under track columns; declutter bottom status bar; audit full-view Mixer & Sound/FX Rig layout, focus, and overflow | `tests/desktop/gp8-ui-slice4-dock-mixer-rig.mjs` | **Completed** |
| **Slice 5** | Dialogs & Preferences | Move bloated preference fieldsets (`InputPreferencesPanel`, `MidiCapturePanel`, `FretlightPanel`, `SoundbankSettingsPanel`, Language) out of the 248px `View` menu into a dedicated Preferences dialog (`Ctrl+,`), keeping `View` clean for view toggles; polish Properties, Add Track, Tuning (ordering & default CTA), Score Style, and Export dialogs for GP8 ergonomics, Escape/Enter handling, and focus restoration | `tests/desktop/gp8-ui-slice5-dialogs.mjs` | **Completed** |

---

## Slice 1 — Detailed Scope (Score Editing Ergonomics)

### 1. TAB Caret Placement & Click-on-String Hit-Testing (`ScoreView.tsx`, `tab-string-hit.ts`)
- Add `src/engraving/tab-string-hit.ts` (`tabLineGeometry`, `tabCaretBox`, `tabStringAtPoint`) reading alphaTab's `'tab'` renderer (`lineOffset`, `getLineY`) with safe runtime guards and graceful fallback when `layout` is unavailable (e.g., mocked jsdom tests).
- Position `.score-edit-target[data-tab="true"]` directly on the active TAB string line with a GP8-style amber highlight (`.score-edit-target[data-tab="true"]` in `ScoreView.css`), preferring TAB `noteHeadBounds` over treble-clef noteheads when TAB is shown, and hiding the obstructive `"String 6"` pill over bar numbers/tempo (keeping `.score-edit-entry` only for pending multi-digit fret hints or non-TAB fallback).
- Use `tabStringAtPoint` on beat clicks so clicking any of the 6 TAB lines selects both the beat and that exact string.

### 2. Always-On GP8 Shortcuts & Continuous Navigation (`score-entry.ts`, `gp8-keys.ts`, `App.tsx`)
- Extract `rhythmEntryKey` in `src/editor/score-entry.ts` so `+`/`-`/`=`/`_`, `.`/`Ctrl+.`, `/`, and `r`/`R` work directly on the score even when pitch "Note entry" mode (`N`) is off (`!noteEntryOn` keeps cursor on the beat after `R` rest toggles, while Note entry mode retains auto-advance).
- Extend `src/editor/gp8-keys.ts` with `o` (ghost), `b` (bend when not in Note entry), `l` without Shift (tie forward/backward/untie, keeping `Shift+L` as Loop), plain `Delete` (`deleteOrRemove`: erases multi-beat/multi-note selections or removes single cursor note), and plain `Insert` (in addition to `Ctrl+Insert`) to insert a beat.
- Continuous `ArrowRight`: auto-insert a beat when at the last beat of a non-empty bar with remaining capacity (`barHasRoomAfter`), and auto-append a new measure and move to its Beat 1 when at the last beat of the final measure (preserving empty-voice `ArrowRight` navigation into the next bar).
- Single-beat `Ctrl+C` / `Ctrl+X` fallback via `singleBeatSelection` when no multi-beat selection is active, plus enabling `Edit -> Cut`/`Copy` whenever a beat is under the cursor.

### 3. Pointer-Click Focus Retention (`EditingToolbar.tsx`, `EditorPanel.tsx`, `App.tsx`)
- Restore keyboard focus to `.score-workspace` after pointer clicks (`event.detail > 0`) on Edition Palette buttons, palette popover items, Text prompt submissions, top-toolbar buttons (`Note entry`, pane toggles, `Undo`/`Redo`), and `.paper-scroll` margins, while keeping keyboard activation (`event.detail === 0`) on toolbar controls.

---

## Slices 2–5 — Implementation & Polish Summary

- Slices 2–5 were implemented alongside [docs/validation/2026-11-24-gp8-ui-ergonomics.md](../../validation/2026-11-24-gp8-ui-ergonomics.md) (`gp8-ui-check.mjs` + `gp8-ui-slice2-panels.mjs` through `gp8-ui-slice5-dialogs.mjs`, plus compact-toolbar updates across desktop drivers).
- **Menu bar & commands (`src/App.tsx`, `src/workstation/gp-shell.css`):** Added right-aligned `<kbd>` shortcut hints with `width: max-content` / `min-width: 248px` menu width, removed the duplicate `<kbd>Ctrl+Shift+P</kbd>` on `Tools -> Command palette…`, added `Remove measure` (`Bar`), direct `Palm mute` / `Let ring` / `Bend` / `Vibrato` / `Dead note` commands (`Effects`), and `<kbd aria-hidden="true">F7</kbd>` on `Window -> Instrument`.
- **Track Inspector & Edition Palette (`src/workstation/inspector-compact.css`, `src/workstation/gp-shell.css`, `src/editor/EditingToolbar.tsx`):** Scoped compact `36px × 28px` `.track-settings .notation-toggle` rules without editing `src/workstation/track-panels.css`; gave pressed Voices `1`–`4` distinct contrast fills (`#E9B65C`, `#5CC27A`, `#6FA8FF`, `#B58CFF`), horizontal icon+label layout on `.tp-toolbar-panels .tp-glyph-btn`, muted highlights on active auto-defaults (`beam-auto`, `stem-auto`, `auto-spelling`), monochrome custom SVGs (`LyricsGlyph`, `ChordsGlyph`, `TimerGlyph`), and shortcut tooltips.
- **Dialogs & desktop helpers (`src/export/ExportDialog.tsx`, `src/export/ExportDialog.test.tsx`, `tests/desktop/workstation-commands.mjs`):** Ordered Export dialog footer actions as `[Cancel] [Export]` matching `TuningDialog` and `AddTrackDialog`; added `hideScoreDisplay(page)` and closed the compact Score display popover before tab activation or score clicks in `parity-document-tabs.mjs`, `parity-score-layouts.mjs`, and `parity-recovery.mjs`.

---

## Verification Log

- **Desktop test binary build:** `scripts/build-desktop-test.ps1` exited `0` (updating `.analysis/desktop-smoke/tabplayer.exe`).
- **GP8 UI Playwright slice drivers (sequential on WebView2 CDP `9223`):**
  - `node tests/desktop/gp8-ui-slice1-editing.mjs` — exited `0` (`gp8-ui-slice1-editing: all checks passed`)
  - `node tests/desktop/gp8-ui-slice2-panels.mjs` — exited `0`
  - `node tests/desktop/gp8-ui-slice3-toolbar-menus.mjs` — exited `0`
  - `node tests/desktop/gp8-ui-slice4-dock-mixer-rig.mjs` — exited `0`
  - `node tests/desktop/gp8-ui-slice5-dialogs.mjs` — exited `0`
- **Desktop parity & regression drivers (sequential on WebView2 CDP `9223`):**
  - `node tests/desktop/parity-edition-palette.mjs` — exited `0`
  - `node tests/desktop/critique-fixes.mjs` — exited `0` (16 captured states, `0` page errors)
  - `node tests/desktop/parity-workstation.mjs` — exited `0` (`"pageErrors": []`)
  - `node tests/desktop/parity-document-tabs.mjs` — exited `0` (physical loopback audio skipped as expected under `TABPLAYER_TEST_SILENT_OUTPUT`; document tab switching, clipboard, export, and close flows passed)
  - `node tests/desktop/parity-recovery.mjs --group=crash` — exited `0` (`"passed": true`)
  - Inert driver CLI/self-test smoke checks (`parity-score-layouts.mjs --help`, `parity-input-preferences.mjs --help`, `parity-recovery.mjs --self-test`) — exited `0` (without full `--state`/`--build` runs)
- **Visual screenshot verification (`1366×768` / `1920×1080`):** Inspected `.analysis/desktop-smoke/gp8-slice2-1366.png`, `gp8-slice2-1920.png`, `gp8-slice3-1366.png`, `gp8-slice4-1366.png`, and `gp8-slice5-export-1366.png`.
- **TypeScript & Vitest (post-edit):**
  - `npx tsc --noEmit` — exited `0`
  - `npx vitest run src/engraving/tab-string-hit.test.ts src/ScoreView.test.tsx src/editor/gp8-keys.test.ts src/editor/score-entry.test.ts src/editor/palette-actions.test.ts src/export/ExportDialog.test.tsx src/shell/small-window.css.test.ts src/workstation/notation-toggle.css.test.ts src/i18n/i18n.test.ts src/App.test.tsx` — `10` test files, `504` tests passed (`0` failed, `0` skipped)
  - `npx vitest run src/EditorPanel.test.tsx src/editor/EditingToolbar.palette.test.tsx` — `2` test files, `18` tests passed (`0` failed, `0` skipped)

# GP8 parity W20: application language localization (2026-10-31)

Tracker row W20: application language localization. Adds a lightweight, dependency-free i18n layer in `src/i18n`, complete English (`en`), Estonian (`et`), and German (`de`) message catalogs, runtime language switching via a React hook, and system language detection. User-visible strings across the app shell, transport, top bar, dialogs, and Help topics are centralized into the catalog.

## Behavior
- **Dependency-free i18n core.** Implemented in `src/i18n`:
  - `src/i18n/types.ts`: defines `SupportedLanguage` (`'en' | 'et' | 'de'`), `LanguagePreference` (`'system' | SupportedLanguage`), and typed message catalog interfaces.
  - `src/i18n/en.ts`: canonical English message catalog acting as the typed source contract (`MessageKey`).
  - `src/i18n/et.ts`: full, idiomatic Estonian translations for every catalog key.
  - `src/i18n/de.ts`: full, idiomatic German translations for every catalog key.
  - `src/i18n/storage.ts`: manages preference loading and persistence across `tabplayer.language` and `tabplayer.input.preferences`. Resolves system language from `navigator.language` (`et*` -> `et`, `de*` -> `de`, else `en`).
  - `src/i18n/index.ts`: provides `getMessage`, parameter interpolation (`{token}` replacement), external store subscription, and the `useI18n()` React hook.
- **Strict English fallback.** If a translation key is missing or empty in a localized catalog, it automatically falls back to English. If a key is completely unknown, it returns an empty string or English fallback, never leaking raw programmatic keys (e.g., `menu.file`) to the user interface.
- **Preference integration.** The active language choice is selectable from the View menu under `Preferences` (`Language` / `Keel` / `Sprache`). It supports `System default`, `English`, `Eesti`, and `Deutsch`. Choices are saved with existing preferences in `localStorage` (`tabplayer.language` and synced to `tabplayer.input.preferences`).
- **Reactive runtime switching.** When the user changes language in the View menu, `setLanguagePreference` notifies the `useSyncExternalStore` subscription. Components re-render immediately with the new language without reloading the window or dropping unsaved project state.
- **Localized UI surfaces:**
  - **App Shell & Top Bar:** File menu, View menu, Undo/Redo titles and labels, View switch (Score, Sound, Mixer), panel toggles (Track panel, Inspector, Bottom dock), workspace rail buttons, and document title fallback.
  - **Transport bar:** Play/Pause/Stop, position descriptions, Loop bars, Click/Metronome, Speed, Slower/Faster, More playback, Seek, pulse status, and practice feedback messages.
  - **Help system:** Top bar Help dropdown (keyboard shortcuts and editing guides) and the modal `HelpDialog` with all 8 help topics (`start`, `editing`, `tracks`, `inspector`, `playback`, `files`, `shortcuts`, `about`) and update status.
  - **Dialogs:** Base `Dialog` (close label), `RecoveryPrompt`, `AsciiTabImportDialog`, `MidiImportDialog`, `LibraryDialog`, `BatchConvertDialog`, `ExportDialog`, `SavedTuningsDialog`, and `CommandPalette`.
- **Untranslated data areas kept as data:**
  - Rig block and effect names (`drive`, `delay`, `graphicEq`, `reverb`, `cabinet`, preset names like `Slapback`, `Late drive`).
  - Musical instrument preset names (`Steel Guitar`, `Electric Bass`, standard tuning names).
  - Musical data terms and expressions (`Am7`, `ff`, `3/4`, note names `C`, `D#`, MIDI pitches).

## Evidence
- **TypeScript verification (`tsc --noEmit -p .`):** Clean compile with zero type errors.
- **i18n unit tests (`src/i18n/i18n.test.ts`):** 14 tests passing covering:
  - Catalog completeness across languages: guarantees `et` and `de` contain non-empty translations for every key in `en` with no orphan keys.
  - Fallback behavior: missing keys fall back to English, unknown keys never display raw key names, and system language detection falls back to English for unknown locales (`fr`, `ja`, etc.).
  - Storage round-tripping: reads and writes both `tabplayer.language` and `tabplayer.input.preferences`.
  - `useI18n` hook and runtime switching: switching between `en`, `et`, and `de` updates translated text and parameter interpolation live.
- **App integration test (`src/App.test.tsx`):**
  - Added runtime switching test verifying that opening the View menu, selecting Estonian (`et`), updates top-level menus (`File` -> `Fail`, `View` -> `Vaade`, `Help` -> `Abi`), Undo tooltip (`Võta tagasi`), and transport controls (`Esita`, `Peata`).
  - Switching to German (`de`) updates controls to `Datei`, `Ansicht`, `Hilfe`, `Rückgängig`, `Abspielen`, `Stopp`.
  - Switching back to English restores original strings.
- **Component dialog suites passing:**
  - `src/ui/Controls.test.tsx`: 23 tests passed.
  - `src/help/help.test.tsx`: 5 tests passed.
  - `src/workspace/RecoveryPrompt.test.tsx`: 9 tests passed.
  - `src/workspace/AsciiTabImportDialog.test.tsx`: 7 tests passed.
  - `src/workspace/MidiImportDialog.test.tsx`: 9 tests passed.
  - `src/library/LibraryDialog.test.tsx`: 20 tests passed.
  - `src/batch/BatchConvertDialog.test.tsx`: 10 tests passed.
  - `src/export/ExportDialog.test.tsx`: 33 tests passed.
  - `src/tuning/SavedTuningsDialog.test.tsx`: 15 tests passed.
  - `src/editor/CommandPalette.test.tsx`: 8 tests passed.
  - `src/App.test.tsx`: full integration test suite passing.

## Review
- **Accessibility & Role Names:** In English mode (the default for tests and desktop drivers), all control accessible names and roles (`File`, `View`, `Help`, `Undo`, `Redo`, `Play`, `Stop`, `Loop`, `Playback position`, etc.) remain identical to pre-localization values. Existing desktop drivers continue finding controls without modification.
- **Zero New Dependencies:** Implemented without third-party i18n libraries (`i18next`, `react-intl`, etc.) using React 19's native `useSyncExternalStore`.
- **Protected code integrity:** `src-tauri/src/audio/tone.rs` was untouched.
- **Surrounding style:** Maintained concise functional style matching surrounding workspace code.

## Limits
- **Music data terms:** Harmonic analysis names, chords, and dynamic marks (e.g., `Am7`, `pp`, `ff`) remain musical notation data and are not localized.
- **alphaTab engraving canvas:** Score canvas glyphs and notation elements rendered internally by alphaTab remain in their standard graphical representation.
- **Native audio engine backend:** Low-level Rust backend OS error strings returned directly from OS drivers (e.g. WASAPI device initialization errors) remain in their native system formatting.

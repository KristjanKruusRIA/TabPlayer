# GP8 parity W20: complete interface translation across engine, sound inspector, curves, and tunings (2026-10-31)

Tracker row W20: Finish interface translation. Extends the lightweight `src/i18n` layer across engine refusals, sound inspector and rig stages, curve and pitch editors, tuning presets and dialogs, and active editor indicators. Complete English (`en`), Estonian (`et`), and German (`de`) message entries have been added for every key. Preset IDs and saved project formats remain untouched.

## Behavior
- **Engine refusal localization (`src/engine.ts`):**
  - Replaced all ~40 plain `throw new Error('...')` refusals across project loading, validation, playback ranges, note entry, fret bounds, and track manipulations with `throw refusal(key, params)`.
  - Refusals resolve via `getMessage(getResolvedLanguage(), key, params)` returning localized error messages while preserving error inheritance and stack traces.
- **Tuning presets and dialogs (`src/tuning-presets.ts`, `src/TuningInput.tsx`, `src/tuning/SavedTuningsDialog.tsx`):**
  - Localized instrument names (`Guitar`, `Bass`, `Banjo`, `Mandolin`, `Ukulele`), string counts, and tuning preset titles across all 37 factory presets.
  - Preset IDs (`standard-e`, `drop-d`, etc.) remain identical, guaranteeing full backward and forward compatibility with saved scores and documents.
  - Localized the Saved Tunings modal dialog: section titles (`Personal`, `Built-in`, `Details`), input labels, validation error banners, immutable built-in help text, and actions.
- **Sound inspector and rig hardware blocks (`src/audio/`, `src/rig/`):**
  - Localized pedalboard block names, model selectors (amp models, cabinet models, drive, reverb, and wah models), footswitch labels, parameters, and EQ band controls.
  - Localized signal chain manipulation actions (`Move earlier`, `Move later`, `Copy pedal`, `Paste pedal`, `Duplicate pedal`, `Remove duplicate`).
  - Localized drum kit descriptions and hardware notes in `RigDrumKit.tsx`.
- **Curve editor and technique readouts (`src/editor/CurveEditor.tsx`, `src/EditorPanel.tsx`):**
  - Localized bend and whammy curve presets (`Bend & release`, `Pre-bend`, `Pre-bend & release`, `Dive`, `Scoop`, `Dip`, `Hold`), curve type and style dropdowns, curve preview aria-labels, point position and pitch inputs, quarter-tone steps formatting, and action buttons.
  - Localized active note technique pills in `EditorPanel.tsx` (`Bend`, `Whammy`, `Slide`, `Vibrato`, `Dead note`, `PalmMute`, `LetRing`, `Ghost`, `Harmonic`, `Trill`, `Tie`).
- **Generated technique and system messages (`src/editor/`):**
  - Localized banjo drone descriptions (`describeBanjoDrone`), partial capo summaries (`describePartialCapo`), drum kit difference summaries (`kitDifferences`), and refinger cross-voice collision and pitch boundary errors.
- **Complete tripartite catalogs (`src/i18n/`):**
  - 318 new message keys defined identically across `src/i18n/en.ts`, `src/i18n/et.ts`, and `src/i18n/de.ts`.
  - Zero orphan keys, complete structural equality, verified by `src/i18n/i18n.test.ts`.

## Evidence
- **TypeScript compilation (`npx tsc --noEmit`):**
  - 0 errors.
- **i18n catalog & surface tests (`npx vitest run src/i18n/`):**
  - 2 test files, 55 tests passed.
  - Verified `src/i18n/surfaces.test.tsx` mounts `sound` (SoundPanel), `curve` (CurveEditor), `tunings` (SavedTuningsDialog), `editor`, `mixer`, `rig`, and `instrument` in English, Estonian, and German, asserting no English labels leak in non-English modes.
  - Literal guard tests verify that neither `src/engine.ts`, `src/audio/SoundPanel.tsx`, `src/editor/CurveEditor.tsx`, nor `src/tuning/SavedTuningsDialog.tsx` contain unlocalized English literals.
- **Core engine tests (`npx vitest run src/engine.test.ts`):**
  - 42 tests passed.
- **Tuning tests (`npx vitest run src/tuning/`):**
  - 3 test files, 27 tests passed.
- **Audio tests (`npx vitest run src/audio/`):**
  - 66 test files, 976 tests passed (1 skipped).
- **Editor tests (`npx vitest run src/editor/`):**
  - 75 test files, 991 tests passed (1 skipped).
- **Sound rig tests (`npx vitest run src/rig/`):**
  - 3 test files, 81 tests passed.

## Review
- **Preset IDs & Saved Formats:**
  - Preset IDs (`tuningPresets[i].id`, sound preset IDs, effect block keys) were preserved exactly. Documents and preferences saved in earlier versions load and persist without changes.
- **Estonian Terminology Compliance:**
  - Verified catalog adheres to required terminology corrections: no forbidden review patterns (`medikaator`, `flazool`, `Balkeni`, `fermat`, `kolmekümnekahjandik`, `puhver`), using approved terms `Flazolett`, `Kolmekümnekahendikud`, `Jäta alles`.
- **German Terminology Compliance:**
  - Verified German translations use `Haltebogen` for tie (never `Bindung`), `Tapping mit der linken Hand`, and `Explizites Bogenziel`.
- **Zero New Dependencies:**
  - Leverages existing `useI18n` and `getMessage` facilities without adding external packages.

## Limits
- **No native-speaker review:**
  - The Estonian and German translations for these newly added keys were generated and reviewed for technical consistency, terminology guidelines, and grammar, but have not been reviewed by a native speaker.
- **Strings remaining in English:**
  - Command palette keywords and arguments (`src/editor/command-palette.ts`) remain English-only because the command parser only accepts English tokens (`measure`, `fret`, `tempo`, etc.).
  - Musical data values (note pitch names like `C4`, `F#3`, chord symbols like `Am7`, dynamic markings like `p`, `f`, `ff`) remain musical data notation and are intentionally not localized.
  - Low-level Rust backend and OS hardware device messages from WASAPI/CoreAudio/ALSA stay in their platform-native English representation.

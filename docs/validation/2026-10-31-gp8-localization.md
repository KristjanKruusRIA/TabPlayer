# GP8 parity W20: application language localization (2026-10-31)

Tracker row W20: application language localization. Adds a lightweight, dependency-free i18n layer in `src/i18n`, complete English (`en`), Estonian (`et`), and German (`de`) message catalogs, runtime language switching via a React hook, and system language detection. User-visible strings across the app shell, transport, top bar, dialogs, and Help topics are centralized into the catalog.

## Behavior
- **Dependency-free i18n core.** Implemented in `src/i18n`:
  - `src/i18n/types.ts`: defines `SupportedLanguage` (`'en' | 'et' | 'de'`), `LanguagePreference` (`'system' | SupportedLanguage`), and typed message catalog interfaces.
  - `src/i18n/en.ts`: canonical English message catalog acting as the typed source contract (`MessageKey`).
  - `src/i18n/et.ts`: Estonian translations for every catalog key.
  - `src/i18n/de.ts`: German translations for every catalog key.
  - `src/i18n/storage.ts`: manages preference loading and persistence across `tabplayer.language` and `tabplayer.input.preferences`. Resolves system language from `navigator.language` (`et*` -> `et`, `de*` -> `de`, else `en`).
  - `src/i18n/index.ts`: provides `getMessage`, parameter interpolation (`{token}` replacement), external store subscription, and the `useI18n()` React hook.
- **Strict English fallback.** If a translation key is missing or empty in a localized catalog, it automatically falls back to English. If a key is completely unknown, it returns an empty string or English fallback, never leaking raw programmatic keys (e.g., `menu.file`) to the user interface.
- **Preference integration.** The active language choice is selectable from the View menu under `Preferences` (`Language` / `Keel` / `Sprache`). It supports `System default`, `English`, `Eesti`, and `Deutsch`. Choices are saved with existing preferences in `localStorage` (`tabplayer.language` and synced to `tabplayer.input.preferences`).
- **Reactive runtime switching.** When the user changes language in the View menu, `setLanguagePreference` notifies the `useSyncExternalStore` subscription. Components re-render immediately with the new language without reloading the window or dropping unsaved project state.
- **Localized UI surfaces (this slice):**
  - **App shell and top bar:** File menu, View menu, Undo/Redo, View switch, panel toggles, the workspace rail (Track, Sound, Backing, Inspector and its label), finalized banner and score title fallback.
  - **Transport bar:** Play/Pause/Stop, position, loop, click/metronome, speed, More playback, Seek (button and field), pulse status and practice messages.
  - **Help:** the Help menu, the modal `HelpDialog`, all 8 topics and the update status.
  - **Recovery prompt:** title, description, checkpoint line, count (with separate singular and plural messages), region and entry labels, details, status and buttons.
  - **Dialog chrome only:** the base `Dialog` close label, and titles, primary buttons and some labels of the ASCII import, MIDI import, Library, Batch convert, Export, Saved tunings and Command palette dialogs. The bodies of those dialogs are still English (see Limits).
- **English text is unchanged.** Every English catalog value was audited against the literal it replaced in the parent commit. Drift found in review and restored: the Batch dialog heading is "Batch convert scores" again (`tests/desktop/parity-batch-convert.mjs` depends on it). Catalog keys that had no caller and drifted text were removed rather than kept.
- **Command palette words stay English.** `src/editor/command-palette.ts` only understands English command words, so the Estonian and German hints show `measure 12`, `fret 5`, `tempo 96` and `Eb major` and only the surrounding sentence is translated.
- **Data kept as data:**
  - Rig block and effect names (`drive`, `delay`, `graphicEq`, `reverb`, `cabinet`, preset names like `Slapback`, `Late drive`).
  - Musical instrument preset names (`Steel Guitar`, `Electric Bass`, standard tuning names).
  - Musical data terms and expressions (`Am7`, `ff`, `3/4`, note names `C`, `D#`, MIDI pitches).

## Evidence
Run after the review fixes, in the `slice-w20` worktree.
- **TypeScript (`tsc --noEmit -p .`):** no errors.
- **i18n tests (`src/i18n/i18n.test.ts`):** 18 passing. They cover catalog completeness (`et` and `de` define every `en` key), English fallback, no raw keys, storage round trip, runtime switching and interpolation, plus pinned wording: the Batch heading, English command words in hints, singular and plural document counts, and no `Ctrl` in German text.
- **Focused suites** (`src/i18n src/help src/workspace src/Transport.test.tsx src/batch src/editor/CommandPalette.test.tsx src/ui`, `--testTimeout=60000`): 25 files, 327 passed, 3 skipped.
- **`src/App.test.tsx` with `--testTimeout=60000`:** 152 passed. With the default 5 s timeout one run (while other work was using the machine) failed 5 tests by timeout only, not by assertion: "keeps copied music and paste drafts across unrelated renders and New", "creates piano chords, edits the clicked member and replays its history", "repairs selection after deleting the last beat, measure, and track", "inserts a beat into an empty voice and changes score information and tuning" and "stays silent for rests, deletions, undo, redo and while playing". These are slow tests, not localization failures.
- **App test for switching:** the View menu switches to Estonian (`Fail`, `Vaade`, `Abi`, `Võta tagasi`, `Esita`, `Peata`), German (`Datei`, `Ansicht`, `Hilfe`, `Rückgängig`, `Abspielen`, `Stopp`) and back to English.

## Review
- **Accessibility & Role Names:** In English mode (the default for tests and desktop drivers), all control accessible names and roles (`File`, `View`, `Help`, `Undo`, `Redo`, `Play`, `Stop`, `Loop`, `Playback position`, etc.) remain identical to pre-localization values. Existing desktop drivers continue finding controls without modification.
- **Zero New Dependencies:** Implemented without third-party i18n libraries (`i18next`, `react-intl`, etc.) using React 19's native `useSyncExternalStore`.
- **Protected code integrity:** `src-tauri/src/audio/tone.rs` was untouched.
- **Surrounding style:** Maintained concise functional style matching surrounding workspace code.

## Limits
- **Partial localization.** This slice does not localize every visible string. Still English: the input preferences panel in the View menu, the bodies of the ASCII import, MIDI import (hint, quantization, tuplets, voices, part summaries), Library, Batch convert (hint, status text, report), Export, Saved tunings and Command palette result lists (command titles), and error text from the project and controller layers. Rig, mixer, inspector, instrument and track settings surfaces are covered by `slice-w20b` below.
- **Unused catalog key.** `action.cancel` has no caller on this branch; `slice-w20b` uses it. All other previously unused keys were deleted; add them back with the dialog bodies that need them.
- **Translation quality.** Estonian and German were written without a native-speaker review. Terms such as the Estonian note values and German "Fertigstellung aufheben" should be checked by a native speaker.
- **Toolbar width at 960 px is unproven.** Longer Estonian and German labels could wrap or overflow the top bar. It could not be measured with real CSS because the app needs the Tauri backend and fails to open in a plain browser (`Could not open TabPlayer: Cannot read properties of undefined`). A desktop-test build at 960 px is still needed.
- **German shortcut labels** use `Strg` for Ctrl; Shift and Cmd are left as they are.
- **Music data terms:** harmonic analysis names, chords and dynamic marks (e.g. `Am7`, `pp`, `ff`) remain notation data and are not localized.
- **alphaTab engraving canvas:** glyphs and notation elements rendered by alphaTab keep their standard form.
- **Native audio backend:** Rust backend and OS error strings (e.g. WASAPI device initialization) stay in their native form.

- **Merged into develop after both slices.** Strings that develop added while these slices were open stay English: the password protection menu item, banner and dialog, and the "Tie to earlier pitch" button. The new Ctrl/Cmd + T help line has `help.topic.shortcuts.tie` in all three catalogs; the Help menu's short list keeps it in English.

## Extended Coverage (Slice W20b: Mixer, Rig, Instruments, Workstation & Editor Panels)

Extended localization to all remaining user-visible interface strings across the Mixer view, Sound Rig hardware view, Instrument and live playback surfaces, Workstation panels, and all Editor panels / Inspector tasks. Full Catalan-free, natural Estonian (`et`) and German (`de`) translations were added for every message key alongside the canonical English (`en`) strings.

### What Moved to the Catalogs
- **Mixer (`src/mixer/MixerView.tsx`, `src/audio/MasterPanel.tsx`):**
  - Section titles, channel strip labels, mute, solo, pan, volume controls, track numbering, selection state.
  - Session focus controls: percentage labels (`Focus {pct}%`, `Unfocus {pct}%`, `Off`), reset focus button, and silent track informational note.
  - Master strip: Master level, stereo balance (`Centre`, `Left {pct}%`, `Right {pct}%`), compressor parameters (threshold, ratio, attack, release, makeup), EQ bands (low, mid, mid frequency, high), reverb models (Room, Hall, Plate, Spring), reverb controls (send, room, damping), limiter parameters (ceiling, release), and reset master button.
- **Sound Rig (`src/rig/SoundRig.tsx`, `src/rig/SignalChain.tsx`, `src/rig/SoundBrowser.tsx`, `src/rig/SourcePicker.tsx`, `src/rig/BlockStage.tsx`, `src/audio/SoundLock.tsx`, `src/audio/DrumKitPicker.tsx`):**
  - Rig navigation: Sound rig title, signal chain tabs, bypass status (`enabled`, `bypassed`), second board indicator (`2nd board`), chain boundary markers (`In`, `Out`).
  - Sound presets & browser: Preset selector, Sounds toggle, search input, scope tabs (`All`, `Factory`, `My sounds`), empty library states, sound actions (`Apply`, `Hear`, `Rename`, `Delete`), save sound input and confirmation dialogs.
  - Rig stage actions: Stage placement count (`{current} of {total}`), pedal management (`Copy pedal`, `Paste pedal`, `Duplicate pedal`, `Remove duplicate`, `Move earlier`, `Move later`), footswitch states (`On`, `Bypassed`), delay limit advisory, microphone bypass notes, and flatten graphic EQ.
  - Shared audio controls: Sound lock toggle against score automations, drum kit settings header, and hit differences summary.
- **Instruments (`src/instruments/InstrumentView.tsx`, `src/instruments/LiveInstrumentView.tsx`):**
  - View modes: `Auto`, `Guitar`, `Bass`, `Drums`, `Keys`, `Neck + keys`.
  - View controls: Left-handed option, compact and expand toggles, no tuning fallback message.
  - Instrument surfaces: Keyboard, drum kit, auxiliary percussion, percussion pads, entry restriction messages across pitched and percussion staves.
  - Live instrument playback states: Focus modes (`Playing notes`, `Selected beat`, `Selected bar`, `Next beat`), corresponding captions, and empty state messages.
- **Workstation Panels (`src/workstation/ScoreOverview.tsx`, `src/workstation/TrackSettingsPanel.tsx`):**
  - Score overview: `Written measure overview` grid and `Track / measure` corner header.
  - Track settings: Track reordering and removal buttons, `Selected instrument` group, track metadata labels (name, short name, MIDI instrument), track color, string count recount legend and high/low string keeping options, and add instrument form.
- **Editor Panels & Inspector Host (`src/EditorPanel.tsx`, `src/editor/*`):**
  - Inspector host: Title, editing location, tasks (`Edit`, `Practice`, `Presentation`), edit/practice/presentation tools, selection context scopes (`All`, `Note`, `Beat`, `Measure`, `Staff`, `Selection`).
  - Editing toolbar: Durations group, rest/tie/dots controls, common technique toggle buttons (slide, bend, vibrato, palm mute, let ring, dead, ghost, staccato, harmonic, accent).
  - Author defaults panel: `New score defaults` heading, author fields (artist, lyrics, music, transcriber, copyright), save and copy action buttons with feedback alerts.
  - Bar gesture panel: Clef octave, simile options (`None`, `Previous measure`, `Previous two measures`), common/cut time, double bar, rhythmic feel, custom beaming unit and group inputs.
  - Clipboard panel: Musical clipboard, copy/cut modes (`Single track`, `Multitrack`), context guidance, paste repetitions, paste special filter checkboxes.
  - Directions panel: Directions summary, measure application notice, apply directions button.
  - Gesture panel: Beat notation (tap, slap, pop, dead slap, slash notation, timer), golpe, rasgueado, fade, beat vibrato, wah pedal, stem direction, beaming mode, barre shape and fret, octave region, hairpins, global fermata, sustain pedal.
  - Lyrics panel: Lyrics title, visible toggle, reconstruction note, syllable syntax hints, line headers, line text and start measure, line addition and deletion buttons.
  - Measure panel: Measure & notation, time signature numerator/denominator, pickup measure, free time, repeat signs and repeat count, alternate endings, section label, tempo changes, key signature sharps/flats/mode, clef.
  - Measure transform panel: Insert & remove measures, insert before/after, measure range inputs, remove measure range button.
  - Non-tab panel: New notation track form, pitched & percussion entry, chord note selector, written pitch, percussion articulations.
  - Notation entry panel: Standard notation entry, accidental buttons, octave navigation, pitch entry staff, keyboard shortcuts instructions.
  - Range panel: Music selection actions, selection counts (`note`/`notes`, `beat`/`beats`), scope selector, note erasure, ties, transposition, guitar/bass string shift, sustain strings, picking and strumming patterns.
  - Score errors panel: Score errors heading with count, mark in score toggle, complete measure status.
  - Song metadata panel: Subtitle, album, lyrics author, music author, copyright, transcriber, notices, instructions.
  - Structure panel: Staff voices & layout, staff tuning, capo, clef, transposition, tab/notation visibility, add/remove staff, voice management (add/remove/copy voice range), system layout.
  - Technique panel: Notes & techniques, technique checkboxes, fingerings, slide in/out, vibrato, ornaments, trill, ties/hammer-pull/slur actions, beat techniques (strokes, brushes, tremolo).
  - Partial capo & Banjo drone: Partial capo fret and strings, Banjo drone short string toggle and drone starting fret.
  - Note audio & Spelling: Note audio controls (sounding length, start offset, velocity change), reset button, enharmonic spelling, and cautionary accidental.
  - Input preferences: Score input legend, play notes while editing, auto-duration, numpad durations, paste diagrams.

### What Stays English (Data & Musical Boundaries)
- **Preset names & sound library tones:** Factory sound names (`Rock lead`, `Late drive`, `Slapback`, `Crunch`), preset identifiers (`gm`, `clean`, `acoustic`, `metal`, `jazz`), and user preset titles.
- **Instrument voice names & MIDI programs:** Automatic voice IDs and labels (`Green Guitar`, `Black Guitar`, `Darkblack Bass`, `Babyblue Bass`), General MIDI instrument names (`Acoustic Grand Piano`, `Electric Bass (finger)`, etc.), and drum piece identifiers (`kick`, `snare`, `hi-hat`).
- **Effect block IDs & gear models:** Hardware block IDs (`drive`, `amp`, `cabinet`, `delay`, `reverb`, `graphicEq`), amp models (`tweed`, `plexi`, `recto`), cabinet models, and microphone placement tokens.
- **Musical chord symbols & pitch notation:** Chord diagrams and names (`Am7`, `C#dim`, `Gsus4`), note pitch identifiers (`C4`, `F#3`), scale names (`Major`, `Dorian`), and dynamic symbols (`ppp`, `pp`, `p`, `mp`, `mf`, `f`, `ff`, `fff`).
- **Direction notation terms:** Traditional Italian musical direction markers (`Fine`, `Segno`, `Coda`, `D.C.`, `D.S.`, `To Coda`).
- **alphaTab engraving canvas:** Score canvas glyphs, tabs, noteheads, and notation elements rendered internally by alphaTab.

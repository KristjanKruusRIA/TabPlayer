# THE-215 part 2: the inspector has Song and Track only

Branch `agy/the-215-inspector` (from `develop` 13922ef), 2026-11-15. Windows only.

Owner decisions this implements: the sidebars have far too many options and take too much space (the model is Guitar Pro's inspector, styled as TabPlayer); "Remove the selection tab". Not changed, because the owner has not answered: the Tuning dialog's default button (still **Keep fingering**) and the tuning order (still high to low).

The Selection-tab removal was taken as the go-ahead for the proposal's main moves on the Song and Track tabs too. Each of those moves is its own change and can be undone alone; they are listed under "Moves the owner can object to".

## What the app does now

- **Inspector tabs: Song and Track.** The last tab used is remembered (`tabplayer.inspectorTab`, new; before this there was no remembered tab and the app always opened on Selection). A stored `selection` value, or anything unknown, opens Track.
- **Status bar** shows the track (and the staff when the track has several), then `Bar · Beat · String · Voice`, then the fret and pitch of the note under the cursor (or the rest, or the selected range or notes), its techniques, the time signature, the tempo and the chord. This replaces the Selection tab's context card.
- **Properties dialog** (Note menu, Note properties… and Beat properties…; Bar menu, Bar properties…; Section menu, Sections…; the palette's Lyrics button; Ctrl+Shift+V; the palette's time signature, tempo, key and clef buttons) holds, as tabs, what the Selection tab held that has no other home: **Note**, **Beat**, **Bar**, **Selection**, **Staff and voices**, **Pitch entry**, **Score**. Its panels are the old panels with the same edits.
- **Track tab**: Information (the four track action icons, then colour, name and short name in one row; the MIDI instrument under More), Musical notation (two toggles for tablature and notation, the tuning row, More), Sounds (source, preset, a chip for each pedal that is on, one button for the editor dialog), Interpretation (five compact rows), MIDI output and Add instrument (each a closed disclosure).
- **Tuning dialog** has a **Capo** section: the capo, and under "Partial capo and banjo drone" the partial capo and the drone (the same controls as before).
- **Song tab**: Information (title and artist; initial tempo, the nine metadata fields and "New score defaults…" under More), Musical notation (one row, "Score style…"), Sound mastering (four slot rows with a switch and an edit button, and "Show all mastering controls…").
- **Score style dialog** holds the 13 score-style sections in three groups: Engraving and fonts, Spacing and grouping, Page and view.

## Relocation table

Rule used: (a) a control is removed as a duplicate only when another place records the same edit and is reachable by mouse and by keyboard; (b) a per-note, per-beat or per-bar property with no other home keeps its panel (same edits) in the Properties dialog; (c) staff settings go to the Track tab and the Tuning dialog; (d) the readout goes to the status bar.

### Former Selection tab

| Former control | Now | Why / check |
|---|---|---|
| Context card: selection summary, active technique pills, All / Note / Beat / Measure / Staff / Selection filter | **Status bar** (track and staff, bar, beat, string, voice, fret and pitch or rest or selection, techniques, time signature, tempo, chord). The scope filter is gone; the Properties dialog's tabs replace it. | (d). The strings that were English-only in the card are now catalogue text in en, et and de. |
| Measure, Beat, Staff, Voice, String selectors | **Removed** (duplicate). Click the score, arrow keys (beat, string), the palette's voice buttons 1-4, command palette `measure N`. | Same selection state; keyboard reachable. Selecting a staff other than by clicking is the one thing that got slower. |
| Fret field, Set note | **Removed** (duplicate). Typing digits on the score, or command palette `fret N`: both record `setNote` with `target`, `string`, `fret`. | App.tsx key handler and `command-palette.ts` build the same payload. |
| Remove note | **Removed** (duplicate). Backspace (`removeNote` / `removeNoteByIndex`). | `help.shortcut_gp8_edit`. |
| Duration, Dots, Apply rhythm (plain), Make rest, Insert beat, Delete beat | **Removed** (duplicates). Palette duration, dot, rest and tie buttons (`setDuration`, `setRest`); command palette `duration`, `rest`, `insertBeat`, `deleteBeat` (`setBeatRhythm`, `setRest`, `insertBeat`, `deleteBeat`); Ctrl+Insert, Shift+Delete. | Same edit types and payloads. |
| Advanced rhythm: tuplet numerator and denominator, grace type, Apply rhythm | **Properties > Beat** (`BeatRhythmPanel`). Now records nothing when the values are the beat's own. | The palette only offers 3:2 and ten ratios, so arbitrary tuplets would otherwise have been lost. |
| Append measure, Remove measure | **Removed** (duplicates). Command palette `appendMeasure`, `removeMeasure`; Insert and remove measures remains in Properties > Bar. | |
| Musical tools: Edit chord diagram, Browse scales | **Removed** (duplicates). Palette Chords / Scale diagram; Effects > Chord; Tools > Scales. | |
| Spelling (enharmonic, cautionary), Notes and techniques (36), pitched and percussion entry | **Properties > Note** (same panels, same edits). The common techniques are also palette buttons. | The numeric note audio values, bend and whammy curves, explicit slurs and trill options have no palette home. |
| Beat notation (29: tap, slap, pop, golpe, rasgueado, fade, vibrato, wah, stem, beaming, barre, hairpin, pedal, ottava, global fermata) | **Properties > Beat**. | |
| Beat text | **Removed** (duplicate). Palette `TXT` prompt (`setBeatText`). | |
| Music selection (select bar, track, all; scope; erase; tie; transpose; refinger; strokes; sustain) | **Properties > Selection**. | Not duplicated by the Edit menu (which has cut, copy, paste, select track only). |
| Musical clipboard (copy and cut mode, copy, cut, paste, paste special) | **Properties > Selection**; Ctrl+Shift+V opens it at the clipboard. The Edit menu keeps its single-track cut, copy and paste. | |
| Harmony transposition | **Properties > Selection**. | |
| Standard notation entry | **Properties > Pitch entry**. | It is a note-entry tool, not a duplicate of the palette's accidentals. |
| Sections, Score errors | **Properties > Score** (Section menu, Sections…). | |
| Measure and notation (time, pickup, free time, repeats, endings, tempo changes, key, clef per bar), Directions, Bar gestures, Insert and remove measures | **Properties > Bar** (Bar menu, Bar properties…; the palette's time signature and tempo buttons and the tempo link open it). | The palette's bar group duplicates part of it but not tempo changes, pickup or measure ranges. |
| Staff, voices and layout: add and remove voice, copy voice, system layout | **Properties > Staff and voices**. | |
| Lyrics | **Properties > Staff and voices**; the palette's Lyrics button opens it there. | The proposal called this a duplicate of a left Lyrics tab; it was not: the palette button opened the Selection tab's panel. |
| Staff tuning (field, preset, saved tunings, headstock, steppers, six play buttons), Keep pitch | **Gone from the app.** The Tuning dialog (Keep fingering / Keep pitch, library, per-string rows, play). The old `TuningInput` component and `KeepPitchBox` are deleted. | One tuning editor everywhere. |
| Capo, partial capo, banjo drone | **Tuning dialog, Capo section.** | See "Capo rules". |
| Clef, sounding and display transposition, Show tablature, Show notation | **Track tab > Musical notation**: two toggles, More (clef, transposition). Each applies at once. | Old Apply staff settings button removed. |
| Add staff, Remove staff | **Track tab > Musical notation > More.** | |
| Apply staff settings | **Removed.** | |

### Former Song tab

| Former control | Now |
|---|---|
| Title, Artist, Apply score info | Fields apply when left; Apply removed. |
| Initial tempo | Kept, under More (the proposal said remove; the command palette `tempo` and bar 1's tempo remain). Applies when left. |
| Song metadata (subtitle, album, words, music, copyright, transcriber, notices, instructions, Apply) | Under More, each field applies when left (one `setScoreMetadata` with all eight fields); Apply removed. |
| New score defaults (default artist, authors, copyright, use this score's details, Save defaults) | "New score defaults…" button under More, in a dialog; its own Save defaults. |
| Engraving, Staff profiles, Stylesheet, Notation, Typography, presets, Saved styles | Score style dialog, group Engraving and fonts. |
| Design: bar widths, system gaps, staff groups | Score style dialog, group Spacing and grouping. |
| Page layout, Default view | Score style dialog, group Page and view. |
| Sound mastering (level, balance, compressor, EQ, reverb, limiter, Reset) | Four slot rows (switch, edit button) and a section button that opens the full controls (level, balance, every effect, Reset) in a dialog. |

### Former Track tab

| Former control | Now |
|---|---|
| Track name heading | The name field. |
| Move up, down, Duplicate, Remove | Unchanged (part 1). |
| Selected instrument: name, short name, colour, MIDI instrument, two Apply buttons | One row (colour swatch, name, short name), each applies when left or settled; MIDI instrument under More; Apply buttons removed. |
| Tuning row, Tuning dialog | Unchanged (part 1) plus the Capo section. |
| Add instrument, New notation track | Unchanged, folded; New notation track is inside Add instrument. |
| Sound: lock, source, preset, restore, factory sound, preview, copy, paste, saved sounds, plug-in, 20 pedal rows, output device | Source and preset rows, a chip for every pedal that is on, and "Sound and pedalboard…" which opens the same `SoundPanel` in a dialog (the chip opens it at that pedal). |
| Interpretation: playing style, palm mute, accent, brush, let ring | Same five controls as compact rows (label, one control), no hint paragraph (it is the section's description). |
| MIDI output | A closed disclosure. |

## Apply, Save and Update buttons

| Button (before) | Now |
|---|---|
| Apply score info (Song) | **Removed.** Title and Artist apply when left (Enter or leaving the field); one `setScoreInfo`, with `preserveOpeningMark` when the tempo is unchanged, as before. |
| Apply song metadata (Song) | **Removed.** Each of the eight fields applies when left as one `setScoreMetadata` with all eight fields. |
| Apply instrument settings, Apply track color (Track) | **Removed.** Name, short name and MIDI instrument each apply when left or chosen (`setTrackInfo` with the other two as they are); the colour applies when the picker settles (`setTrackColor`). |
| Apply tuning, Keep pitch (Track, part 1) | **Kept** in the Tuning dialog (Keep fingering, Keep pitch, Change string count): the tuning, the string count and now the capo are several fields applied together. |
| Apply staff settings (Selection) | **Removed.** Toggles, clef and transposition apply at once; capo, partial capo and drone go with the tuning in the dialog. |
| Apply rhythm (Selection) | **Kept** in Properties > Beat for the tuplet and grace fields (two fields applied together); disabled when nothing changed. |
| Apply measure settings, Apply bar notation, Apply directions, Apply measure gestures, Apply simile, Apply clef octave, Apply hairpin, Apply octave region, Apply sustain pedal, Apply global fermata, Apply beat gestures, Apply stroke pattern, Apply selection scope, Apply lyrics, Apply system layout, Apply beat text | **Kept as they are** inside the Properties dialog panels (the panels are unchanged: several fields are applied together). **Apply beat text** is gone with the Beat text section (the palette prompt has its own Apply). |
| Engraving Apply and Reset, Apply stylesheet, notation presets Apply, Saved styles Save and Update, Typography Apply, Design Apply and Reset, Apply page layout, Save default view, Save defaults | **Kept as they are** inside the Score style dialog (same apply semantics per control; nothing is recorded by opening or closing the dialog). Save defaults stays in the New score defaults dialog. |
| Master Reset | Kept in the mastering dialog; the four power switches apply at once (one undoable change each, as the panel's switches did). |
| Sound Apply factory sound, Apply saved sound, Save sound, Rename | **Kept** in the Sound and pedalboard dialog (the unchanged `SoundPanel`); the source and preset rows in the pane apply on change as before. |

## Capo rules in the Tuning dialog

- The Capo section edits the staff under the cursor (the track's first staff when the cursor is elsewhere). Its fields are drafts like the notes: Cancel and Escape discard them. Enter in the Capo, Partial capo fret and Drone fret fields only settles that field; it does not apply the dialog. A partial capo or drone fret that was typed but not left is settled, not dropped, when the dialog is applied from a button.
- On a track with several staves the tuning row and the Tuning dialog act on the selected staff (see the staff selector under Review round). A retune of the same string count is one `setStaffSettings` on that staff with the tuning, its name and `keepPitch` when Keep pitch was pressed, the edit the old Staff tuning field recorded. A string count change stays a whole-track `setStringCount`. A single-staff track behaves exactly as before (`setTuning`).
- A capo, partial capo or drone change with the tuning unchanged is one `setStaffSettings` with the staff's other settings and tuning name as they are. Nothing is recorded when nothing differs.
- A capo change together with a new tuning of the same string count is one `setStaffSettings` on the staff (tuning, tuning name, `keepPitch` when Keep pitch was pressed), on a track with one staff or several. With a changed string count the dialog stays open and says to change the string count and the capo one at a time, because a whole-track string count change and a one-staff capo cannot be one edit.
- An invalid capo, partial capo or drone keeps the dialog open with the reason.

## Moves the owner can object to

Each is separate. Undoing one means putting the old section back in the same place.

1. Initial tempo is kept under Song > More, not removed as the proposal said.
2. Song metadata is behind More and applies on leaving a field.
3. New score defaults is a dialog opened from More, not a Preferences menu entry.
4. Page layout and Default view are in the Score style dialog (Page and view), not under File and View menus.
5. Sound mastering is four slot rows plus a button for the full controls.
6. The Track information row has no instrument icon (we store none); the MIDI instrument is under More.
7. Add instrument and MIDI output stay as folded disclosures in the Track tab, not menu entries.
8. Sounds is a two-select summary, an effect strip of the pedals that are on, and one button for the sound editor dialog; the editor is the old panel unchanged.
9. The Selection tab's note, beat, bar, selection, staff, entry and score panels are kept whole in the Properties dialog instead of being pruned further; only verified duplicates were removed (see the table). Pruning them is a later step.
10. A remembered inspector tab (new preference).
11. Interpretation: the explanatory hint under it is now the section's accessible description, not visible text.

## Open points

- The Properties dialog is modal: the score cannot be clicked, Space does not play and undo does not run while it is open. Close it, move the cursor, open it again. The owner has been asked whether it should become a floating non-modal panel; modality was deliberately not changed in the review round.
- Hiding the edition palette now also hides the duration, dot, rest and text buttons that used to be in the Selection tab (the Duration, Rest and Text controls were removed from the inspector). The command palette (`duration 8`, `make rest`, and the text commands) is the fallback and records the same edits.
- Tests that could not be carried over are listed under Tests.


## Review round

Fixes after the review of the branch, each with a unit test (and the real-app driver `inspector-review.mjs` where a driver can show it):

1. **A field commits to the target it was typed for.** `CommitField` remembers the target (a track by identity and a staff) when typing begins and hands it back with the text; the panel resolves it in the score as it is when the commit happens. A draft typed for one track and left by a click that makes another track active is recorded once, for the first track, and the field then shows the other track. A half-typed track name is no longer discarded when the track changes (the `key` that remounted the row is gone). This covers every commit-on-leave field on the Song and Track tabs (title, artist, tempo, metadata, track name and short name, both transpositions). Tests: `CommitField` through `TrackSettingsTargets.test.tsx` (name and transposition, blur before and after the selection moves, tracks reordered, staff changed) and the driver (type, click another track's name in the overview, assert one edit on the right track).
2. **Staff selector and per-staff tuning.** A track with several staves shows a Staff selector next to the notation toggles (a native select, reachable by keyboard; ArrowDown moves the cursor to staff 2). The tuning row and Tuning dialog act on the selected staff with the old Staff tuning field's edit; capo plus retune works there too. No new edit type. Single-staff tracks are unchanged.
3. **Focus in the Properties dialog.** The moved panels (Technique, Measure, Gesture, Directions, Lyrics, Range, Structure, BarGesture, MeasureTransform, NonTab, BeatRhythm) now refuse while busy through `BusyFieldset` and `busyGuard` instead of `disabled`, including buttons that became disabled after the apply because there was nothing left to apply. The selected tab takes focus when the dialog opens. A test walks every Apply button on four tabs and checks that it keeps focus while busy; the driver applies a rhythm and checks `document.activeElement` and that a second Enter closes nothing.
4. **A field left while an edit is in flight** keeps its draft (the fieldset refuses the blur) and is applied, as one edit to its own target, when the edit ends. A field still being typed in is left alone until it is left.
5. **Dialogs on the document body.** Score style, Sound and pedalboard, mastering and New score defaults are rendered in a portal, as the Tuning dialog is. Driver: open Score style, make the window 520 px high, assert it is still visible, inside the window and not covered.
6. **Tuning dialog.** Enter in the main Capo field only settles it; typed partial capo and drone frets are settled when the dialog is applied from another control.
7. **Numbers compare as numbers** (`120.0` or ` 120` over a tempo of 120 records nothing). **Selects that apply on change** (MIDI instrument, clef, sound source, sound preset, the Interpretation selects) use a new `CommitSelect`: a choice made with the pointer or the open list records at once; arrow, Home, End and Page keys on the closed select only browse, and the choice is recorded when the select is left or Enter is pressed (Escape puts the old value back). There was no existing pattern for this in the app, so this one is new; the driver checks four ArrowDown presses record nothing and Tab records one edit.
8. **Dropped tests.** `types a fret only from a plain digit, never from Ctrl or Alt with one` and `hidden panes retain their mounted Song and Track drafts without score changes` were not dropped: they are in `App.test.tsx` rewritten for the new tabs (a modified digit writes no note and records nothing; the Song and Track drafts survive hiding the inspector and the tab switch, which still holds).

Verification after the review fixes (a fresh `scripts/build-desktop-test.ps1` build of this branch, then a frozen packet built last): `npm run typecheck` passes; `npm test -- --testTimeout=60000` passes (430 files passed, 5 skipped; 7420 tests passed, 8 skipped; the `plan.performance` snapshot was restored). Desktop drivers, one at a time with the app closed after each: `inspector-review` (new, six checks), `inspector-relocation`, `inspector-inventory`, `parity-tuning-dialog`, `parity-workstation`, `editor`, `parity-entry` and `parity-fret-typing` pass on the normal build; `parity-saved-tunings`, `parity-partial-capo` and `parity-banjo-drone` pass from the frozen packet. The other drivers in the table below were not run again after the review fixes. The new driver steps were run against the build from this branch only, not against the previous build to see them fail; the first runs of `inspector-review` failed on driver mistakes (a note click does not change the active track, a label match on a select, `selectOption` on the staff selector not reaching React), which are fixed in the driver.

## Heights at the default window

Real app (desktop test build), window 1440 x 900, inspector 304 px wide, 510 px tall pane, collapsed sections closed, a three-track guitar/bass score. Measured by `tests/desktop/inspector-inventory.mjs` (it now fails if a tab is more than 10 % over its target).

| Tab | Before (measured, `develop` build) | After (measured) | Target |
|---|---|---|---|
| Song | 1066 px, 25 visible controls | **401 px**, 13 visible controls | about 380 px |
| Track | 2628 px, 57 visible controls | **810 px**, 23 visible controls | about 800 px |
| Selection | 3338 px, 95 visible controls | tab removed | |

Both are within the targets plus 10 %, not exactly on them. A 510 px pane shows about 60 % of the Track tab; on a 1080 p window with the dock open the pane is about 690 px, so the Track tab still scrolls by about 120 px there (the tab was not measured at 1080 p; this is arithmetic from the 900 p pane, not a measurement). Screenshots (before and after, the tabs and the dialogs, and the language and width matrix) are written by the drivers to a directory given on their command line (`inspector-inventory.mjs` for the two tabs, `inspector-relocation.mjs` for the dialogs and the matrix); they are not kept in the repository.

## Tests

| Check | Result |
|---|---|
| `npm run typecheck` | passes |
| New or rewritten unit tests | `PropertiesDialog.test.tsx` (13: each tab's moved controls record the same edit, the current value records nothing, focus requests, busy refusal, Escape and focus return), `TrackSettingsPanel.test.tsx` (+11: toggles, transposition, clef, add and remove staff, capo alone, capo with tuning in one edit, refusals, finalized and busy), `SongInspector.test.tsx` (8), `SoundSummary.test.tsx` (5), `StatusReadout.test.tsx` (5), `inspector-tab.test.ts` (4), plus `EditorPanel.test.tsx`, `banjo-drone-view.test.tsx`, `partial-capo-view.test.tsx`, `tuning-ui.test.tsx`, `InterpretationPanel.test.tsx`, `panels.test.tsx`, `App.test.tsx`, `WorkspaceApp.test.tsx` rewritten for the new homes. |
| `npm test -- --testTimeout=60000` | 425 files passed, 5 skipped; 7357 tests passed, 8 skipped, none failed (`plan.performance.test.ts.snap` untouched). An earlier run under load had 7 timing failures (three `App.test.tsx` tests and four others) that pass when run alone and in this run. |
| Guarantees not carried over | Staff-panel tests that drove the old headstock, steppers, peg drags and the Keep pitch box (`panels.test.tsx`, `tuning-audition.test.tsx`; the equivalents live in the Tuning dialog tests); the partial-capo "controls reset when another bar is selected" test (the dialog is mounted fresh each time it opens); App tests for the Fret and Measure drafts surviving a tab switch (the fields are gone); the Selection tab's disabled state for its selectors while finalized (the keys and the palette still move the cursor); paste-option drafts kept across unrelated renders (the clipboard panel mounts only while its dialog is open); the old combined "Apply score info" edit for title, artist and tempo (three separate edits now); the Fret field's own 0-99 validation. In `App.test.tsx` the removed Fret field and Set note are replaced by typed digits or the command palette's `fret N` (same `setNote`), the removed selectors by arrow keys and `measure N`, and the removed buttons by the keys and palette commands listed in the table; where a draft lived in a removed field the test asserts the cursor instead. |

## Desktop drivers (real app, real clicks and keys)

Every driver this branch touched was run one at a time against a build of this branch, each in its own launch, and the app was closed after every run. CDP port 9223 is shared with other agents' apps, so each run waited until no `tabplayer.exe` was running, and runs that failed at launch (port held, single-instance identifier, "foreign ancestry") were repeated. A run was repeated after an assertion failure only after a driver fix, except where the table says otherwise.

Builds: the normal desktop-test build (`scripts/build-desktop-test.ps1`) for drivers that launch `.analysis/desktop-smoke/tabplayer.exe`, and a frozen packet (`string-count-build.mjs` with `STRING_COUNT_TARGET` set to the default `src-tauri/target`, run with `--run --build=<packet>`) for the drivers that admit only a packet. A packet is rejected if anything under `tests/desktop` or the other source folders changes after it was built, so it was rebuilt after each driver edit and nothing was built while a packet batch ran. `parity-resume-playback` also needs the packet's executable copied over `.analysis/desktop-smoke/tabplayer.exe`; that was done for its run and undone afterwards.

An earlier version of this note listed several packet drivers as passing. Those runs had not been given `--run`, so they only printed their usage text; all of them were run again properly and the results are below.

### Pass

| Build | Drivers |
|---|---|
| Normal build, final run | `inspector-relocation` (new), `inspector-inventory`, `parity-tuning-dialog`, `parity-workstation`, `editor`, `parity-entry`, `parity-click-seek-space`, `parity-engraving`, `parity-master-effects`, `parity-effect-order`, `parity-factory-sounds`, `critique-fixes`, `parity-author-defaults`, `parity-clipboard`, `parity-font-roles`, `parity-harmony`, `parity-midi-out`, `parity-notation`, `parity-range-measures`, `parity-score-errors`, `parity-stroke-patterns`, `parity-stylesheet`, `parity-sustain-pedal`, `parity-track-color`, `parity-view-defaults`, `review-regressions`, `parity-document-tabs`, `advanced-editor`, `native-audio`, `cancellation`, `exports`, `loop-through-edit`, `parity-command-palette`, `parity-cut-sustained`, `parity-header-footer`, `parity-pitch-effects`, `roundtrip`, `parity-selection-ties`, `parity-system-gaps`, `performance` |
| Normal build | `parity-file-library --group=core` (the `restart` and `folders` groups need the user's own pickers and were not run) |
| Normal build, second run | `parity-recovery --group=crash,clean,paths,corruption,ownership,visual`: the first run failed once at "Redo prepares retained embedded backing while both original WAVs are absent" (the backing duration was not yet known when read), the second run passed with no change; I did not find out why the first run was early, so treat it as a timing flake in the driver until it shows up again |
| Frozen packet, final | `parity-string-count`, `parity-style-typography`, `parity-stylesheets`, `parity-scale-diagrams`, `parity-resume-playback` |
| Frozen packet, earlier build of this branch (it already had the product fix below; the later builds only changed three other drivers) | `parity-saved-tunings`, `parity-partial-capo`, `parity-banjo-drone`, `parity-finalize`, `parity-library-browse`, `parity-note-audio`, `parity-note-audition`, `parity-reload-recovery` |

`parity-saved-tunings`, `parity-string-count` and the Tuning dialog drivers were run again after the Enter fix below.

### Failing, with the attribution

| Driver | Result | Cause |
|---|---|---|
| `display-modes.mjs` | 679 checks, 18 fail ("tab digits stay at least 6px tall" on the fit-page layouts at 32 to 42 % zoom) | Not caused here. The same driver against a build of `develop` (13922ef) fails 19 checks, the same 18 plus a one-pixel window-size check. |
| `parity-staff-groups.mjs` | 17 of 18; the last check ends with the page error "A notation system does not fit this page" | Not caused here. A `develop` build gives the identical 17 of 18 and the identical error. |
| `parity-selection-playback.mjs`, `selection-playback-gestures.mjs` | stop at a click on "Loop selection": the name now matches two buttons | Not caused here. The `develop` build fails both drivers at the same click with the same message (the transport button and the Selection tab button share the name there too). Not fixed. |
| `parity-input-preferences.mjs` | fails at "Keypad is inert while the preference is off": a typed fret now writes the note at once | Not caused here. This comes from THE-213 (typed digits write at once, already on `develop`); the driver still expects the old pending-fret behaviour. I changed it only to read the fret from the status bar and left a note in the file. It needs the owner's decision on what the keypad check should say. |

### Not run

| Driver | Why |
|---|---|
| `parity-backing-tempo.mjs`, `parity-backing-waveform.mjs`, `parity-score-layouts.mjs` | They run only from an admission a person writes and signs off (`docs/acceptance/admission-gated-drivers.md`); I cannot write one. Their node self-tests (14 of 14) pass. |
| `parity-recovery-production.mjs` | Needs the production build that the root supplies; inert without it. |
| `parity-file-library.mjs` `restart` and `folders` groups | Need the user's own file pickers. |

### Faults found and fixed by the driver pass

- The Tuning dialog's partial capo and banjo drone fret fields settled on Enter and then let the key submit the dialog, which applied the whole tuning with the stale draft. Enter in those two fields now only settles the field (`TuningDialog.tsx`, with a unit test in `TrackSettingsPanel.test.tsx` that fails without the fix). Enter in the Capo field itself still applies, as in any dialog.
- Drivers written for the Selection tab and the old panels were updated to the new homes. Several had to reopen the Score style or Properties dialog before the next control, because a button used inside a dialog closes it. `parity-harmony` failed because the Properties dialog was left open and its backdrop covered the palette's chord button (a stale driver, not a product fault).
- `parity-scale-diagrams` matched the diagram cell "String 5, fret 3" by substring, which also matched the "Put C3 on string 5, fret 3" button; it now matches the start of the label, and moves the pointer off the chip before hovering it again.

## Limits

- Windows only. No macOS or Linux run. No screen-reader pass; keyboard behaviour is covered by unit tests and the driver (Tab trap, Escape, focus return, Space rules), not by a keyboard-only walkthrough.
- The Properties dialog is modal, so the score cannot be clicked while it is open; the Selection tab used to stay beside the score. This is the main usability cost of the move and is the first thing to look at if it feels wrong; making it a non-modal docked panel would be the alternative.
- The Properties dialog keeps the old panels whole; it is a relocation, not a pruning. Each panel is still long.
- Tuning is still high to low and the Tuning dialog's default is still Keep fingering (owner questions unanswered).
- The hit-target rule (at least 24 px) is checked by the relocation driver for buttons, summaries, tabs and checkboxes in the inspector and the new dialogs, except the pre-existing small checkboxes inside the partial capo, drone and `.check` rows.


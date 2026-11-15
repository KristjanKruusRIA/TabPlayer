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

- The Capo section edits the staff under the cursor (the track's first staff when the cursor is elsewhere). Its fields are drafts like the notes: Cancel and Escape discard them.
- A capo, partial capo or drone change with the tuning unchanged is one `setStaffSettings` with the staff's other settings and tuning name as they are. Nothing is recorded when nothing differs.
- A capo change together with a new tuning is one `setStaffSettings` (tuning, tuning name, `keepPitch` when Keep pitch was pressed) only when the track has one staff and keeps its string count. Otherwise the dialog stays open and says to change them one at a time, because a track-wide retune and a one-staff capo cannot be one edit. The old Staff panel could not change the string count at all and applied its tuning per staff.
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

- Selecting a staff of a multi-staff track is by clicking the score only now.
- The Capo section applies to one staff; per-staff tunings on different staves of one track cannot be set from the Tuning dialog (it retunes the track, as in part 1).
- The Properties dialog is modal: the score cannot be clicked while it is open. Close it, move the cursor, open it again.
- Tests that could not be carried over are listed under Tests.


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

Run against the final build from this branch's default `src-tauri/target`. CDP port 9223 was shared with other agents' apps; runs that failed at launch because another app held the port or the single-instance identifier were repeated; no run was repeated because of an assertion failure except after a driver fix.

| Driver | Result |
|---|---|
| `inspector-relocation.mjs` (new) | passes: only Song and Track tabs; a stored `selection`, an unknown value, and `song` open Track, Track, Song; status bar readout; Title, Subtitle, Track name, colour, notation toggles, transposition, Add staff, capo in the Tuning dialog, sound preset, a pedal in the Sound dialog, playing style, palm mute, a 5:3 tuplet, time signature, Add voice: each exactly one edit of the expected type, Undo takes it back, unchanged values record nothing; Score style, Sound and pedalboard, Mastering, Tuning and Properties dialogs open, Escape closes, focus returns; en, et and de at the narrowest and widest sidebar: no covered, clipped, tiny (under 24 px) or overflowing control in the tabs and the dialogs, dialogs inside the window |
| `inspector-inventory.mjs` | passes (heights above) |
| `parity-tuning-dialog.mjs` | passes (12 checks) |
| `parity-workstation.mjs`, `parity-entry.mjs`, `parity-click-seek-space.mjs`, `parity-engraving.mjs`, `parity-master-effects.mjs`, `parity-effect-order.mjs`, `parity-factory-sounds.mjs` | pass |
| `parity-staff-groups.mjs` | 17 of 18 checks pass; the last, a catch-all `driver` check, ends with the page error "A notation system does not fit this page" (it was the same on the first run before the Score style dialog was involved at that step, so I could not attribute it to this change; not compared with a clean build) |
| `display-modes.mjs` | 679 checks, 18 fail, all "tab digits stay at least 6px tall" for the dense fixture on the fit-page layouts (zoom 32 to 42 %). Not touched by this change as far as I can tell (the inspector width is the same); I did not compare with a clean build |
| `editor.mjs` | passes |
| `parity-string-count.mjs`, `parity-saved-tunings.mjs` | pass, from a frozen build packet of this branch (`string-count-build.mjs` with `STRING_COUNT_TARGET` set to the default `src-tauri/target`; a packet is rejected if any file under `tests/desktop` changes after it was built, so it was rebuilt after each driver edit) |
| Also changed and run, passing | `parity-clipboard`, `parity-partial-capo`, `parity-banjo-drone`, `parity-range-measures`, `review-regressions`, `parity-stylesheet`, `parity-author-defaults`, `parity-view-defaults`, `parity-midi-out`, `parity-track-color`, `parity-notation`, `parity-score-errors`, `parity-note-audio` |
| Changed, not passing | `parity-harmony.mjs` (the chord and scale openers now use the palette buttons; it gets as far as the harmony transposition and then the palette's chord button times out in `openChord`; not diagnosed, so this driver is not verified).  |
| Changed but not run | about 25 other drivers got the same mechanical updates (`advanced-editor`, `cancellation`, `critique-fixes`, `exports`, `loop-through-edit`, `native-audio`, `parity-backing-tempo`, `parity-backing-waveform`, `parity-command-palette`, `parity-cut-sustained`, `parity-document-tabs`, `parity-file-library`, `parity-finalize`, `parity-font-roles`, `parity-header-footer`, `parity-input-preferences`, `parity-library-browse`, `parity-note-audition`, `parity-pitch-effects`, `parity-recovery*`, `parity-reload-recovery`, `parity-resume-playback`, `parity-scale-diagrams`, `parity-score-layouts`, `parity-selection-playback`, `parity-selection-ties`, `parity-stroke-patterns`, `parity-style-typography`, `parity-stylesheets`, `parity-sustain-pedal`, `parity-system-gaps`, `performance`, `roundtrip`, `selection-playback-gestures`). They were not run, so treat them as unverified. `advanced-editor.mjs` also needs `TABPLAYER_TEST_GP`. |

## Limits

- Windows only. No macOS or Linux run. No screen-reader pass; keyboard behaviour is covered by unit tests and the driver (Tab trap, Escape, focus return, Space rules), not by a keyboard-only walkthrough.
- The Properties dialog is modal, so the score cannot be clicked while it is open; the Selection tab used to stay beside the score. This is the main usability cost of the move and is the first thing to look at if it feels wrong; making it a non-modal docked panel would be the alternative.
- The Properties dialog keeps the old panels whole; it is a relocation, not a pruning. Each panel is still long.
- Tuning is still high to low and the Tuning dialog's default is still Keep fingering (owner questions unanswered).
- The hit-target rule (at least 24 px) is checked by the relocation driver for buttons, summaries, tabs and checkboxes in the inspector and the new dialogs, except the pre-existing small checkboxes inside the partial capo, drone and `.check` rows.


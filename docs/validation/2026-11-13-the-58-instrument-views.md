# THE-58: instrument views easier to practise with (U13, U14, U15)

Date: 2026-11-13. Branch `agy/the-58-instrument-views`. All three tracker rows stay partial. Nothing here was run in the desktop app, and no native (Rust) code, project schema or edit type changed.

## Delivered

### U13: click to select, tied continuations

- **Selecting from the instrument.** In the instrument view, outside "Click to edit notes", a lit position on the neck or a lit key on the keyboard is a button. Clicking it, or pressing Enter or Space on it, selects that note in the score through the same `select` the score uses, and publishes the same single-beat range a click on that beat of the score publishes (`singleBeatSelection` in `src/editor/range-selection.ts`, used by `selectFromInstrument` in `src/App.tsx`). An earlier range is replaced, so Cut, Copy or Erase afterwards act on the beat that was picked. `ScoreView` itself still builds its single-beat range with its own code; a unit test pins the helper to `rangeFromBeats`, so the two agree, but they are not one function.
- **Repeated notes.** One button stands for one position (string and fret, or key), however often it repeats in the bar. A click selects its first occurrence in the bar. A further click on the same position while that note is the selected note moves to the next occurrence, and the last wraps to the first. The accessible name says which beat the click will select ("Select G2 in the score, bar 1, beat 3"). A beat selected without a note does not count as that note being selected. Two notes of one pitch in one beat (a unison) are two occurrences of one key, told apart by the note's place in the beat, which comes from the playback plan's note id, not from a guess by pitch.
- **Keyboard and focus.** Each instrument is one tab stop. Arrow keys move between positions in musical order (by beat, then string or pitch), and Home and End go to the first and last. The marks are in a `role="group"` (not `img`) whenever they can be used. After a pointer pick, focus moves to the score pane, so digits, arrows, Delete and Space reach the score; after Enter or Space on a mark, focus stays on the instrument.
- **Hit targets.** Every neck position has a transparent 14-unit circle over it, so it can be hit without changing how the marks look.
- **Tied continuations.** A note that continues an earlier one by a tie is drawn held: a hollow dashed ring on the neck and a dashed pad on the key, named "tied" in its title and in the list of notes. This works for Selected beat, Selected bar and edit mode.

Not done for U13: drums are not clickable; held notes are not shown in the Playing and Next beat views; Selected beat still follows one voice; changes to Show are not announced; there is no comparison with the original GP8. The legibility of the held ring at dock size has not been seen.

### U14: handedness, keyboard panel

- **Handedness storage.** Left- or right-handed display is now kept in one record, `tabplayer.instrumentView`, with the other instrument view options, instead of its own key (the old key is still read until a new choice is stored). **This record is still in the WebView's localStorage, like every other front-end setting (panel sizes, view defaults, language). It moved to one place; it did not move out of the browser profile.** Keeping it with the app's own settings needs a native settings store: `SessionPreferences` in `src-tauri/src/recovery.rs` accepts only `restorePreviousSession`.
- **Keyboard panel.** The dock has a new "Keyboard" tab (and a Window menu item) that shows the keyboard alone, without the neck, mode or handedness choices. **The choice is per open document and per session: it is not stored in the document or in the user's settings, so a document that is opened, created or recovered starts on its own view.** Making it persistent per document needs a new `DocumentViewState` field and a Rust change. On a percussion staff the panel shows a message and no selectable keys. The toolbar's instrument button now reports whichever instrument panel is open.

Not done for U14: native app settings, a per-document keyboard panel, more than one neck, compact views that may scroll in a short dock, and the GP8 comparison.

### U15: note names, view options, scale overlays

- **Note names and options.** A "Note names" choice (With octave, Letters only) applies to the keyboard labels and the list of notes. Note names, neck choice, size and the Show focus persist in the same record (and so share the limit above). Click to edit keeps its own older key. The view mode does not persist: Auto follows the track. With Letters only, accessible names still carry the octave, so E3 and E4 stay two buttons and two chips.
- **Editing through the scale browser.** With a written beat selected, a position of the scale fretboard or keyboard in the Scale browser is a button that puts that note on the beat through the existing `setNote` or `addPitchedNote` command, as one undoable edit. On a string the new note replaces the one there. Positions the beat already holds are marked (pressed state and a ring) and record nothing when pressed. Each press is announced in a status line. String numbers in the browser now follow the numbering of the instrument view and the edit commands (string 1 is the lowest string); the chord diagram preview still numbers strings from the top, and was not changed.

Not done for U15: overlays on the main instrument view, the complete scale workflow (audition, insert), and persistence of the view mode.

## Texts

New or changed texts are in `en`, `et` and `de`. Estonian and German were not reviewed by a native speaker; terms were checked against the catalog (astmetraat for the fret, as the nearby Fret label and the instrument keys do: the Estonian catalog also uses krihv, and that choice is the owner's, so no existing term was renamed; löök, takt, partituur, heliredel; Takt, Beat, Bund, Partitur, Tonleiter, Klaviatur for the instrument).

## Verification

Run in the worktree, nothing else:

- `npx tsc --noEmit`: exit 0.
- `npx vitest run src/instruments src/harmony src/i18n src/editor/range-selection.test.ts src/App.test.tsx`: 32 files and 763 tests passed (run before the last Estonian wording change; `src/i18n` and `src/instruments` were run again afterwards: 14 files, 305 tests, all passed). Existing assertions changed: two in `src/App.test.tsx` that looked up the Scale fretboard and the Guitar fretboard as an image, which are now a group.
- Desktop drivers changed for the neck and keyboard now being a `group`, not an `img`, in the instrument view: `tests/desktop/critique-fixes.mjs`, `instruments.mjs`, `native-audio.mjs`, `parity-instrument-entry.mjs`, `parity-instrument-handedness.mjs`, `parity-partial-capo.mjs`. Drum kit lookups stay `img`. **These drivers were not run.**

Limits: not run in the desktop app; the held ring, hit targets and focus rings have not been looked at on screen; the browser-only WebView storage limit above.

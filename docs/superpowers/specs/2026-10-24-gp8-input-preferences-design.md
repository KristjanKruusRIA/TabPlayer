# L08: score-input preferences

Date: 2026-10-24. Status: design. Row L08 ("Input preferences: auto-duration, numpad, preview, diagram paste") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's Preferences hold a few score-input choices. The GP8 Interface page documents the diagram-in-copy-paste and plus/minus-key options; it does not describe auto-duration, keypad or preview settings, so those three are product decisions made here. TabPlayer had one such choice (**Play notes while editing**, in the View menu) and no others. This slice adds the rest beside it and uses the existing `setDuration` and `pasteMusic` commands only, so the protocol does not change.

## Preferences

All four sit in one **Score input** group in the View menu (`InputPreferencesPanel`, `src/editor/input-preferences.tsx`). They are viewer settings, stored in the app's `localStorage`, so every window shares them, under `tabplayer.input.preferences` (preview keeps its own older key). A missing or malformed stored field falls back to its default alone. They stay usable on a finalized document, since they never edit.

| Preference | Default | Behaviour |
|---|---|---|
| Play notes while editing (preview) | on | Unchanged: an entered note sounds when nothing is playing. |
| Keypad sets duration | off | With the score focused, keypad 1-7 set the selected beat to whole, half, quarter, eighth, sixteenth, thirty-second, sixty-fourth; keypad `.` toggles its dot. Each key is one `setDuration` edit that keeps the other half of the rhythm (digits keep the dots). When off, keypad keys behave as before. When on they never type a fret, even where no edit is possible. |
| Auto-duration | off | The *entry duration* is the last keypad choice, or else the rhythm of the last beat a note was written on. When on, **Enter** on a rest whose rhythm differs from it first sets that rhythm, then writes the note. |
| Paste includes chord diagrams | on | Sets the starting state of the **Chord diagrams** filter in the clipboard panel and the diagram setting of plain Ctrl+V. Ctrl+V always uses the preference, not whatever the panel's filter was changed to for one paste; the panel filter applies only to its own Paste button. Changing the preference resets only that filter, not the panel's count or mappings. |

## Rules

- Modified keypad keys (Ctrl, Alt, Meta, Shift) are not claimed. A keypad key is claimed only when it reports the digit 1-7 (or `.` or `,` for the dot): with NumLock off the keypad reports End, ArrowDown and so on, which keep navigating.
- A keypad key that would not change the rhythm makes no edit, so it adds no undo step and does not dirty the document.
- The entry duration changes only after the edit that sets it is accepted; a refused keypad duration or refused note leaves it alone.
- No keypad or auto-duration edit is made on an empty-bar placeholder or a tuplet beat, in a finalized document, or while controls are busy. The keypad key is still swallowed.
- Auto-duration is two edits (duration, then note), so each undoes separately. Both are checked together before either is sent, so a note that would be refused (such as an out-of-range fret) never leaves a changed rhythm behind. It applies only to a beat with no notes.
- When auto-duration does not apply to a rest that differs from the entry duration, a status line under the score says why, and the note is written with the beat's own duration: on an empty-bar placeholder or tuplet beat, or when the duration does not fit the bar (a half on a quarter rest in a full bar). The line shows only while that beat is selected.
- Keypad edits do not audition.

## Acceptance

- **Unit tests:** stored-value repair, keypad mapping and non-claimed keys, the duration edits and refusals, auto-duration conditions, the entry-duration rule, the panel, and the clipboard starting filter.
- **App tests:** keypad types a fret while off and sets duration, dot and undo when on; a finalized document is not edited; with both on, a note written on the next rest takes the keypad duration; the preferences are saved; a refused keypad duration or refused note does not become the entry duration; a note that would be refused never leaves a rhythm change behind; NumLock-off keys navigate; a no-op keypad key adds no edit.
- **Desktop** (`tests/desktop/parity-input-preferences.mjs`, real digit key events): keypad keys type frets and make no edit by default; the menu shows and saves each choice, which return after a reload and set the clipboard's diagram filter; NumLock-off keys navigate; a no-op keypad key makes no edit; auto-duration writes a duration edit then a note on a differing rest; keypad 2 and `.` are single undoable native edits with exact undo and redo; an exported GP reads back the dotted half and both written notes; turning the keypad off types frets again.

## Scope

- No new edit command. No per-document storage, and no native or file-format change.
- No plus/minus duration keys. No separate Special Paste command: the existing paste filters cover per-paste choice.
- Auto-duration does not insert beats or advance the cursor.
- The desktop run does not exercise a paste that carries diagrams (no fixture holds one); unit tests cover the filter value and the paste option.
- Plus/Minus Keys Behavior from the GP8 Interface page is not built; the row is partial for that reason.

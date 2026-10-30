# L08: score-input preferences

Date: 2026-10-24. Status: design. Row L08 ("Input preferences: auto-duration, numpad, preview, diagram paste") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's Preferences hold a few score-input choices. The GP8 Interface page documents the diagram-in-copy-paste and plus/minus-key options; it does not describe auto-duration, keypad or preview settings, so those three are product decisions made here. TabPlayer had one such choice (**Play notes while editing**, in the View menu) and no others. This slice adds the rest beside it and uses the existing `setDuration` and `pasteMusic` commands only, so the protocol does not change.

## Preferences

All four sit in one **Score input** group in the View menu (`InputPreferencesPanel`, `src/editor/input-preferences.tsx`). They are viewer settings, stored per window in `localStorage` under `tabplayer.input.preferences` (preview keeps its own older key). A missing or malformed stored field falls back to its default alone. They stay usable on a finalized document, since they never edit.

| Preference | Default | Behaviour |
|---|---|---|
| Play notes while editing (preview) | on | Unchanged: an entered note sounds when nothing is playing. |
| Keypad sets duration | off | With the score focused, keypad 1-7 set the selected beat to whole, half, quarter, eighth, sixteenth, thirty-second, sixty-fourth; keypad `.` toggles its dot. Each key is one `setDuration` edit that keeps the other half of the rhythm (digits keep the dots). When off, keypad keys behave as before. When on they never type a fret, even where no edit is possible. |
| Auto-duration | off | The *entry duration* is the last keypad choice, or else the rhythm of the last beat a note was written on. When on, **Enter** on a rest whose rhythm differs from it first sets that rhythm, then writes the note. |
| Paste includes chord diagrams | on | Sets the starting state of the **Chord diagrams** filter in the clipboard panel and of the plain Ctrl+V paste. The filter can still be changed per paste. |

## Rules

- Modified keypad keys (Ctrl, Alt, Meta, Shift) are not claimed.
- No keypad or auto-duration edit is made on an empty-bar placeholder or a tuplet beat, in a finalized document, or while controls are busy. The keypad key is still swallowed.
- Auto-duration is two edits (duration, then note), so each undoes separately. The note is written only if the duration edit was accepted; a refusal shows the usual alert. It applies only to a beat with no notes.
- Keypad edits do not audition.

## Acceptance

- **Unit tests:** stored-value repair, keypad mapping and non-claimed keys, the duration edits and refusals, auto-duration conditions, the entry-duration rule, the panel, and the clipboard starting filter.
- **App tests:** keypad types a fret while off and sets duration, dot and undo when on; a finalized document is not edited; with both on, a note written on the next rest takes the keypad duration; the preferences are saved.
- **Desktop** (`tests/desktop/parity-input-preferences.mjs`): the keypad makes no edit by default; the menu shows and saves each choice; keypad 2 and `.` are single undoable native edits with exact undo and redo; an exported GP reads back the dotted half; turning the keypad off ends the effect.

## Scope

- No new edit command. No per-document storage, and no native or file-format change.
- No plus/minus duration keys. No separate Special Paste command: the existing paste filters cover per-paste choice.
- Auto-duration does not insert beats or advance the cursor.
- The desktop run does not cover auto-duration or the diagram-paste effect; unit and App tests do.

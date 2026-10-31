# U05: author scale diagrams from scratch or a selection

Date: 2026-10-24. Status: design. Row U05 ("Scale diagram authoring from scratch/selection") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's Scale Diagram window (Note > Scale Diagram, Shift+S) opens blank on an empty beat or pre-filled from the selected notes. A diagram has a name, 3 to 10 strings, 4 to 24 frets, a starting fret, optional fret markers and a horizontal or vertical layout. Each mark has a symbol shape, colour and up to three characters of text with its own colour; text carries a note name or a finger. Clicking OK puts the diagram above the staff at the selected beat; it can be edited or deleted from the score. TabPlayer's Scale browser (`src/harmony/ScaleToolPanel.tsx`) only previews a scale and stores nothing. This slice adds the diagram as score data and the authoring window for it, as one new replayed edit.

## What GP and alphaTab can carry

- **alphaTab** (the renderer and the GP writer) has no scale-diagram model: no class, no render glyph, no exporter field. Chord diagrams are `model.Chord` objects (strings, first fret, barres, three show flags); they cannot hold a mark's shape, colour or text, or several marks on one string.
- **GP8's file format** is not documented for scale diagrams, and the manual page does not say how they are saved. TabPlayer has no GP8 sample containing one, so no GP8-compatible encoding can be written or verified here.
- **Decision:** TabPlayer keeps the diagram in its own staff property, `TabPlayerScaleDiagrams`, in the exported GPIF. TabPlayer reads it back, so a TabPlayer to GP to TabPlayer trip keeps every diagram and mark. A malformed item in the property (bad shape, missing beat or `Diagram`, bad attribute, failing validation) is skipped with a console warning and never blocks opening the file. This is not GP8's own encoding. GP8 is expected to ignore the unknown property; it will not draw the diagram, and whether it keeps the property when it re-saves is unverified. The user-facing limit is recorded in the validation report.

## Data model

`ScaleDiagram {name, strings 3–10, frets 4–24, firstFret ≥ 1, orientation horizontal|vertical, showFretMarkers, marks[]}` with `ScaleMark {string, fret, shape circle|square|diamond|triangle|cross, color #rrggbb, text ≤ 3 characters, textColor #rrggbb}`.

- `string` counts from 1 for the **lowest**-pitched string, as notes do; the highest string is `strings`. In the picture the highest string is the top row (horizontal) and the lowest is the left column (vertical). `fret` is 0 for an open string, or inside the window `firstFret … firstFret+frets-1`.
- At most one mark per string and fret; at most 64 characters of name; the window ends at or before fret 127.
- The same rules are checked in TypeScript (`validateScaleDiagram`) and Rust (`ScaleDiagram::validate`), which use character counts, not bytes. Names and mark text refuse characters an XML file cannot hold (control characters including newline, U+007F–U+009F, U+FFFE, U+FFFF, unpaired surrogates), so an export always reopens.
- The diagram is attached to a **written beat** of a non-drum staff. A beat's diagram and its chord diagram are independent.
- It lives in a side store keyed by the beat object. Positions are always found by walking the score's real arrays, never from the `.index` fields, which are stale while an edit rearranges a score. The store is copied with the other interchange sources (`copyGpInterchangeSource`) and, for `duplicateTrack`, onto the copy, so a diagram follows its beat through beat, measure and track insertion, deletion and moves, replay, detached clones, export selections and the GP export copy. It is not in the clipboard (see Scope).

## Edit command

`setScaleDiagram {target: BeatTarget, diagram: ScaleDiagram | null}` replaces the beat's diagram, or clears it with `null`. It is refused for an empty or missing beat and for a drum staff. It is one undoable native edit, validated in `parity-commands.ts` and Rust, listed in `tests/protocol.json` (count 75 to 76), and applied in `src/editor/advanced.ts`.

## Authoring window

The Scale browser gains a **Scale diagram** section when opened from the app (it still works as a plain browser without the edit hooks).

- **Start:** Blank diagram (strings = the staff's string count, up to 10); From selected notes (one mark per distinct string and fret of the selected stringed notes, labelled with the sounding note name, window fitted to the notes and at least 5 frets; refused above 24 frets or with no stringed notes); From scale above (every position of the browser's scale in frets 0–12, root marked in the root colour and labelled).
- **Edit the draft** with the name, strings, frets, starting fret, orientation and fret-marker controls, and a default shape, colour and text colour for new marks. Resizing drops marks that no longer fit.
- **Marks:** click a position to add a mark and select it; click a mark to select it; the selected mark's shape, colour, text (up to 3 characters) and text colour can be changed; double-click, Delete or Remove mark removes it; Reset marks clears all.
- **Apply diagram to beat** sends one `setScaleDiagram` (enabled when the draft differs from what is stored). **Delete diagram from beat** sends `null`. **Discard changes** returns to the stored diagram. Drafting changes nothing in the score.
- Number fields commit on blur or Enter, so typing "10" never passes through "1". The grid is one tab stop; arrow keys move along the picture; Enter or Space adds or selects; Delete removes. Apply is enabled only when the draft differs from the stored diagram, ignoring mark order.
- **Disabled:** while busy, with no written beat selected, or on a drum staff, with a one-line hint.
- Positions are SVG buttons with names such as "String 5, fret 3" or "String 9, open", plus "...: square mark "1"" when marked.

## Rendering

- `ScaleDiagramView` draws the diagram (strings, frets, nut or starting fret, fret markers, each mark's shape, colour and text), in both orientations. It is the editing surface in the Scale browser.
- **In the score:** `ScoreView` draws one compact chip (a button with the diagram's name) above the staff at the left edge of each diagram's beat, from `boundsLookup.findBeats`, and re-places it after every render, zoom or layout change. Hovering or focusing a chip opens the read-only `ScaleDiagramView` at 45% of its natural size below it, on top of its neighbours, so no mark is permanently hidden. Chips on one row are packed left to right with a 2px gap, so a later chip never covers an earlier one; a packed chip can sit slightly right of its beat. Chips are cleared when a render starts and hidden when the beat is not rendered. Each chip is 16px tall and sits in the 18px above its staff, clamped to the top edge.
- **Limits:** the diagram is a screen overlay only. PDF, PNG, SVG and print output (rendered by alphaTab) omit diagrams, and GP8 will not draw them (see "What GP and alphaTab can carry"). alphaTab reserves no space, so a chip can touch notation above a staff when the gap is under 18px. There is no virtualisation: every diagram of the shown tracks gets an element, which a score with very many diagrams will feel.

- The Scale browser shows the same view for the selected beat.

## Acceptance

- **Unit tests:** validation (each refusal, character counting); command envelope; set and clear; refusal on empty or drum beats; project replay with undo, restart and measure insertion; clones and export selections; selection and scale builders; mark and resize helpers; GP export write and read of every mark, special characters, repeat export byte-identical, third generation, and no property without diagrams. Rust: round trip of the fixture, valid and invalid diagrams, unknown fields and shapes.
- **Structural tests:** the diagram stays on its note after deleting an earlier beat, inserting a beat, removing an earlier measure, removing an earlier track, moving a track and duplicating a track, live and after replaying the saved project. A string-direction test uses notes that differ between strings. A malformed GP property is skipped with a warning. XML-invalid characters are refused on both sides.
- **Component tests:** author from scratch, remove marks, resize, from selection, from scale, stored diagram shown and deleted, disabled states, every shape and orientation.
- **Desktop (`tests/desktop/parity-scale-diagrams.mjs`, written, to be run by the controller):** in the Scale browser on the 9-string guitar's chord beat (bar 2, beat 2), draft and apply a marked and fingered diagram as one native edit with the exact command; the highest string is drawn above a lower one, in the dialog and in the score; undo and redo restore the project and the drawing; deleting the rest before the beat moves the diagram with it; the exported GP carries `TabPlayerScaleDiagrams` with both marks on the shifted beat and still loads; the app is restarted and opens that GP through its own path, restoring and drawing every mark; Delete clears it as one edit.

## Scope

- No diagram in PDF, PNG, SVG or print output, no GP8-native encoding, no audible scale playback (U06).
- No clipboard copy or paste of diagrams, no transposition, and no automatic follow of string-count changes.
- No MusicXML or ASCII export of diagrams.
- No drag-to-reposition of marks, and no custom shapes beyond the five above.

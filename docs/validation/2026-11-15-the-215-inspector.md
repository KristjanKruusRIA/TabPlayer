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

RELOCATION_TABLE

RESULTS

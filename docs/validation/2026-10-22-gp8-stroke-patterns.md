# GP8 parity T05: picking and strumming patterns (2026-10-22)

GP8 can apply ordered picking and gesture patterns to a selection. This slice adds pick stroke, brush and arpeggio patterns to the Music selection panel. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Music selection → Guitar and bass → Picking and strumming:**
  - "Pattern technique" chooses pick stroke, brush or arpeggio.
  - "Alternate picking" fills `D U` and "All downstrokes" fills `D`.
  - "Stroke pattern" takes 1 to 16 steps of `D` (down), `U` (up) or `-` (none). Words and commas are accepted too.
  - "Apply stroke pattern" applies it; "Clear strokes" applies a single `-` step.
  - An invalid pattern raises an alert and changes nothing.
- **Order:** the pattern repeats over each voice lane's struck beats in time order, continuing across measures. Each track, staff and voice lane starts at the first step.
- **Skipped beats:** rests, grace beats and beats holding only tied notes take no step. They lose the chosen technique, so clearing a pattern clears it everywhere in the selection.
- **Pick strokes and brushes are separate.** A brush or arpeggio pattern keeps existing pick strokes, and the reverse.
- **Audible spread:** a new brush defaults to a quarter of the beat, and a new arpeggio to the whole beat, divided across the struck strings (alphaTex's defaults). Flipping only the direction keeps a spread already set.
- **Refused selections:** a selection with notes on a drum or unstrung staff is refused as a whole, so a mixed guitar and drums selection changes nothing. The panel disables the action for such selections.
- **Saved form:** `setSelectionStrokes {selection, technique, pattern}`. The frontend and Rust both refuse an unknown technique or step, an empty pattern, more than 16 steps and extra fields. It is one undoable edit and replays on reopen.

## Evidence
- **Frontend:**
  - `stroke-patterns.test.ts`:
    - alternating strokes continue across measures;
    - rests are skipped without restarting the pattern;
    - note selections touch only their beats, and pitches and rhythm stay unchanged;
    - brushes and arpeggios get audible default spreads, and a direction flip keeps a set spread;
    - grace and tie-only beats take no step and are cleared, as are rests;
    - each voice lane and each track starts the pattern afresh;
    - a mixed guitar and drums selection is refused atomically;
    - invalid patterns and techniques are refused without changes;
    - the saved command envelope is validated.
  - `RangePanel.test.tsx`: the panel sends the parsed pattern, presets fill the field, and bad patterns raise an alert.
  - Protocol fixture: 73 wire examples.
  - RED log: `.analysis/parity/stroke-patterns-red.log`.
- **Rust:**
  - `edit_types.rs`: the command round-trips for every selection kind and requires every field; patterns of 1 and 16 steps are accepted for each technique; empty, 17-step, unknown-step, non-array and unknown-technique values are refused.
  - `tests/protocol.rs`: the shared wire examples are accepted.
- **Desktop:** `tests/desktop/parity-stroke-patterns.mjs` on a Windows desktop-test build:
  - Guitar9 track selection, alternate picking, then brush `D D U -`;
  - GP export shows every struck beat following each pattern, brushes with a nonzero spread, pick strokes kept and pitches unchanged;
  - the drums track disables the action;
  - undo clears the brushes and redo restores both edits, with playback ready again.
- **Verification:** full `vitest` (3315 tests; known load-sensitive files rerun alone), `tsc`, `cargo test` and `cargo fmt` pass.
- **Review:** an adversarial review found index-sensitive Rust fixtures, silent zero-length brushes, tie and grace beats consuming steps, a prototype-key parser lookup and strokes left on rests. All were fixed and covered by tests.

## Limits
- T05 stays partial: finger (p-i-m-a), golpe and slap/pop patterns are not available.
- No economy-picking or string-crossing rules; patterns are purely ordered.
- MusicXML export keeps pick strokes but not brushes or arpeggios.
- The spread duration cannot be edited from this panel.
- No original-GP8 comparison.

# GP8 parity E05 and W19: voice, track, transport and technique keys (2026-11-10)

This is the third score-entry slice (Linear THE-65), following [2026-11-06-gp8-score-entry.md](2026-11-06-gp8-score-entry.md) and [2026-11-07-gp8-score-entry-2.md](2026-11-07-gp8-score-entry-2.md). It addresses the remaining keyboard workflow and technique entry gaps under W19 and E05:
- voice selection;
- track navigation shortcuts;
- bar navigation, transport and "Go to bar" shortcuts;
- single-letter technique toggles on fretted and percussion notes.

The plan is documented in Linear THE-65. No edit command schemas, project file formats or history logs were broken.

## Behavior
- **Voice selection and creation:**
  - `Ctrl+1..4`, `Alt+1..4`, and `Meta+1..4` switch active voice (0..3).
  - If selecting the next uncreated voice on the measure (e.g. voice 2 when only voice 0 and 1 exist), it dynamically creates the voice via an undoable `addVoice` command and moves selection to beat 0 of the new voice.
  - **Withdrawn 2026-11-12:** the `Ctrl+M` multivoice toggle shipped in this slice only showed a notice; no edit read the mode. It was removed in the [review fixes](2026-11-12-merged-slices-review-fixes.md). Simultaneous multivoice editing stays open under S10.
- **Track navigation:**
  - `Ctrl+Up` / `Ctrl+Down` (and `Meta+Up/Down`) switch the active track up or down, clamping track index, staff, voice, and beat, and adjusting the string selection to fit the target track's tuning.
- **Bar jumps and transport shortcuts:**
  - `Ctrl+Left` / `Ctrl+Right` (and `Alt+Left/Right`) jump the cursor to beat 0 of the previous or next measure.
  - `Shift+Ctrl+Left` / `Shift+Ctrl+Right` extend or shrink the range selection across measure boundaries.
  - `Ctrl+Space` / `Meta+Space` seeks playback to the start of the current measure and begins playback.
  - `Ctrl+G` / `Meta+G` triggers the "Go to bar" dialog from anywhere in the score or app shell.
- **Technique toggle keys:**
  - Single-letter shortcuts toggle techniques on the note under the cursor (or active string):
    - `H`: Hammer-on / pull-off link (`setNoteLink` / `setNoteLinkByIndex` with `hammerPull`)
    - `S`: Slide (`setNoteTechniques` patch `slideOut: 1` or cleared)
    - `V`: Vibrato (`setNoteTechniques` patch `vibrato: 1` or cleared)
    - `P`: Palm mute (`setNoteTechniques` patch `palmMute: true` or cleared)
    - `I`: Let ring (`setNoteTechniques` patch `letRing: true` or cleared)
    - `X`: Dead note (`setNoteTechniques` patch `dead: true` or cleared)
  - Works consistently on fretted strings and indexed percussion staves.
  - During pitch entry mode, pitch letters `A`–`G` remain reserved for pitch insertion; technique keys do not conflict.
- **In-app help & Localization:**
  - All new shortcuts are listed in the score-focused section of the keyboard help modal.
  - Full translations provided for English (`en`), German (`de`), and Estonian (`et`).

## Evidence
- **Unit & Integration Tests:**
  - `src/editor/gp8-keys.test.ts`: 9 tests covering key detection, voice additions, track navigation, bar jumps, and technique toggle planning (`planTechniqueToggle`).
  - `src/App.test.tsx`: 6 new integration tests in `GP8 voice, track, transport and technique keys` verifying voice switching and creation, multivoice toggle notice, track navigation, measure jumping, Go to bar dialog opening, and all 6 technique toggles.
  - Full `App.test.tsx` suite (231 tests) passing.
  - All 83 test files in `src/editor` (1106 tests) passing.
  - `npm run typecheck` clean (0 errors).

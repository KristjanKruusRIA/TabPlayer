# THE-62: Finish MusicXML export (F13)

2026-11-09. Branch `agy/the-62-musicxml-export` from `develop` (`f24e72b`).

## Context & Objectives

The MusicXML exporter (`src/export/musicxml.ts`) provides an owned MusicXML 4.0 `score-partwise` writer. Any feature that cannot be expressed faithfully fails closed (`unsupported(...)`) rather than dropping or corrupting data.
The backlog ticket THE-62 asked to treat the remaining refusals as the list of work, widening support where MusicXML and the importer faithfully express the notation, while continuing to refuse anything that cannot be written or round-tripped correctly:
- Multi-staff tracks (e.g. keyboard / piano grand staff, organ).
- Assessment of other refusal families: percussion staves, stringed staves shown only as standard notation, sounding transposition, and high MIDI channels.

## Analysis of Refusal Families

1. **Multi-staff tracks (`track.staves.length > 1`)** (Supported):
   - In standard notation and alphaTab, multi-staff instruments (such as grand-staff pianos with treble and bass staves, or organs with multiple manuals and pedal staves) group all staves under a single `<part>`.
   - In MusicXML:
     - The part declares `<staves>N</staves>` in `<attributes>`.
     - Each staff receives its numbered clef: `<clef number="1">`, `<clef number="2">`, etc.
     - Notes and rests carry `<staff>S</staff>` and `<voice>V</voice>`.
     - Between each voice and staff entry in a measure, `<backup><duration>...</duration></backup>` returns the cursor to the beginning of the measure.
     - Inactive staves receive explicit `<rest measure="yes"/>` entries.
   - alphaTab's MusicXML importer natively recognizes `<staves>`, `<clef number="...">`, and `<staff>` elements and reconstructs multi-staff tracks cleanly (`track.staves.length === N`).
   - Round-trip fidelity is 100% verified across 2-staff piano and 3-staff organ fixtures.

2. **Percussion staves (`staff.isPercussion`)** (Kept refused):
   - While MusicXML can write unpitched notes and instrument names, alphaTab's MusicXML importer dynamically instantiates ad-hoc articulation records with blank staff lines and notehead symbols. This corrupts standard General MIDI drum maps, notehead displays (X noteheads for hi-hats/cymbals, triangles, rim shots), and vertical staff placement on import.
   - Per the requirement ("keep refusing anything that cannot be written correctly"), percussion remains safely refused.

3. **Stringed staff shown only as standard notation (`stringed && !tab && !both`)** (Kept refused):
   - If MusicXML `<staff-details>` includes `<staff-tuning>`, alphaTab's importer forces `showTablature = true` and `showStandardNotation = false`, converting the score into tablature.
   - If `<staff-details>` omits `<staff-tuning>`, alphaTab initializes `staff.stringTuning.tunings` to empty, and the technical `<string>` parser calculates negative string numbers (`0 - string + 1`).
   - Therefore, stringed tracks displayed only as standard notation cannot round-trip faithfully in alphaTab's importer and remain safely refused.

4. **Sounding transposition (`staff.transpositionPitch !== 0`)** (Kept refused):
   - MusicXML's `<transpose>` directive is imported by alphaTab exclusively into `staff.displayTranspositionPitch`, never into `staff.transpositionPitch`. Round-tripping sounding transposition via MusicXML would alter playback pitch semantics. Kept safely refused.

5. **MIDI channels above 16** (Kept refused):
   - Standard MusicXML 1.0–4.0 `<midi-channel>` uses 1–16. Higher channels cannot be represented without data loss.

## Implementation Details

1. `src/export/musicxml.ts`:
   - Updated `writePart` to accept multi-staff tracks (`track.staves.length >= 1`).
   - Added validation for all staves: `(json.staves as Json[]).forEach(s => check('staff', s));`.
   - Preserved failure for stringed multi-staff tracks (`if (track.staves.length > 1 && track.staves.some(s => s.stringTuning.tunings.length > 0)) unsupported('more than one staff per track');`).
   - Generalised layouts to support `both` (single staff notation + TAB), single staff, and multi-staff (`layouts = track.staves.map((_, s) => ({ staffIndex: s, staff: String(s + 1), voices: 0, technical: true }))`).
   - Emitted `<staves>{layouts.length}</staves>` when `layouts.length > 1`.
   - Emitted numbered `<clef number="S">` for each staff in initial and clef-changing measures.
   - Supported per-staff transposition when multi-staff instruments require distinct display transposition.
   - Emitted notes with `<staff>S</staff>` and `<voice>V</voice>`, separated by `<backup><duration>{total}</duration></backup>` across all voices and staves in each measure.
   - Emitted measure rests with `<rest measure="yes"/>` for resting staves.

2. `src/export/musicxml.test.ts`:
   - Added unit test `writes a grand-staff piano track with two staves and round-trips it`: verifies `<staves>2</staves>`, numbered clefs (`1:G`, `2:F`), `<staff>1</staff>` and `<staff>2</staff>`, backup durations, and exact round-trip equality via `content(back)`.
   - Added unit test `writes a 3-staff organ track and round-trips it`: verifies 3 staves (manual 1, manual 2, pedal), backup elements, and 3-staff model round-trip.
   - Added unit test `writes measure rests on inactive staves of a multi-staff track`: verifies explicit `<rest measure="yes"/>` on inactive staves with appropriate staff tags.
   - Preserved `it.each` fail-closed tests for stringed second staff, percussion staff, sounding transposition, etc.

## Verification

- `src/export/musicxml.test.ts` (159 tests): All passed.
- `npx tsc --noEmit`: 0 errors.
- Full Vitest suite: 361 test files passed, 6092 tests passed, 0 failures.

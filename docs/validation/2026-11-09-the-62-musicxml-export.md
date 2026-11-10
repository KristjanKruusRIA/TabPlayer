# THE-62: MusicXML export, multi-staff tracks, ghost notes, palm mutes, alternate repeat endings, capo, measure directions, triplet feel, subtitle, arranger, beat text, and crescendo/decrescendo hairpins (F13, partial)

2026-11-09 – 2026-11-10. Branch `agy/the-62-musicxml-export` from `develop` (`f24e72b`).

## Context & Objectives

The MusicXML exporter (`src/export/musicxml.ts`) provides an owned MusicXML 4.0 `score-partwise` writer. Any feature that cannot be expressed faithfully fails closed (`unsupported(...)`) rather than dropping or corrupting data.
**Scope: multi-staff tracks, ghost notes, palm mutes, alternate repeat endings, staff capo, measure directions, triplet feel, subtitle, arranger metadata, beat text, and crescendo/decrescendo hairpins have been lifted.** THE-62 is not finished. These refusals still apply:
- percussion staves
- a stringed staff shown only as standard notation
- more than one staff on a stringed track
- sounding transposition
- MIDI channels above 16
- different key signatures on the staves of one track
- features outside the `written` allowlist in `musicxml.ts` (sections, dead notes, let ring, harmonics, fingering, chords, double bars, album, tab, instructions, notices, beat effects like slap/pop/fade)

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
   - Round-trip is tested on a 2-staff piano and a 3-staff organ score and compared with `content()`. This is not a claim of full fidelity.
   - An empty staff bar is written as a whole-measure rest (`<rest measure="yes"/>`) and reads back as one whole-note rest beat on that staff, not as an empty voice. The re-imported content therefore differs from the source in that bar.
   - A bar whose staves disagree on key signature is refused ("different key signatures on the staves of one track"). One unnumbered `<key>` is applied to every staff on import, so the other staves' keys would be lost silently.

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

6. **Ghost notes (`note.isGhost`) and Palm mutes (`note.isPalmMute`)** (Supported):
   - In MusicXML 4.0, ghost notes are expressed via `<notehead parentheses="yes">normal</notehead>`, placed in DTD sequence before `<staff>` and `<notations>`.
   - Palm mutes are expressed via `<play><mute>palm</mute></play>`, placed in DTD sequence after `<notations>` and `<lyric>`.
   - alphaTab's `MusicXmlImporter` parses both directly: `element.getAttribute("parentheses") === "yes"` sets `note.isGhost = true`, and `<mute>palm</mute>` sets `note.isPalmMute = true`.
   - On notation + TAB guitar parts (`both`), both staves receive the notehead and play elements, allowing `applyMusicXmlAlternateStaves` to match and fold them back into a single staff without loss.

7. **Alternate repeat endings (`master.alternateEndings`)** (Supported):
   - In MusicXML 4.0, alternate endings are expressed via `<ending number="..." type="start|stop">`, placed within `<barline>` elements in DTD order (`bar-style?`, `ending?`, `repeat?`).
   - alphaTab stores alternate endings as an 8-bit mask on `MasterBar.alternateEndings` where bit $i$ represents ending $i+1$.
   - The exporter converts masks to comma-separated number strings (e.g. mask `3` becomes `"1, 2"`, with text `"1, 2."`).
   - For `<barline location="left">`: emits `<ending ... type="start">` on the measure where an ending begins.
   - For `<barline location="right">`: emits `<ending ... type="stop"/>` on the measure where the ending finishes (either due to `repeatCount > 0` or moving to a different ending/unmarked measure).
   - Multi-measure endings span across measures without emitting duplicate start/stop tags; alphaTab's importer maintains ending state across measures via `_nextMasterBarRepeatEnding`.
   - Out-of-range masks (>255, <0, or non-integer) fail closed with `unsupported('this alternate ending')`.

8. **Capo (`staff.capo`)** (Supported):
   - In MusicXML 4.0, a capo is expressed via `<capo>{fret}</capo>` inside `<staff-details>`, placed in DTD sequence following `staff-tuning*`.
   - alphaTab's `MusicXmlImporter` parses `<capo>` inside `<staff-details>` natively into `staff.capo`.
   - For dual notation + TAB staves (`both`), `<capo>` is placed on staff 2's `<staff-details number="2">` and staff 1's `<staff-details number="1">`. When re-imported, `applyMusicXmlAlternateStaves` preserves `capo: tab.capo` when folding into a single staff.
   - Sounding pitch is computed by alphaTab incorporating `staff.capo` into `note.stringTuning`, ensuring written MusicXML `<pitch>` reflects true sounding pitches and tab frets remain preserved.
   - Capo on non-stringed staves or invalid values (<0, >24, or non-integer) fails closed with `unsupported(...)`.

9. **Measure directions (`master.directions`)** (Supported):
   - In MusicXML, musical navigation directions (Segno, Coda, Fine, Da Capo, Dal Segno, To Coda) are represented using `<direction>` and `<sound>` elements.
   - In alphaTab's `MusicXmlImporter`:
     - Visual navigation signs `<segno/>` and `<coda/>` are parsed inside `<direction><direction-type>`, creating `TargetSegno` (1) and `TargetCoda` (3) directions on the `MasterBar`.
     - Navigation jumps and targets (`<sound segno="segno"/>`, `<sound coda="coda"/>`, `<sound fine="fine"/>`, `<sound dacapo="dacapo"/>`, `<sound dalsegno="segno"/>`, `<sound tocoda="coda"/>`) are parsed as direct children of `<measure>` without polluting `beat.text`.
     - The supported subset corresponds to alphaTab's direction enum: `TargetFine` (0), `TargetSegno` (1), `TargetCoda` (3), `JumpDaCapo` (5), `JumpDalSegno` (9), and `JumpDaCoda` (17).
     - Any unsupported direction value (e.g. `TargetSegnoSegno`, `TargetDoubleCoda`, `JumpDaCapoAlFine`, etc.) fails closed with `unsupported('this direction')`.
   - Directions are emitted once on the primary part (`if (first)`), placing `<direction>` and `<sound>` tags in DTD-valid order at the beginning of the measure before notes.

10. **Triplet Feel (`master.tripletFeel`)** (Supported):
   - MusicXML expresses swing and triplet feels using `<sound><swing>...</swing></sound>` inside `<measure>`.
   - In alphaTab's `MusicXmlImporter`:
     - `<swing><straight/></swing>` sets `masterBar.tripletFeel = TripletFeel.NoTripletFeel` (0).
     - `<swing><first>2</first><second>1</second><swing-type>eighth</swing-type></swing>` sets `TripletFeel.Triplet8th` (2).
     - `<swing><first>2</first><second>1</second><swing-type>16th</swing-type></swing>` sets `TripletFeel.Triplet16th` (1).
     - `<swing><first>3</first><second>1</second><swing-type>eighth</swing-type></swing>` sets `TripletFeel.Dotted8th` (4).
     - `<swing><first>3</first><second>1</second><swing-type>16th</swing-type></swing>` sets `TripletFeel.Dotted16th` (3).
     - `<swing><first>1</first><second>3</second><swing-type>eighth</swing-type></swing>` sets `TripletFeel.Scottish8th` (6).
     - `<swing><first>1</first><second>3</second><swing-type>16th</swing-type></swing>` sets `TripletFeel.Scottish16th` (5).
     - alphaTab inherits `tripletFeel` across measures until an explicit `<swing>` (or `<straight/>`) is encountered (`newMasterBar.tripletFeel = newMasterBar.previousMasterBar.tripletFeel;`).
   - The exporter emits `<sound><swing>...</swing></sound>` whenever `master.tripletFeel` changes from the previous master bar (or on measure 1 if non-zero), emitting on the primary part (`if (first)`).
   - Invalid values (<0, >6, or non-integer) fail closed with `unsupported('this triplet feel')`.

11. **Score Subtitle and Arranger / Music Metadata (`score.subTitle`, `score.music`)** (Supported):
   - In MusicXML, arranger/music credits are placed inside `<identification>` as `<creator type="arranger">...</creator>`, which alphaTab's `MusicXmlImporter` parses natively into `score.music`.
   - Subtitle metadata is placed in `<credit page="1"><credit-type>subtitle</credit-type><credit-words>...</credit-words></credit>`, positioned immediately following `<identification>` and preceding `<part-list>` per MusicXML 4.0 DTD sequence rules. alphaTab's `MusicXmlImporter` parses this credit element into `score.subTitle`.
   - Both metadata fields are escaped via `escape()`, preserving control character rejection.

12. **Beat Text (`beat.text`)** (Supported):
   - In MusicXML, words / annotations associated with a beat are expressed using `<direction placement="above"><direction-type><words>{text}</words></direction-type>{staff}</direction>`.
   - In alphaTab's `MusicXmlImporter`:
     - `<words>` elements encountered in measure content store `this._nextBeatText = previousWords`.
     - When the subsequent beat (note, rest, or measure rest) is created, alphaTab assigns `beat.text = this._nextBeatText`.
     - Dual staves (`both`): `<direction>` is emitted on staff 1 (`notes[0]`). In `applyMusicXmlAlternateStaves`, `text` is recognized as a notation-only field (`notationOnly = ['text', 'chordid', 'lyrics']`) and preserved when folding notation and TAB staves into a single staff.
     - Multi-staff tracks (e.g. grand-staff piano): `<direction>` carries `<staff>1</staff>` or `<staff>2</staff>`, preserving beat text on the appropriate staff.
   - Text is escaped via `escape()`, preserving XML entity escaping and control character rejection.

13. **Crescendo and Decrescendo hairpins (`beat.crescendo`)** (Supported):
   - In MusicXML 4.0, hairpin wedges are expressed via `<direction placement="below"><direction-type><wedge type="crescendo|diminuendo|stop"/></direction-type>{staff}</direction>`.
   - In alphaTab's `MusicXmlImporter`:
     - `<wedge type="crescendo"/>` sets `this._nextBeatCrescendo = CrescendoType.Crescendo` (1).
     - `<wedge type="diminuendo"/>` sets `this._nextBeatCrescendo = CrescendoType.Decrescendo` (2).
     - `<wedge type="stop"/>` sets `this._nextBeatCrescendo = null`.
     - When each beat is created: `if (crescendo !== null) newBeat.crescendo = crescendo;`.
     - Hairpin state persists across measures until explicitly stopped.
     - Notation + TAB dual staves (`both`): hairpins are emitted only on staff 1 (`notes[0]`), never on staff 2. `applyMusicXmlAlternateStaves` retains staff 1's crescendo (included in `ignoredBeat`) when folding into 1 staff.
     - In alphaTab, `_nextBeatCrescendo` is global across staves in the importer; hairpins on multi-staff tracks cannot be isolated cleanly to single staves and fail closed (`crescendo on a multi-staff track`).
     - Hairpins outside voice 0 fail closed (`crescendo outside the first voice`).
     - Out-of-range or non-integer crescendo values fail closed (`this crescendo`).

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
   - Added `isghost` and `ispalmmute` to `written.note` allowlist.
   - Added `noteheadOf(note)` emitting `<notehead parentheses="yes">normal</notehead>` when `note.isGhost` is true.
   - Added `playOf(note)` emitting `<play><mute>palm</mute></play>` when `note.isPalmMute` is true.
   - Implemented `placeNoteAttributes(timing, accidental, notehead)` to ensure strict DTD element ordering (`... dot, accidental, time-modification, notehead, staff`).
   - Added `alternateendings` to `written.master` allowlist.
   - Added `endingNumbers(flags)` helper mapping bitmasks to numbers array, failing closed on invalid flags.
   - Updated measure loop in `writePart` to emit `<ending ... type="start">` on left barline and `<ending ... type="stop"/>` on right barline according to measure boundaries and repeat counts.
   - Added `capo` to `written.staff` allowlist.
   - Added validation failing closed on capo on non-stringed tracks or invalid capo fret values.
   - Emitted `<capo>` inside `<staff-details>` for stringed tracks and notation + TAB layouts.
   - Added `directions` to `written.master` allowlist.
   - Implemented `directionsOf(master)` helper mapping supported directions (`TargetSegno`, `TargetCoda`, `TargetFine`, `JumpDaCapo`, `JumpDalSegno`, `JumpDaCoda`) to MusicXML `<direction>` and `<sound>` elements, failing closed on unhandled directions.
   - Emitted direction elements on the primary part at measure start.
   - Added `tripletfeel` to `written.master` allowlist.
   - Implemented `swingOf(feel, prevFeel)` helper mapping all `model.TripletFeel` enums to standard MusicXML `<sound><swing>...</swing></sound>` elements.
   - Added validation failing closed on invalid triplet feel values.
   - Emitted swing elements on the primary part when triplet feel changes.
   - Added `music` and `subtitle` to `written.score` allowlist.
   - Emitted `<creator type="arranger">` in `<identification>` when `score.music` is set.
   - Emitted `<credit page="1"><credit-type>subtitle</credit-type><credit-words>...</credit-words></credit>` when `score.subTitle` is set.
   - Added `text` to `written.beat` allowlist.
   - Emitted `<direction placement="above"><direction-type><words>{text}</words></direction-type>{staff}</direction>` before each beat carrying `beat.text`.
   - Added `crescendo` to `written.beat` allowlist.
   - Implemented `wedgeOf(kind, current, staff)` managing hairpin transitions and `<wedge type="crescendo|diminuendo|stop"/>` emission in placement="below" direction elements.
   - Tracked running crescendo state across bars and measures, stopping unclosed hairpins at track end.
   - Refused crescendo on multi-staff tracks and outside voice 0.

2. `src/export/musicxml.test.ts`:
   - Added unit test `writes a grand-staff piano track with two staves and round-trips it`: verifies `<staves>2</staves>`, numbered clefs (`1:G`, `2:F`), `<staff>1</staff>` and `<staff>2</staff>`, backup durations, and exact round-trip equality via `content(back)`.
   - Added unit test `writes a 3-staff organ track and round-trips it`: verifies 3 staves (manual 1, manual 2, pedal), backup elements, and 3-staff model round-trip.
   - Added unit test `writes measure rests on inactive staves of a multi-staff track`: verifies explicit `<rest measure="yes"/>` on inactive staves with appropriate staff tags.
   - Added unit test `writes ghost notes and palm mutes and reads them back`: asserts DOM structure (`<notehead parentheses="yes">normal</notehead>`, `<play><mute>palm</mute></play>`) and exact round-trip for ghost notes, palm mute notes, combined notes, and untouched notes.
   - Added unit test `round-trips ghost notes and palm mutes on a notation + TAB guitar`: verifies `<notehead>` and `<play>` elements across both staves and verifies folding into one staff.
   - Added unit test `writes alternate repeat endings and round-trips them`: verifies 1st and 2nd endings, DOM barlines and ending tags, and exact model round-trip.
   - Added unit test `writes a multi-measure alternate ending and round-trips it`: verifies multi-measure 1st ending spanning 2 bars with left start on measure 1 and right stop on measure 2.
   - Added unit test `writes multi-number alternate endings (e.g. 1, 2) and round-trips them`: verifies comma-separated ending numbers (`number="1, 2"`).
   - Added unit test `keeps alternate repeat endings on a notation + TAB guitar`: verifies alternate endings survive round-trip on dual notation + TAB staves.
   - Added unit test `writes a capo on a TAB guitar and round-trips it`: verifies `<staff-details><capo>3</capo></staff-details>` and preserves note frets, strings, and sounding realValues.
   - Added unit test `writes a capo on a notation + TAB guitar and round-trips it`: verifies dual staves preserve capo and fold into a single staff.
   - Replaced `fails closed for a note effect` expectation from `/note isghost/` to `/note isdead/`.
   - Updated `fails closed for an invalid alternate ending` to test flags out of range (`alternateEndings = 256`).
   - Added `fails closed for a capo on a non-stringed staff` and `fails closed for an invalid capo`.
   - Added unit test `writes measure directions (segno, coda, fine, da capo, dal segno, to coda) and round-trips them`: asserts DOM `<direction><direction-type><segno/></direction-type></direction>`, `<sound segno="segno"/>`, `<sound coda="coda"/>`, `<sound fine="fine"/>`, `<sound dacapo="dacapo"/>`, `<sound dalsegno="segno"/>`, `<sound tocoda="coda"/>`, and round-trip preservation of all directions on `MasterBar.directions`.
   - Added unit test `fails closed for an unhandled measure direction`.
   - Added unit test `writes triplet feel changes and round-trips them`: tests all 7 triplet feel values (Triplet8th, Triplet16th, Dotted8th, Dotted16th, Scottish8th, Scottish16th, NoTripletFeel) asserting DOM `<sound><swing>...</swing></sound>` structure and round-trip equality.
   - Added unit test `writes triplet feel only on the first part of a multi-track score`.
   - Added unit test `fails closed for an invalid triplet feel`.
   - Added unit test `writes subtitle and music (arranger) metadata and round-trips them`: asserts DOM `<credit>` and `<creator type="arranger">` elements and round-trip preservation on `score.subTitle` and `score.music`.
   - Added unit tests `writes beat text and reads it back`, `keeps beat text on a notation + TAB guitar`, and `writes beat text on multi-staff tracks`.
   - Added unit tests `writes crescendo and decrescendo hairpins and reads them back`, `keeps crescendo hairpins on a notation + TAB guitar`, `refuses crescendo outside the first voice`, `refuses crescendo on a multi-staff track`, and `fails closed for an invalid crescendo`.
   - Updated `fails closed for a beat effect` to assert unwritten `/beat slap/`.

3. `src/interchange/field-preservation.test.ts`:
   - Added `'musicxml'` to the preserved `formats` list for `Note.isGhost`, `Note.isPalmMute`, `MasterBar.alternateEndings`, `Staff.capo`, `MasterBar.directions`, `MasterBar.tripletFeel`, `Score.subTitle`, `Score.music`, `Beat.text`, and `Beat.crescendo`.

## Verification

- `src/export/musicxml.test.ts` (185 tests): all passed.
- `src/interchange/field-preservation.test.ts` (191 tests): all passed.
- `src/export/` (22 test files, 562 tests): all passed.
- `npm run typecheck` (`tsc --noEmit`): 0 errors.

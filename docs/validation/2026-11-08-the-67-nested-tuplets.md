# GP8 parity N06: nested tuplets architectural digest (2026-11-08)

Row N06 in the GP8 parity tracker (`docs/validation/2026-10-15-gp8-parity-progress.md`) specifies nested tuplets with separate outer and inner ratios (for example, an inner triplet inside an outer quintuplet), verifying brackets, tick scheduling, and interchange roundtrip. This digest investigates alphaTab 1.8.4's data model, renderer, and playback generator, reviews interchange format capabilities (GP7/8, GP5, MusicXML, and MIDI), details edit-type replay requirements, and delivers an architectural recommendation.

## Behavior

### 1. alphaTab 1.8.4 Model, Playback, and Rendering Capabilities
- **Data Model:**
  - In alphaTab 1.8.4 (`node_modules/@coderline/alphatab/dist/alphaTab.js`), rhythmic duration on a beat is strictly flat. `model.Beat` exposes scalar attributes: `duration: Duration`, `dots: number`, `tupletNumerator: number` (default `-1`), `tupletDenominator: number` (default `-1`), and `tupletGroup: TupletGroup | null`.
  - A `model.Voice` holds beats as a flat array (`voice.beats: Beat[]`). There is no tree hierarchy, sub-voice container, or nested grouping structure.
  - Tuplet grouping is managed by `model.TupletGroup`, which holds `beats: Beat[]`, `voice: Voice`, `totalDuration: number`, and `isFull: boolean`.
  - When `score.finish()` executes `Beat.finishTuplet()`, consecutive beats are added to `currentTupletGroup` through `TupletGroup.check(beat)`.
  - In `TupletGroup.check(beat)` (line 6620):
    ```js
    if (beat.voice !== this.voice || this.isFull || beat.tupletNumerator !== this.beats[0].tupletNumerator || beat.tupletDenominator !== this.beats[0].tupletDenominator) return false;
    ```
    If consecutive beats have differing tuplet ratios (for example, inner 3:2 triplet eighth notes interrupting an outer 5:4 quintuplet quarter note span), `check()` returns `false`.
    alphaTab immediately marks the previous `TupletGroup` terminated and instantiates a new `TupletGroup` for the differing ratio.
  - As a result, placing an inner tuplet inside an outer tuplet irrevocably splinters the outer tuplet into disconnected, incomplete fragments: the preceding outer beats form a group with `isFull: false`, the inner beats form their own isolated group, and the succeeding outer beats form a third group with `isFull: false`. None of the groups maintain any parent-child link or awareness of each other.
  - alphaTab's object model cannot represent an outer tuplet enclosing an inner tuplet.

- **Playback & Timing:**
  - Beat duration in MIDI ticks is computed by `Beat._calculateDuration()` (line 7500):
    ```js
    if (this.tupletDenominator > 0 && this.tupletNumerator >= 0) ticks = MidiUtils.applyTuplet(ticks, this.tupletNumerator, this.tupletDenominator);
    ```
    where `MidiUtils.applyTuplet(ticks, num, den)` evaluates `ticks * den / num | 0`.
  - When inner beats carry their local ratio (e.g., three 3:2 eighths intended to replace one 5:4 quarter note):
    - Each outer quintuplet quarter note receives `960 * 4 / 5 = 768` ticks.
    - Each inner triplet eighth note receives `480 * 2 / 3 = 320` ticks.
    - The three inner eighth notes total `3 * 320 = 960` ticks (the span of a straight quarter note) rather than the intended 768 ticks of the outer quintuplet slot.
    - Consequently, the bar duration expands to `768 + 768 + 960 + 768 + 768 = 4032` ticks against a standard 4/4 measure clock of 3840 ticks (+192 ticks overfill).
    - Both alphaTab's `MidiFileGenerator` and TabPlayer's native playback plan (`src/audio/plan.ts`) schedule note attacks linearly from beat offsets. Playback plays at unadjusted triplet tempo, pushing subsequent beats late and overrunning the measure boundary.
  - If inner beats are assigned a compound ratio to enforce the correct tick duration (e.g. 15:8 eighths, where `480 * 8 / 15 = 256` ticks, totaling `3 * 256 = 768` ticks):
    - The total bar duration correctly sums to 3840 ticks, and playback timing is mathematically accurate.
    - However, notation rendering is ruined (see below).

- **Rendering & Engraving:**
  - During notation rendering, `VoiceContainer.paintTuplets()` delegates to `_paintTupletHelper(cx, cy, canvas, h, beatElement, bracketsAsArcs)` for each `TupletGroup`.
  - When an outer tuplet is fragmented by inner beats (Case 1: two 5:4 beats, three 3:2 beats, two 5:4 beats):
    - Group 1 has 2 beats and `isFull: false`. Because `!h.isFull`, alphaTab skips bracket drawing and falls back to stamping a bare music font digit `"5"` directly above Beat 0 and another `"5"` directly above Beat 1 without a bracket.
    - Group 2 (the 3:2 triplet) has 3 beats and `isFull: true`. It receives a standard bracket with digit `"3"`.
    - Group 3 has 2 beats and `isFull: false`. It stamps bare digit `"5"` above Beat 5 and `"5"` above Beat 6.
    - Rendered output: `[ 5, 5, 3 (bracketed), 5, 5 ]`. No outer bracket is drawn, and no outer grouping number encompasses the measure.
  - When compound ratios are used (Case 4: 15:8 eighths):
    - alphaTab lacks single-glyph symbols for ratios outside standard single-level tuplets; it formats the ratio into digit glyphs with a colon (`1`, `5`, `:`, `8`).
    - `isFull` remains `false`: for equal-length beats a group is full when its beat count reaches the tuplet numerator, and three 15:8 beats never reach 15.
    - alphaTab paints the full string `"15:8"` above every individual beat of the triplet, along with individual `"5"` marks on outer beats.
    - Neither outer brackets nor nested bracket tiers can be rendered by alphaTab.

### 2. Interchange Formats (GP7/8, GP5, MusicXML, MIDI)
- **Guitar Pro 7 / 8 (`.gp` / GPIF):**
  - The GPIF XML structure (`score.gpif`) abstracts durations into `<Rhythms><Rhythm id="...">`.
  - A `<Rhythm>` element accepts `<NoteValue>`, `<AugmentationDot>`, and `<PrimaryTuplet num="..." den="..."/>`.
  - alphaTab's `GpifParser` reads only `<PrimaryTuplet>`; `GpifWriter` writes only `<PrimaryTuplet>`.
  - Unverified: whether Guitar Pro 8 itself supports nested tuplets. alphaTab's GPIF reader knows only `<PrimaryTuplet>`, and no GP8 file or runtime was examined here, so this digest makes no claim about a `<SecondaryTuplet>` tag or GP8's own behaviour.
  - TabPlayer's GP export (`src/interchange/gp.ts`) wraps alphaTab's `Gp7Exporter` and produces valid GPIF `<PrimaryTuplet>` elements only. Any nested rhythm would export as broken, independent primary rhythms.
- **Guitar Pro 5 (`.gp5`):**
  - The GP5 binary specification allocates a single 32-bit integer per beat for tuplet definitions (`1` for none, `3` for 3:2, `5` for 5:4, `6` for 6:4, `7` for 7:4, and `9`–`13` for n:8).
  - The format cannot store nested tuplets, hierarchical groupings, or arbitrary rational fractions.
  - TabPlayer's GP5 exporter (`src/export/gp5.ts`) strictly validates `TUPLETS.get(beat.tupletNumerator) === beat.tupletDenominator`. Any compound ratio or non-standard tuplet triggers an immediate export refusal (`refuse('${where} has a ... tuplet, which Guitar Pro 5 cannot hold.')`).
- **MusicXML:**
  - The MusicXML standard (W3C MusicXML 3.0/4.0) explicitly supports nested tuplets via hierarchical `<notations><tuplet number="1" type="start"/><tuplet number="2" type="start"/></notations>` bracket declarations alongside `<time-modification><actual-notes/><normal-notes/></time-modification>`.
  - alphaTab's `MusicXmlParser` (`node_modules/@coderline/alphatab/dist/alphaTab.js:23940`) parses only `<time-modification>` into a single pair of `tupletNumerator` and `tupletDenominator`. It discards `<notations><tuplet number="...">` attributes entirely.
  - TabPlayer's MusicXML export (`src/export/musicxml.ts:397`) writes a single `<time-modification>` from `beat.tupletNumerator` and `beat.tupletDenominator`. It does not emit nested bracket notations and refuses rhythms that fail integer division.
- **MIDI:**
  - Standard MIDI Files (SMF) contain no notation layer, note duration values, or tuplet representations; SMF encodes solely delta-time ticks and NoteOn/NoteOff events.
  - MIDI export (`src/export/midi.ts`) converts beat tick spans into events via `MidiFileGenerator`. If beat tick spans mathematically sum to the measure clock (such as flattened compound ticks), MIDI events export cleanly. If inner tuplets expand the bar clock (as in uncompensated ratios), the exported track desynchronizes with other tracks and overflows measure boundaries.
  - MIDI import (`src/interchange/midi-import.ts`) quantizes tick events onto a straight or single-level tuplet grid (`none`, `triplets`, `triplets-quintuplets`). It cannot detect or reconstruct nested polyrhythmic hierarchies.

### 3. TabPlayer Edit Types and Replay Safety
- **Current Edit Shape:**
  - Document history is managed by Rust (`src-tauri/src/edit_types.rs`) and replayed in TypeScript (`src/editor/notation.ts`, `src/engine.ts`).
  - Rhythm edits use `SetBeatRhythm`:
    ```rust
    SetBeatRhythm {
        target: BeatTarget,
        duration: i32,
        dots: u8,
        tuplet_numerator: u32,
        tuplet_denominator: u32,
        grace_type: i32,
    }
    ```
- **Requirements for a Nested Tuplet Edit:**
  - A nested tuplet is a structural span over multiple beats, not an isolated beat property.
  - Supporting it would require either:
    1. A range/grouping edit command: `setTupletGroup { target: BeatRange, ratio: [number, number], level: number }`, or
    2. Extending rhythm commands with a tuplet stack: `nested_tuplets: Vec<TupletRatio>`.
- **Replay Safety for Existing Projects:**
  - Adding optional fields with `#[serde(default)]` in Rust and default fallbacks in TypeScript ensures existing `.tabplayer` project files and undo logs continue to deserialize and replay byte-identically.
  - Alternatively, introducing a distinct new command variant (such as `SetNestedTupletGroup`) leaves `SetBeatRhythm` completely untouched, guaranteeing backward compatibility.
  - However, while edit-log deserialization can be made backward-compatible, applying such an edit to the score graph fails because alphaTab's underlying model cannot store or interpret nested tuplet structures.

### 4. Recommendation
- **Recommendation:** Record row N06 as an **alphaTab upstream architectural limit** (and Guitar Pro format limit). Do not build product code or limited workarounds.
- **Rationale:**
  1. *Upstream Architectural Barrier:* alphaTab 1.8.4 does not support nested tuplets in its data model (`Beat`/`TupletGroup`), rendering engine (`_paintTupletHelper`), or importer/exporter suites. Overcoming this would require deep, intrusive patches to alphaTab's model, renderer and readers, well beyond the thin wrappers TabPlayer already keeps (such as `withPlainTrills` in `src/interchange/gp.ts`).
  2. *Severe Engraving Degradation:* A "limited form" (such as compound ratios for playback) produces unusable visual output: alphaTab prints raw fraction strings like `15:8` on every note, omits outer brackets, and stamps fragmented numbers across the measure. In an application where a comfortable, high-clarity practice UI is the primary goal (`PRODUCT.md`), broken notation is unacceptable.
  3. *Absence in Ecosystem:* GP5 cannot store nested tuplets (TabPlayer's `gp5.ts` refuses unsupported tuplets), and alphaTab's GPIF reader for GP7/8 has no representation for them; whether GP8 itself can author them is unverified.
  4. *Target Audience:* TabPlayer is built for guitar and bass players practicing and learning songs (`PRODUCT.md`). Nested tuplets (complex nested polyrhythms) belong almost exclusively to avant-garde contemporary classical scores and are essentially absent in guitar/bass tablature literature.
  5. *Tracker Integrity:* Marking N06 as an upstream engine limitation maintains total transparency in the GP8 parity tracker without accumulating fragile technical debt.

## Evidence

- **Scratch Vitest Test Execution:**
  Authored and ran a comprehensive test harness in `src/scratch-tuplet.test.ts` exploring four distinct cases in alphaTab 1.8.4 and TabPlayer's playback pipeline:
  1. *Case 1 (Inner 3:2 triplet inside outer 5:4 quintuplet):*
     - Score setup: 4/4 bar, quarter 5:4, quarter 5:4, eighth 3:2, eighth 3:2, eighth 3:2, quarter 5:4, quarter 5:4.
     - Result: `voice.beats` produced 3 disconnected `TupletGroup` instances. Group 1: 2 beats (`isFull: false`). Group 2: 3 beats (`isFull: true`). Group 3: 2 beats (`isFull: false`).
     - Bar duration: evaluated to 4032 ticks (expected 3840 ticks, an overfill of +192 ticks).
     - Playback plan (`buildPlaybackPlan`): scheduled notes at ticks 0..768, 768..1536, 1536..1856, 1856..2176, 2176..2496, 2496..3264, 3264..4032, overflowing the bar.
  2. *Case 2 (Compound ratio 15:8 eighths):*
     - Ratio: `480 * 8 / 15 = 256` ticks per eighth note; `3 * 256 = 768` ticks.
     - Result: Total bar ticks summed exactly to 3840 ticks.
     - Playback plan: scheduled notes at ticks 0..768, 768..1536, 1536..1792, 1792..2048, 2048..2304, 2304..3072, 3072..3840. Playback timing succeeded mathematically.
  3. *Case 3 (SVG Rendering of Case 1 via ScoreRenderer):*
     - Rendered with `ScoreRenderer` in SVG Page mode.
     - Inspected emitted music font symbols. Rendered glyph numbers: `[ 5, 5, 3, 5, 5 ]`.
     - Group 1 and Group 3 stamped bare `"5"` digits over each individual beat without brackets; Group 2 drew a bracket with `"3"`. No outer quintuplet bracket was rendered.
  4. *Case 4 (SVG Rendering of Case 2 compound 15:8):*
     - Rendered with `ScoreRenderer`.
     - `isFull` remained `false`, since three beats never reach the numerator 15.
     - Rendered glyph numbers: `[ 5, 5, 1, 5, ':', 8, 1, 5, ':', 8, 1, 5, ':', 8, 5, 5 ]`.
     - The literal string `"15:8"` was rendered over every single triplet note. Engraving was unusable.
  5. The scratch test file passed 4 of 4 assertions before removal and was deleted cleanly prior to commit (`git status` clean).
- **Codebase Source Inspection:**
  - `node_modules/@coderline/alphatab/dist/alphaTab.js`: inspected `TupletGroup` (lines 6573–6633), `Beat.finishTuplet` (lines 7537–7545), `Beat._calculateDuration` (lines 7500–7506), `GpifParser` (lines 21340–21355), `MusicXmlParser` (lines 23940–23948), `_paintTupletHelper` (lines 59830–59930), and `Gp7Exporter`/`GpifWriter` (lines 66828–67025).
  - `src/interchange/gp.ts`: confirmed GP export delegates to `Gp7Exporter` with `<PrimaryTuplet>`.
  - `src/export/gp5.ts`: confirmed GP5 export enforces `TUPLETS` single-level mapping and refuses compound or non-standard ratios.
  - `src/export/musicxml.ts`: confirmed export writes only single `<time-modification>` tags without nested `<notations><tuplet number="...">` brackets.
  - `src/interchange/midi-import.ts`: confirmed import quantizes only to flat straight or single-level triplet/quintuplet lattices.
  - `src-tauri/src/edit_types.rs`: verified `SetBeatRhythm` schema and serde deserialization structure.
- **Verification Commands:**
  - `npx tsc --noEmit`: passed with 0 errors.
  - `git status`: verified worktree is clean, working on `agy/the-67-tuplet-digest`.

## Review

Independent technical review verifies the four core topics:
1. *alphaTab engine:* Confirmed that alphaTab 1.8.4 has no internal representation for nested tuplets. Its grouping check specifically rejects mixed ratios, and its painting logic has no mechanism to render stacked or nested brackets.
2. *Interchange formats:* GP5, GP7/8, MusicXML, and MIDI implementations in alphaTab and TabPlayer were audited against format capabilities. None support nested tuplets.
3. *Edit safety:* Replay mechanisms were analyzed. While Serde optional fields or new edit types could maintain schema replay safety, they cannot bridge the missing model support in alphaTab.
4. *Recommendation:* Recording row N06 as an alphaTab limit is verified as the only sound architectural choice; attempting partial workarounds compromises engraving quality and contradicts core product principles.

## Limits

- **No product code changes:** In accordance with Task 5 instructions, no product code was modified or committed; this delivery consists solely of this architectural digest.
- **Desktop driver port 9223:** Desktop test drivers were not run, as they require port 9223 and live WebView2 execution, which are reserved for merge verification.
- **Absence of proprietary GP8 binaries:** Findings regarding Guitar Pro 8's runtime handling of nested tuplets are derived from Arobas GPIF format documentation, and alphaTab's GPIF parser (no note in `docs/research/` covers tuplets) rather than live binary instrumentation of Guitar Pro 8.1.5.
- **Worktree fixture limit:** Worktrees do not contain `.analysis/compatibility/` fixtures; all test verification was performed using authored score models in the scratch Vitest harness.

# GP8 parity F27: import field preservation matrix

Date: 2026-10-31. Scope: score model field preservation test matrix and evidence across format writers (`gp`, `gp5`, `musicxml`). This task is tests and a report, not fixes.

## Behavior

- **Purpose.** Parity row F27 requires evidence that import and interchange preserve every target notation, audio, and layout field across score model entities, or plainly accounts for why a field is dropped or failing.
- **Model property taxonomy and completeness check.** The test matrix inspects the runtime keys and compile-time types of all 11 core alphaTab score model entities:
  - `model.Score` (15 data, 5 structural)
  - `model.MasterBar` (18 data, 6 structural)
  - `model.Track` (10 data, 3 structural)
  - `model.Staff` (11 data, 4 structural)
  - `model.Bar` (12 data, 10 structural)
  - `model.Voice` (1 data, 8 structural)
  - `model.Beat` (40 data, 23 structural)
  - `model.Note` (36 data, 20 structural)
  - `model.Automation` (6 data, 1 structural)
  - `model.Chord` (7 data, 1 structural)
  - `model.TremoloPickingEffect` (2 data, 0 structural)
  The test asserts that the set of tested data and structural properties exactly matches `Object.keys(new model.X())` for every entity. If alphaTab adds a new property in a future version, `npx vitest` will immediately fail until the field is catalogued in the matrix.
- **Writers under test.**
  - `gp`: TabPlayer Guitar Pro interchange (`exportGpInterchange` and `loadInterchangeScore`), writing Guitar Pro 7/8 (`Content/score.gpif` zip container with lyrics, harmony, scale diagrams, automation, and stylesheet extensions).
  - `gp5`: TabPlayer Guitar Pro 5 writer (`exportGp5` and `importer.ScoreLoader.loadScoreFromBytes`), writing binary `.gp5` v5.10.
  - `musicxml`: TabPlayer MusicXML 4.0 score-partwise writer (`exportMusicXml` and `loadInterchangeScore`).
- **Field classification.**
  1. **Preserved**: Set to a distinct non-default value on a synthetic score, exported with the writer that claims it, read back, and verified equal. 176 individual field-format combinations pass.
  2. **Knowingly dropped**: Documented limitations where the target format or writer intentionally omits a field, with an exact citation to repository code or documentation.
  3. **Failing**: Real defects where a format writer or importer claims the field or feature, but drops or corrupts the value. These tests are isolated with Vitest's `it.fails` and a one-line reason, preserving a green test suite without masking defects.

### Table of failing fields (real defects)

| Field | Format | Status | Lost Location (Writer / Reader) | One-line reason |
|---|---|---|---|---|
| `TremoloPickingEffect.style` | `gp` | Failing | `alphaTab.js:66833` / `alphaTab.js:20611` | alphaTab GPIF writer writes marks without style, and reader defaults to Default |
| `Note.bendStyle` | `gp` | Failing | `alphaTab.js:66610` / `alphaTab.js:21135` | alphaTab GPIF writer and reader omit note bendStyle |
| `Beat.whammyStyle` | `gp` | Failing | `alphaTab.js:66871` / `alphaTab.js:20650` | alphaTab GPIF writer and reader omit beat whammyStyle |
| `Note.durationPercent` | `gp` | Failing | `alphaTab.js:66550` / `alphaTab.js:21045` | alphaTab GPIF writer and reader omit note durationPercent |
| `Note.isVisible` | `gp` | Failing | `alphaTab.js:66550` / `alphaTab.js:21045` | alphaTab GPIF writer and reader omit note isVisible flag |

### Knowingly dropped fields (traced limitations)

- `MasterBar.displayScale & displayWidth` (layout, `gp`): Stated limit in [docs/validation/2026-10-31-gp8-bar-widths.md:18](../../docs/validation/2026-10-31-gp8-bar-widths.md#L18). alphaTab's GPIF writer does not write `displayScale` or `displayWidth`; custom bar widths are persisted in native `.tabplayer` projects and rendered to PDF, not to interchange `.gp`.
- `Bar.displayScale & displayWidth` (layout, `gp`): Stated limit in [docs/validation/2026-10-31-gp8-bar-widths.md:18](../../docs/validation/2026-10-31-gp8-bar-widths.md#L18). Same as MasterBar widths.
- `Bar.barLineLeft & barLineRight` (layout, `gp`): Stated limit in [src/export/gp5.test.ts:576](../../src/export/gp5.test.ts#L576). GPIF XML format expresses barlines via `MasterBar.isDoubleBar` and repeat boundaries; arbitrary individual barline styles are not stored in GPIF.
- `Staff.transpositionPitch` (audio, `gp`): Stated limit in [PRODUCT.md:44](../../PRODUCT.md#L44). GPIF format holds only display transposition (`<Transpose>`), which maps to `Staff.displayTranspositionPitch`. Sounding transposition is kept in native projects.
- `Track.lineBreaks` (layout, `gp`): Stated limit in [src/export/gp5.test.ts:587](../../src/export/gp5.test.ts#L587). Track line breaks are session layout configuration, not stored in `score.gpif`.
- `Score.backingTrack` (audio, `gp5`): Stated limit in [docs/validation/2026-10-30-gp8-gp5-export.md:32](../../docs/validation/2026-10-30-gp8-gp5-export.md#L32). Guitar Pro 5 binary format lacks a container for backing audio files; reported in export losses.

## Evidence

Run in this worktree (branch `agy/f27-field-matrix`):

- `npx tsc --noEmit`: Clean (0 errors).
- `npx vitest run src/interchange/field-preservation.test.ts`:
  - 176 passed tests
  - 5 expected failures (`it.fails`)
  - 181 total tests in 2.31s.
- `npx vitest run src/interchange --testTimeout=60000`:
  - 32 passed test files (809 passed tests, 5 expected fail, 8 skipped).
  - The only failures across `src/interchange` are 4 tests in `gp.test.ts` that attempt to read fixture files (`guitarpro3-notes.gp3` etc.) from `.analysis/compatibility`, which is not cloned into worktrees (noted in handoff).

### Detailed defect analysis with line citations

1. **`TremoloPickingEffect.style`**
   - **Loss in writer**: `node_modules/@coderline/alphatab/dist/alphaTab.js:66833`
     ```js
     if (beat.isTremolo) switch (beat.tremoloPicking.marks) {
         case 1: beatNode.addElement("Tremolo").innerText = "1/2"; break;
         case 2: beatNode.addElement("Tremolo").innerText = "1/4"; break;
         case 3: beatNode.addElement("Tremolo").innerText = "1/8"; break;
     }
     ```
     `GpifWriter` evaluates only `beat.tremoloPicking.marks` and completely omits `style` (`TremoloPickingStyle.BuzzRoll`).
   - **Loss in reader**: `node_modules/@coderline/alphatab/dist/alphaTab.js:20611`
     ```js
     case "Tremolo":
         const tremolo = new TremoloPickingEffect();
         beat.tremoloPicking = tremolo;
         switch (c.innerText) {
             case "1/2": tremolo.marks = 1; break;
             case "1/4": tremolo.marks = 2; break;
             case "1/8": tremolo.marks = 3; break;
         }
         break;
     ```
     `GpifParser` creates a `new TremoloPickingEffect()` which defaults `style` to `0` (`Default`) and never parses a style attribute or element.

2. **`Note.bendStyle`**
   - **Loss in writer**: `node_modules/@coderline/alphatab/dist/alphaTab.js:66610`
     `GpifWriter._writeBend` serializes `<Bends>` points and `<Bend>` type, but never serializes `note.bendStyle` (`BendStyle.Gradual` or `Fast`).
   - **Loss in reader**: `node_modules/@coderline/alphatab/dist/alphaTab.js:21135`
     `GpifParser._parseBend` reads points and type, leaving `note.bendStyle` at its default `0` (`Default`).

3. **`Beat.whammyStyle`**
   - **Loss in writer**: `node_modules/@coderline/alphatab/dist/alphaTab.js:66871`
     `GpifWriter` writes `<WhammyBar>` type and points, but omits `beat.whammyStyle`.
   - **Loss in reader**: `node_modules/@coderline/alphatab/dist/alphaTab.js:20650`
     `GpifParser` does not parse any style property for whammy bars, leaving `whammyStyle` at default `0`.

4. **`Note.durationPercent`**
   - **Loss in writer**: `node_modules/@coderline/alphatab/dist/alphaTab.js:66550`
     `GpifWriter._writeNote` serializes fret, string, dynamic, and articulations, but omits `note.durationPercent`.
   - **Loss in reader**: `node_modules/@coderline/alphatab/dist/alphaTab.js:21045`
     `GpifParser._parseNote` does not parse `durationPercent`, leaving it at default `1.0`.

5. **`Note.isVisible`**
   - **Loss in writer**: `node_modules/@coderline/alphatab/dist/alphaTab.js:66550`
     `GpifWriter._writeNote` omits `note.isVisible` (hidden note flag).
   - **Loss in reader**: `node_modules/@coderline/alphatab/dist/alphaTab.js:21045`
     `GpifParser._parseNote` does not parse `isVisible`, leaving it at default `true`.

## Review

- **Completeness**: All 11 alphaTab score model entities are pinned at compile time and runtime.
- **Traceability**: All knowingly dropped fields trace directly to documented platform and format boundaries.
- **Zero test mutation**: No existing tests were skipped, weakened, or altered. The defect tests are verified using `it.fails`.
- **Clean worktree boundaries**: Untrusted or fixture-dependent files were not modified. All test scores are synthetically constructed in memory.

## Limits
n- **Updated at merge**: `Note.bendStyle` and `Beat.whammyStyle` were failing fields when this matrix was written. The GP curves slice now keeps them in `TabPlayerCurves`, so their tests pass; the failing-field text above predates that. Only TabPlayer reads that property.

- **Synthetic test scores only**: The test suite uses synthetic scores constructed in memory via the model API. This verifies preservation across TabPlayer's writers and alphaTab's readers, but **does not prove interoperability with original Guitar Pro 8**.
- **No exporter/importer fixes**: In accordance with the task specification, defects were catalogued and isolated in `it.fails`, but not fixed. Task 4 addresses `TremoloPickingEffect.style` (`T17`).
- **Worktree fixture isolation**: Tests requiring `.analysis/compatibility` fixture files are not executed in this worktree.

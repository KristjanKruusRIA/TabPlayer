# GP8 Parity T17: Buzz-roll Loss Warning on GP 7/8 Export

Reports buzz-roll loss on GP 7/8 export, and ensures selected-tracks and bar-range exports report source tracks and bars instead of projected positions.

## Behavior

- **Buzz-roll loss reporting**:
  - `planCurves` and `curveLosses` in `src/interchange/curves.ts` inspect beats for `beat.tremoloPicking?.style === model.TremoloPickingStyle.BuzzRoll`.
  - When present, the loss is reported as `the buzz-roll tremolo picking at track X, bar Y, beat Z becomes ordinary tremolo picking`.
  - In document export (`DocumentController.export()`) and the export dialog (`useExportCoordinator`), the loss warning is presented in the confirmation dialog before writing.
  - In batch conversion (`runBatch` / `convertScoreBytes`), files with buzz rolls note the loss on the converted row (`left out of the Guitar Pro file: the buzz-roll tremolo picking at track X, bar Y, beat Z becomes ordinary tremolo picking`) without failing conversion.
  - Scores without losses continue to receive the plain export prompt.
- **Source track and bar reporting**:
  - `selectScore` in `src/export/selection.ts` records `sourceIndex` on each projected `model.Track` and `model.Bar`.
  - `wherever(beat)` in `src/interchange/curves.ts` resolves `sourceIndex` if present on the track and bar, falling back to projected indices if absent.
  - Selected-track and measure-range exports report the actual source track and bar numbers (e.g., track 2, bar 3) rather than projected document offsets (e.g., track 1, bar 1) for buzz rolls, curves, and slurs alike.

## Evidence

- **Unit and integration tests**:
  - `src/export/gp-losses.test.ts`:
    - `lists buzz-roll tremolo picking loss as ordinary tremolo picking with source position`
    - `names the source track and bar rather than projected position for selected tracks or bar range`
    - `converts a score with buzz-roll tremolo picking and reports it on the batch row`
    - `the export dialog asks with buzz-roll loss before writing when buzz roll is present`
  - All 14 tests in `src/export/gp-losses.test.ts` pass.
  - All 48 tests in `src/interchange/curves.test.ts` pass.
  - `npx tsc --noEmit` exits 0 with no diagnostic errors.

## Review

- Evaluated whether `selectScore` modifying `sourceIndex` affects other consumers or serialized output. Confirmed that `sourceIndex` is an expando property on in-memory alphaTab model instances, not serialized in JSON or GPIF, and only read by `wherever(beat)`.
- Reused existing `curveLosses` pipeline without adding duplicate traversals or changing the shape of `CurvePlan`.

## Limits

- No real Guitar Pro 8 runtime check was performed (desktop drivers not run per shared rules).
- Does not preserve buzz rolls through GP 7/8 export itself (GP8 format lacks a buzz roll field; native `.tabplayer` and MusicXML preserve it).

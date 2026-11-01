# GP8 Field Preservation: durationPercent, isVisible, and TremoloPickingStyle (F27)

## Behavior

TabPlayer preserves `Note.durationPercent`, `Note.isVisible`, and `TremoloPickingEffect.style` across Guitar Pro 7/8 interchange round trips (`exportGpInterchange` and `loadInterchangeScore`).

1. `hasGpifCurves`: returns `true` if any note has `durationPercent !== 1` or `!isVisible`, or if any beat has `tremoloPicking.style !== Default`. For scores with default values (durationPercent = 1, isVisible = true, tremolo style = Default), `hasGpifCurves` returns `false` and the export emits byte-identical archives to previous baseline.
2. `writeGpifCurves`: records:
   - `<Tremolo ... style="..." notes="..." fields="..."/>` in `Property[name="TabPlayerCurves"] > Items` for beats with non-default tremolo style (e.g. BuzzRoll).
   - `<Note ... durationPercent="..." isVisible="false"/>` in `Property[name="TabPlayerCurves"] > Items` for notes with non-default `durationPercent` or `isVisible === false`.
3. `readGpifCurves`: restores these properties on matching beats and notes.
4. Hostile input validation:
   - Malformed `Tremolo`: non-integer, negative, or unmapped enum values for `style` are rejected and skipped with warning (`Skipped a malformed tremolo in the GP file: Invalid tremolo style.`).
   - Malformed `Note`: non-positive (`<= 0`), out-of-range (`> 16`), non-finite/NaN `durationPercent`, non-boolean `isVisible`, or empty `<Note>` items lacking both properties are rejected and skipped with warning (`Skipped a malformed note property in the GP file: ...`).
5. Stale item rejection:
   - Rejects items if the note or beat address does not match where the file's Bars, Voices, Beats, and Notes place that ID.
   - Rejects note items if the note's string or fret was modified in external editors (`the notes differ`).
   - Rejects tremolo items if the beat's note list was modified or if ordinary GPIF tremolo markings were edited or removed (`its ordinary fields were edited`).
   - Rejects items pointing to missing or deleted music.

## Evidence

1. `src/interchange/field-preservation.test.ts`:
   - Converted the 3 previous `it.fails` entries into passing tests:
     - `TremoloPickingEffect.style: kept by the TabPlayerCurves property`
     - `Note.durationPercent: kept by the TabPlayerCurves property`
     - `Note.isVisible: kept by the TabPlayerCurves property`
2. `src/interchange/curves.test.ts`:
   - Added suite `F27 field preservation, safety and stale checks` (15 tests):
     - Round trips durationPercent, isVisible, and tremolo picking buzz roll together.
     - Rejection and warning emission for hostile tremolo values (unknown style, negative style, non-integer style).
     - Rejection and warning emission for hostile note properties (zero duration, negative duration, non-numeric duration, huge duration, invalid isVisible, missing properties).
     - Stale note item rejection when note fret is edited, string is edited, or note is placed elsewhere.
     - Stale tremolo item rejection when tremolo is removed in ordinary GPIF XML, when tremolo marks are changed, or when notes on the beat differ.
   - Verified that scores without these properties write identical bytes as before (`write exactly the bytes they wrote before curves were carried`).
3. `src/interchange/gp.test.ts`:
   - Verified that TabPlayer's reader preserves `BuzzRoll`, while standard alphaTab / third-party GP reader defaults to `Default`.

Test verification:
- `npx vitest run src/interchange/curves.test.ts src/interchange/field-preservation.test.ts src/interchange/gp.test.ts`: 264 passing tests across 3 files.
- `npx vitest run src/export/`: 502 passing tests across 17 files.
- `npx tsc --noEmit`: 0 errors.

## Review

Changes read untrusted XML files:
- Parsing only examines validated attributes on `<Tremolo>` and `<Note>` elements within `TabPlayerCurves`.
- Every value is strictly validated (numeric bounds, enum verification, boolean literal check).
- Identity and structural placement checks ensure that hostile or stale entries cannot mutate unrelated or modified score elements.

## Limits

- Guitar Pro 8 does not read the proprietary `TabPlayerCurves` property. When an exported file is opened in Guitar Pro 8, buzz rolls continue to load as ordinary tremolo picking, and note-specific durationPercent / isVisible flags revert to standard defaults.
- Task 1's buzz-roll export warning stays in place in `planCurves` and export loss reports because Guitar Pro 8 cannot represent the buzz-roll style.
- Desktop drivers requiring port 9223 were not run.

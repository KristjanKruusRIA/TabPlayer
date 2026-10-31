# GP8 parity N06: nested tuplets (2026-10-31)

Outcome: not built. No code changed. alphaTab 1.8.4 has no nested-tuplet model, and every field TabPlayer could reuse would produce false notation. This note records the evidence.

## Behavior

Unchanged. A beat carries one `tuplet_numerator` and one `tuplet_denominator` (`src-tauri/src/edit_types.rs:1179-1180`, validated positive at `:1545-1546`). Authoring an inner triplet inside a quintuplet is not possible and is not faked.

## Evidence

All line numbers are in `node_modules/@coderline/alphatab/dist/alphaTab.core.mjs` (1.8.4), read in this worktree.

- Model: `Beat` has exactly `tupletDenominator` and `tupletNumerator` (7186, 7190), `hasTuplet` is true when they differ from -1/-1 and 1/1 (7191-7192). Clone copies only these two (7891-7892). No second ratio or nesting depth exists. The declaration file has the same single pair plus `tupletGroup` (`alphaTab.d.ts:4970-4976`).
- Grouping: `TupletGroup.check` accepts a beat only when its numerator and denominator equal the first beat's (6616). A group is flat and one ratio deep.
- Playback ticks: `Beat.playbackDuration` applies one `MidiUtils.applyTuplet(ticks, num, den)` (7500) which is `ticks * den / num | 0` (339-341). Nesting could only be expressed by multiplying ratios into one pair, for example 3:2 inside 5:4 as 15:8.
- Renderer: the bracket number is chosen from the first beat's pair (59834-59846), with explicit symbols only for 2:3, 3:2, 4:6, 5:4, 6:4, 7:4, 9:8 to 13:8. Other ratios fall to a generic digit path (59847 onward) that prints the numerator. A composed 15:8 would draw a single bracket labelled 15, which is wrong notation. There is one bracket per group (53006, `isFirstOfTupletGroup`), so an inner bracket cannot be drawn.
- GPIF reader: only `PrimaryTuplet` with `num` and `den` is parsed (21343-21346) and copied onto the beat (21402-21403). No handling of a second or nested tuplet element exists anywhere in the bundle (searched for `Nested`, `Secondary`, `NestedTuplets`: no matches).
- GPIF writer: emits one `PrimaryTuplet` per rhythm, with the rhythm id keyed on duration, dots, numerator and denominator (67006-67016). Nothing else is written, so a nested structure would not round trip through alphaTab's exporter.
- alphaTex: the `tu` property takes one numerator and denominator (13780-13797, 14777). GP3-5 binary reader sets a single pair (18257-18282). MusicXML reader reads one `count` (17653-17658).
- Not verified: the exact GPIF element names Guitar Pro 8 uses for a second ratio. alphaTab does not contain them and no GP8 sample with nested tuplets is available in this repository, so none is asserted here.

## Review

Options considered:

1. Fold the two ratios into the existing pair. Ticks come out right, but the bracket shows a single number such as 15 (59847 fallback), the tuplet group would not match neighbours with different inner ratios (6616), and the GP file written by alphaTab would store a 15:8 tuplet that Guitar Pro shows as one 15-tuplet. This is not truthful notation, so it was rejected.
2. Add new fields in Rust and TypeScript for outer and inner ratios and use them only for ticks. The score would still be drawn and exported with the wrong shape, and the playback would disagree with what the page shows. Rejected for the same reason.
3. Change nothing. Chosen.

## Limits

To support this properly, one of these is needed: an alphaTab release with a nested tuplet model in `Beat`, `TupletGroup`, the GPIF reader and writer and the bracket renderer; or a TabPlayer-owned renderer overlay and GPIF post-processor, which is a large separate project and would have to be checked against real Guitar Pro 8 files. Until then, N06 stays open: inner triplets inside a quintuplet cannot be authored, bracketed, ticked from separate ratios, or round tripped. No tests were run because nothing changed.

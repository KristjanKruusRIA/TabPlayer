# GP8 D08: per-system gaps (THE-179)

## Behavior

- The Presentation tools have a "Design: system gaps" panel. Select a bar, then enter "System gap (%)" from 25 to 400 for the system that contains it. 100% is the standard gap.
- Gaps show in the physical page layouts (vertical page, horizontal page and grid) and in the export pages (PDF, SVG, PNG, print). On the desktop only the export pages handed to the PDF writer were checked.
- The extra offset above a system with scale `s` is `(s - 1) x 20 x (system spacing or 1) x render scale`. It is negative below 100%. The first system of the score and a system that starts a page take no offset; a system pushed to the next page drops its offset.
- Data: `EngravingOverrides.systemGaps`, a list of `{bar, scale}` entries carried by the existing `setEngraving` edit. It is omitted when empty. A system is identified by an anchor bar and resolved by containment in the rendered system's bar interval.
- "Reset selected system" removes the entries inside the selected system. "Reset all system gaps" removes the field. Both are unavailable (`aria-disabled`, never `disabled`) when there is nothing to reset.
- Committing on Enter or blur is one undoable edit. Choosing the current value records nothing.
- A gap-only edit does not re-render the notation. The screen repaginates from the chunks it holds.
- Gaps never change timing or native playback.

## Evidence

- Vitest, Rust protocol and style-library tests cover the data model, validation, remap on bar insert and remove, pagination on screen and in export, and the panel (see the task commits on `feature/d08-system-spacing`).
- Windows desktop test, `tests/desktop/parity-system-gaps.mjs`, on the engraving fixture (systems of bars 1-2, 3-4, 5-8, 9-10, 11-12) at A4 in the vertical page view:
  - 200% on the third system moves its on-screen top and every later system on its page by the expected offset; earlier systems do not move.
  - The export pages handed to the PDF writer (`window.__tabplayerTestExportPages`) show the same offset above that system. The driver checks only the `%PDF-` header of the written file. SVG, PNG and print export were not checked on the desktop.
  - A second system at 150%, Reset selected (only that system returns), Reset all (every system returns), each undone and redone.
  - Save and reopen keep the gap on screen and in the export pages handed to the PDF writer.
  - The native audio generation is read before and after all gap edits and does not change.
- Driver output:

```text
PASS baseline: the third system is not the first system of a page - screen pages [0,1,1,1,2], export pages [1,2,2,3,4]
PASS baseline: the system gap field shows 100% for the selected third system
PASS set 200% on the third system: one setEngraving edit carrying one gap at its first bar
PASS set 200% on the third system: its screen top moves down by the standard gap, earlier systems do not move - moved [0,0,20,20,0] px, expected 20 px
PASS set 200% on the third system: the exported PDF shows the same extra offset above it - moved [0,0,20,0,0], expected 20
PASS choosing the current value records nothing
PASS set 150% on a second system: one more edit and both gaps are carried
PASS reset selected system: only the fourth system returns, the third keeps its gap
PASS reset all: every system returns to its baseline top, on screen and in the PDF
PASS the reset buttons are unavailable once nothing is left to reset
PASS undo 1/4 restores the earlier state
PASS undo 2/4 restores the earlier state
PASS undo 3/4 restores the earlier state
PASS undo 4/4 restores the earlier state
PASS redo 1/4 replays the step
PASS redo 2/4 replays the step
PASS redo 3/4 replays the step
PASS redo 4/4 replays the step
PASS save leaves the document clean with the gap in it
PASS native playback generation is unchanged across every gap edit, undo and redo - generation 6 (idle; no playback was started)
PASS no page errors
PASS reopen: the project (history and gaps) is identical
PASS reopen: the saved gap is on screen and in the exported PDF
PASS reopen: the saved gap shows in the panel and resets
system-gaps: 24 passed, 0 failed.
```

Run on 2026-11-07 against the desktop test build of 3465e8c (app code unchanged by e96b844, which fixed only the driver). Evidence: `.analysis/parity/system-gaps-result.json` (not committed). The same result held on three consecutive earlier runs.

## Limits

- D08 stays partial.
- Gaps are not shown in parchment (the default), vertical screen or horizontal screen. The panel says so.
- Older builds refuse a log or project that carries the new field.
- Gaps are not written to Guitar Pro files.
- Gaps are not part of saved styles.
- Screen and export page breaks differ (export reserves 64 px for the header and footer). "Same" means the same extra offset above the same system within a page, not the same page.
- At A4 in the desktop test the export puts the fourth system (bars 9-10) at the top of its own page, so its 150% gap is dropped there by design. The test asserts that; the second gap's offset is therefore only measured on screen.
- The desktop test does not play audio during the edits: it checks the generation while idle.
- No per-staff gaps and no original-GP8 comparison.
- Exporting tracks to separate files renders each track alone (`src/export/useExportCoordinator.ts`); with alphaTab's model layout a single track may break systems differently from the full score, so a gap anchored to a bar can land on a different exported system than on screen. This is a known limit, not verified.
- Removing a system's first bar drops that system's gap. A relayout can put two gap anchors in one system; only the lowest applies and the other stays stored but has no effect.
- The desktop driver identifies systems by position and drops alphaTab's credit chunk by its English text. It fails safe (wrong blocks give wrong offsets), and alphaTab is pinned at 1.8.4.
- Not proven on the desktop: a gap below 100%, a system pushed to the next page, a second exported system taking its gap, and gap edits while playback runs. Unit tests cover the first two; a second exported system taking its gap is not tested anywhere.

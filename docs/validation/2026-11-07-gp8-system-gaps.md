# GP8 D08: per-system gaps (THE-179)

## Behavior

- The Presentation tools have a "Design: system gaps" panel. Select a bar, then enter "System gap (%)" from 25 to 400 for the system that contains it. 100% is the standard gap.
- Gaps show in the physical page layouts (vertical page, horizontal page and grid) and in every export (PDF, SVG, PNG, print).
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
  - The exported PDF page shows the same offset above that system.
  - A second system at 150%, Reset selected (only that system returns), Reset all (every system returns), each undone and redone.
  - Save and reopen keep the gap on screen and in the PDF.
  - The native audio generation is read before and after all gap edits and does not change.
- Driver output:

<!-- controller fills after run -->

## Limits

- D08 stays partial.
- Gaps are not shown in parchment (the default), vertical screen or horizontal screen. The panel says so.
- Older builds refuse a log or project that carries the new field.
- Gaps are not written to Guitar Pro files.
- Gaps are not part of saved styles.
- Screen and export page breaks differ (export reserves 64 px for the header and footer). "Same" means the same extra offset above the same system within a page, not the same page.
- The desktop test does not play audio during the edits: it checks the generation while idle.
- No per-staff gaps and no original-GP8 comparison.

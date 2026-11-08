# D08: per-system gaps and selected-system reset (THE-179)

Spec: Linear THE-179: "change one system's gap, then reset the selected system or all of them, each as one undoable edit, with export matching the screen". Also the D08 row of `docs/validation/2026-10-15-gp8-parity-progress.md`. Research notes are in the session scratchpad (`d08-research.md`); the facts this plan relies on are restated here.

## Rulings made before planning

- **Where gaps show.** alphaTab has no per-system padding, so the gap is applied where TabPlayer stacks the engraved system chunks itself:
  - the physical page layouts (`verticalPage`, `horizontalPage`, `grid`) through `paginateScreenScore` in `src/engraving/screen-pages.ts`;
  - every export (PDF, SVG, PNG, print) through `paginateEngravedSystems` in `src/engraving/page.ts`.
  Parchment (the default), vertical screen and horizontal screen do not show gaps; the panel says so. This is recorded as a limit and D08 stays partial.
- **Data.** `EngravingOverrides.systemGaps?:{bar:number;scale:number}[]`.
  - It is optional and omitted when empty, as `barWidths` is.
  - `scale` is a factor from 0.25 to 4, shown in the UI as a percentage from 25 to 400.
  - Entries are strictly ascending by `bar`. `bar` runs from 0 to 99 999, and the list holds at most 10 000 entries.
  - The same rules hold in TypeScript and Rust.
  - It is carried by the existing `setEngraving` edit. There is no new edit type.
  - Saved styles reject it, as they reject `barWidths`.
- **System identity: an anchor bar, resolved by containment.**
  - An entry applies to the rendered system whose bar interval `[first,last]` contains `entry.bar`. If several entries fall in one system, the lowest bar wins.
  - Entries whose bar is not in any rendered system are ignored.
  - Setting a gap writes one entry at the system's first bar and removes the system's other entries.
  - "Reset selected system" removes every entry inside the system's interval. "Reset all" removes the field.
  - On bar insert or remove, entries are remapped through the same `oldToNew` map as `barWidths`, at the same five `src/engine.ts` sites, through one shared helper. Entries whose bar is removed are dropped.
- **Gap size.**
  - The standard gap between two systems is `base = 20 × (systemSpacing ?? 1)` alphaTab units, in the same units as the chunk heights at that render's scale. 20 is alphaTab's `systemPaddingTop` (10) plus `systemPaddingBottom` (10).
  - A system with scale `s` gets an extra offset of `(s − 1) × base × renderScale` before it. That offset is negative when `s < 1`.
  - No offset applies before the first system of the score, or before a system that starts a page.
  - Page-fit decisions include the offset. If the system no longer fits, it moves to the next page and the offset is dropped there.
- **Screen and export match per system, not per page.** Screen and export already paginate differently (the 64 px header/footer reservation). "Export matching the screen" means the same extra offset above the same system within a page.
- **No re-render.** A gap-only edit must not re-render alphaTab. The render path gets an engraving without `systemGaps`, memoized on a key that leaves the gaps out. The screen repaginates from the chunks and bounds it holds, as D10 does for headers. Zoom and arrangement keep their no-re-render guarantees.
- **The selected system.**
  - `ScoreView` reports the rendered systems' `{first,last}` bar intervals after each completed render.
  - The panel picks the system containing the selected bar: the caret's bar, or the start bar of the music selection.
  - The control is unavailable when:
    - no physical page layout is shown;
    - a render is in progress;
    - the selected system is the first of the score.
- **One gesture is one edit.**
  - The percentage commits on Enter or blur.
  - Choosing the current resolved value records nothing.
  - Reset selected (with no entry in range) and Reset all (with no entries) are unavailable. They use `busyGuard`, never `disabled`, for busy.
  - "Reset to source/default" in `EngravingPanel` keeps `systemGaps`, as it keeps `barWidths`. Its `apply()` and `reset()` must re-attach the live gaps.

## Global constraints

- Old `.tabplayer` projects and edit logs replay unchanged. An absent field loads as empty and serializes without the field. Old builds refusing a log with the new field is a recorded limit.
- Export output without gaps stays byte-identical: `page.test.ts`, `page-text.test.ts`, `pdf.test.ts` and `header-footer.test.ts` pass unchanged.
- New UI text goes through `src/i18n` with `en`, `et` and `de`. Do not rename the existing "System spacing (%)" label; desktop drivers use it.
- Native audio must not restart on a gap edit. It stays a settings edit.
- Run `npm run typecheck` and the touched Vitest files. For Rust: `cargo test --locked --manifest-path src-tauri/Cargo.toml --test engraving_protocol`, the `style_library` unit tests, and `cargo fmt --check`. Use the default `src-tauri/target`; never a scratchpad or per-task target folder.

## Task 1: Data model, validation, remap, style rejection (TS and Rust)

Files: `src/engraving/types.ts`, `src/engraving/projection.ts`, new `src/engraving/system-gaps.ts` (+ test), `src/engraving/bar-widths.ts` (shared mapper), `src/engine.ts`, `src/engraving/style-library.ts`, `src/engraving/EngravingPanel.tsx` (re-attach), `src-tauri/src/engraving.rs`, `src-tauri/src/style_library.rs`, `src-tauri/tests/engraving_protocol.rs`.

- Add the type, the conditional key in `validateEngraving`, and the bounds above.
- Add pure helpers that return the same object when nothing changes:
  - `withSystemGaps(engraving, gaps)` drops the key when the list is empty.
  - `resolveSystemGaps(gaps, systems:{first,last}[])` returns a `Map<systemFirstBar, scale>`, where the lowest anchor wins.
  - `setSystemGap(engraving, system, scale)` treats scale 1 as removing the system's entries.
  - `resetSystemGap(engraving, system)` and `resetAllSystemGaps(engraving)`.
- Generalize the `barWidths` remap so one helper remaps both lists at all five `engine.ts` sites.
- Saved styles: `styleOf` strips the gaps, `styleApplied` keeps the document's own, and `validateEntry` rejects them. Rust `style_library.rs` rejects them too.
- `EngravingPanel` `apply()` and `reset()` re-attach the live `systemGaps`.
- Rust gets the field with `serde(default, skip_serializing_if = "Vec::is_empty")`, the caps and the validation, and copies of the two `bar_widths` protocol tests for the new field: bounds and round trip, plus history, undo, redo, save and reopen beside an old log.
- Tests:
  - validation bounds;
  - resolver containment and lowest-anchor-wins;
  - set, reset and reset-all identity when nothing changes;
  - remap on insert and remove (including a removed anchor);
  - an old log replaying without the field;
  - a style that neither carries nor clears the gaps.

## Task 2: Gap-aware stacking for export and screen

Files: `src/export/types.ts`, `src/export/pdf.ts`, `src/engraving/page.ts`, `src/engraving/screen-pages.ts`, their tests, and a new render-level test modelled on `src/engraving/bar-widths.render.test.ts`.

- `SvgSystem` gains optional `firstBar`/`lastBar` (the master-bar indexes from `partialRenderFinished`; −1 chunks stay without them).
- `paginateEngravedSystems` and `paginateScreenScore` take optional gaps plus `systemSpacing` and the render scale, and apply the offset rule above. With no gaps the output is byte-identical; the existing tests prove it.
- `renderPdfPages` passes the document's gaps.
- Tests:
  - offsets before the chosen system on both stackers;
  - no offset before the first system or at a page top;
  - page-fit including the offset;
  - shrink below 100%;
  - the real-renderer test shows that the exported y-distance between two systems grows by the expected offset, and stays unchanged without gaps.

## Task 3: Screen wiring without re-render, and system reporting

Files: `src/ScoreView.tsx`, `src/ScoreView.layouts.test.tsx`.

- The render path uses an engraving without `systemGaps`, memoized on a key that leaves them out. The chunks and bounds of the last completed render are held in a ref, so a gap-only change repaginates with no alphaTab render.
- Add `onSystems?(systems:{first:number;last:number}[]|null)`, reported after each completed render in physical page layouts and `null` otherwise. It is used by the panel.
- Tests:
  - a gap-only change moves the following blocks without another render;
  - zoom and arrangement still don't re-render;
  - systems are reported in page layouts and `null` in parchment.

## Task 4: System gaps panel

Files: new `src/engraving/SystemGapsPanel.tsx` (+ test), `src/App.tsx`, `src/i18n/en.ts`, `et.ts`, `de.ts`.

- The panel sits in the Presentation tools beside `BarWidthsPanel`. It shows the selected system ("Bars a–b"), a percentage field (25–400) for its gap, "Reset selected system" and "Reset all system gaps".
- When unavailable it shows a status line explaining why: not a page layout, rendering, the first system, or no selection.
- Each action is one `setEngraving` built from the Task 1 helpers. `App` guards against recording an unchanged engraving.
- Use `editBusy` and `busyGuard`. All text goes through i18n.
- Tests:
  - a commit is one command;
  - entering the current value records nothing;
  - reset selected removes only that system's entries;
  - reset all clears the list;
  - the controls are unavailable with reasons;
  - the catalog test passes.

## Task 4b: Desktop proof, docs and tracker (controller)

- Add `tests/desktop/parity-system-gaps.mjs`, based on `parity-header-footer.mjs`, using the engraving fixture (`[2,2,4,2,2]` systems):
  - in the vertical page view, select a bar in the third system, set 200%, and check that the system's on-screen top moves down by the expected offset while earlier systems don't move;
  - the exported PDF page shows the same extra offset above that system;
  - set a second system, then reset the selected one (only it returns), then reset all (all return);
  - undo and redo each step, then save and reopen;
  - check that native playback generation is unchanged.
- Write `docs/validation/2026-11-07-gp8-system-gaps.md`, update the D08 row (md and json) and keep it partial. Limits: not shown in parchment, vertical screen or horizontal screen; older builds refuse the new field; not in GP export; not in saved styles; screen and export page breaks differ.

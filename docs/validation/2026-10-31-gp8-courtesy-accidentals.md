# GP8 Parity: Courtesy / Cautionary Accidentals (Row N22)

Validated on 2026-10-31 on branch `feat/slice-n22`.

## Behavior

- Added the ability to mark a note with a courtesy / cautionary accidental as one undoable edit from the note inspector controls (`SpellingControl`).
- Added `SetNoteCautionary` (and alias `SetNoteCourtesy`) to Rust `EditCommand` with protocol validation, roundtrip testing in `tests/protocol.json`, and TypeScript engine support in `src/edit-types.ts`, `src/parity-commands.ts`, and `src/editor/pitch.ts`.
- When enabled on a note with `accidentalMode: Default`, the engine determines the explicit accidental mode corresponding to the note's pitch in the measure's key signature (`ForceNatural`, `ForceSharp`, `ForceFlat`, `ForceDoubleSharp`, `ForceDoubleFlat`) so that the standard staff renders the accidental. Toggling off reverts the accidental mode to `Default`. Sounding pitch remains unchanged.
- UI interaction rules:
  - Checkbox labeled "Cautionary accidental" in `SpellingControl`.
  - Stays focusable while busy (`aria-disabled="true"` with click/change handlers that refuse, never the `disabled` attribute on a focus-holding control).
  - Choosing the current value records nothing.
  - One gesture generates exactly one undoable edit through the real engine.
  - Only truly `disabled` when absent (`!note`) or on percussion tracks (`staff.isPercussion`), where accidental authoring does not apply.
- Persistence and history:
  - Cautionary accidental state survives save and reopen via a `model.JsonConverter` serialization hook (`tabplayercautionary`).
  - Supports full undo and redo.
  - Preserves backward compatibility: old projects and edit logs without cautionary edits continue to replay identically.

## Evidence

- Rust protocol tests:
  - `cargo test --release --test protocol`: 8 tests passed, verifying roundtrip serialization and validation across all 78 protocol fixtures.
  - `cargo test --release --lib edit_types`: 46 tests passed, including new test `cautionary_accidentals_roundtrip_and_validate`.
  - `rustfmt --edition 2024 src-tauri/src/edit_types.rs src-tauri/tests/protocol.rs`: Clean, no formatting differences.
- TypeScript test suites:
  - `src/editor/pitch.test.ts`: 30 passed, testing cautionary accidental setting, pitch preservation, native save/reopen roundtrip, GP export roundtrip, and rejection of invalid targets/payloads.
  - `src/editor/parity-replay.test.ts`: 3 passed, proving backward compatibility with existing project logs as well as undo/redo of cautionary edits.
  - `src/editor/SpellingControl.test.tsx`: 3 passed, testing real engine dispatch, busy state refusal and focus preservation, and disabled states.
  - `src/parity-commands.test.ts`: 14 passed.
  - `src/App.test.tsx`: 143 passed (`--testTimeout=60000`).
  - TypeScript typecheck: `npx tsc --noEmit -p .` passed with 0 errors.

## Review

Pending.

## Limits

- **No Parenthesis Glyphs in alphaTab 1.8.4**: alphaTab's score font and `AccidentalGlyph` renderer do not support parenthesis SMuFL glyphs or enclosing accidentals in parentheses. Courtesy accidentals render as explicit accidental signs (`Natural`, `Sharp`, `Flat`, `DoubleSharp`, `DoubleFlat`) on the standard staff.
- **alphaTab Note Model**: alphaTab 1.8.4's `model.Note` does not offer a native `cautionary` or `courtesy` field. TabPlayer tracks cautionary state via `WeakMap<model.Note, boolean>` and persists it across project clones/saves using the `tabplayercautionary` wire JSON hook.
- **GPIF / Guitar Pro Export**: alphaTab's `GpifWriter` exports accidentals as text strings in `<Accidental>` (`#`, `b`, `x`, `bb`, or empty string for natural). Guitar Pro 7/8 GPIF XML does not have a public cautionary/parenthesis attribute in alphaTab's writer model; GP export therefore preserves the explicit accidental mode but does not export parenthesis markup.

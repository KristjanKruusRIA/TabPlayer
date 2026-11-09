# THE-205 Validation: MIDI import notes through i18n

**Date**: 2026-11-09  
**Issue**: THE-205 (MIDI import notes through i18n)  
**Branch**: `agy/the-205-midi-import-notes`

## Summary
The sentences under the MIDI import part list in `MidiImportDialog.tsx` were previously constructed as raw English sentences inside `src/interchange/midi-import.ts` (e.g. `"${unplayable} guitar or bass parts have notes..."`) and presented with string slice capitalization.

In this change:
1. `MidiImportNote` was defined as a discriminated union of 7 note kinds with counts:
   - `unsupported_meters`
   - `deferred_meters`
   - `later_instruments`
   - `unplayable_tab`
   - `dropped_drum_notes`
   - `shortened_notes`
   - `merged_notes`
2. `MidiImportSummary.notes` now returns `MidiImportNote[]`.
3. Added `formatMidiImportNote(note, t)` which formats structured notes (or legacy strings) through `t(...)`.
4. Translated all 7 note categories in singular and plural across `en`, `et`, and `de` in `src/i18n/`.
5. Updated `MidiImportDialog.tsx` to render notes via `formatMidiImportNote(note, t)`.
6. Added denylist guard in `src/i18n/surfaces.test.tsx` against manual sentence capitalization in `MidiImportDialog.tsx`.
7. Added comprehensive unit tests in `src/interchange/midi-import.test.ts` and UI test across `en`, `et`, and `de` in `src/workspace/MidiImportDialog.test.tsx`.

## Verification
- `npm run typecheck` passed (exit code 0).
- `npx vitest run src/interchange/midi-import.test.ts src/workspace/MidiImportDialog.test.tsx src/i18n/` passed:
  - 6 test files passed, 257 tests passed (0 failures).

# THE-66: Sounding-destination overwrite for phrase paste (E08, Slice 1)

2026-11-10. Branch `agy/the-66-selection-clipboard` from `develop` (`d855761`).

## Context & Objectives

Issue **THE-66** addresses clipboard and selection scope across E02, E08, E09, and E11.
In the baseline clipboard implementation (`src/editor/clipboard-paste.ts`), phrase pasting strictly forbade placing notes into any measure or beat that contained sounding notes:
```ts
if (target.beat > firstVoice.beats.length || firstVoice.beats.slice(target.beat).some(beat => beat.notes.length)) {
  throw new Error('Paste a phrase into a trailing rest or empty suffix.');
}
```
This created a major discrepancy with Guitar Pro 8 and standard notation/DAW editing conventions, where pasting a musical phrase onto a sounding beat or chord overwrites the sounding notes at the target while retaining unaffected prefix notes, surrounding measures, and intact suffix notes.

**Slice 1 Objectives (E08)**:
1. Lift the artificial refusal when pasting a phrase onto a beat with sounding notes.
2. Implement sounding destination overwrite:
   - Pre-existing beats in `target.bar` prior to `target.beat` (`prefix`) are preserved intact.
   - Beats overlapping the pasted range `[pasteStartTick, pasteEndTick)` are cleanly replaced by the pasted beats.
   - Overwritten notes have their incoming/outgoing links (ties, slurs, slides, hammer-ons/pull-offs) cleanly severed using `detachNote` so no dangling or invalid link pointers remain.
   - Suffix beats starting at or after `pasteEndTick` containing sounding notes are preserved with their notes, ties, lyrics, and annotations intact, padded with rest beats if a rhythmic gap exists.
   - If suffix beats contain only rests, trailing rests are filled using `restBeats(capacity - onset)` to maintain standard dotted/clean rest decompositions.
   - Cross-measure spillover retains existing measure-reuse semantics: empty measures are refilled, and when untouched sounding music in subsequent measures is reached, an insertion occurs to avoid unintentional global destruction.
   - Surrounding notes, lyrics, and annotations at exact retained onsets remain intact.
3. Update i18n hints for `editor.paste_context_hint` across `en.ts`, `de.ts`, and `et.ts` to reflect that phrases overwrite sounding notes or fill rests.
4. Update tests and the parity tracker matrix (`docs/validation/2026-10-15-gp8-parity-progress.md` and `.json`).

## Delivered Changes

- `src/editor/clipboard-paste.ts`:
  - Replaced the sounding check with index validation `target.beat >= firstVoice.beats.length`.
  - Imported `detachNote` from `./links`.
  - Overwriting logic in `pastePhrase`:
    - Computed `pasteStartTick` and `pasteEndTick` for placed beats in each affected measure.
    - Detached all notes on beats falling within `[pasteStartTick, pasteEndTick)`.
    - Preserved `prefix` beats before `target.beat`.
    - Placed pasted beats and tracked `onset`.
    - Evaluated `hasSoundingSuffix = survivingSuffix.some(item => item.beat.notes.length > 0)`. If sounding notes remain after `pasteEndTick`, preserved them with their original note IDs and intact links, inserting padding rests if `firstSuffixTick > onset`. If only rests remain, generated clean rest decomposition via `restBeats(capacity - onset)`.
    - Filtered and revalidated links, cleanly detaching notes if intervening notes severed a tie or link.
- `src/editor/clipboard-paste.test.ts`:
  - Removed `'sounding'` from the rejection test `rejects free time, too-long beat and absent mappings without mutation`.
  - Added dedicated test `overwrites sounding destination notes, preserves prefix and sounding suffix, and detaches severed links` verifying:
    - Beat 0 prefix note remains with its original ID.
    - Overwritten beat 1 note receives pasted content (pitch/fret).
    - Severed tie from beat 0 to overwritten beat 1 is cleanly removed without error.
    - Suffix sounding beats 2 and 3 retain their original IDs and maintain their intact tie.
- `src/i18n/en.ts`, `src/i18n/de.ts`, `src/i18n/et.ts`:
  - Updated `editor.paste_context_hint` to reflect that phrases overwrite sounding notes or fill rests.
- `docs/validation/2026-10-15-gp8-parity-progress.md` and `.json`:
  - Updated E08 remaining gap to remove "sounding-destination overwrite".

## Verification

- `npx vitest run src/editor/clipboard-paste.test.ts`: 32/32 tests pass.
- `npx vitest run src/editor`: 83 test files (1,100 tests) pass.
- `npx vitest run src/i18n`: 4 test files (179 tests) pass.
- `npx vitest run src/editor/ClipboardPanel.test.tsx src/clipboard-interaction.test.tsx src/editor/clipboard-replay.test.ts`: 13/13 tests pass.
- `npm run typecheck`: clean TypeScript validation with no errors.

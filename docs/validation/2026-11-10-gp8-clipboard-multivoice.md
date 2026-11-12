# THE-66: Partial multi-voice slicing & phrase copy/paste (E02, E08, Slice 2)

2026-11-10. Branch `agy/the-66-selection-clipboard` from `develop` (`d855761`).

## Context & Objectives

Issue **THE-66** addresses clipboard and selection scope across E02, E08, E09, and E11.
Following Slice 1 (which delivered sounding-destination overwrite for phrase pasting), Slice 2 addresses partial multi-voice slicing and phrase copying/pasting.

In the baseline clipboard implementation:
1. `src/editor/clipboard-source.ts` strictly restricted phrase clips to a single voice lane:
   ```ts
   if (lanes.length > 1 && lanes.some(lane => lane.voice !== lanes[0].voice)) {
     throw new Error('Phrase selection must cover a single voice lane.');
   }
   ```
   and schema validation restricted phrase clips to exactly 1 voice per bar:
   ```ts
   array(bar.voices, 1, 1);
   ```
2. `makeMusicClip` only copied a single voice lane into `bar.voices[0]`.
3. `src/editor/clipboard-paste.ts` assumed phrase clips always had 1 voice and pasted into a single target voice lane.

**Slice 2 Objectives (E02, E08)**:
1. Allow single-track range/phrase selections across multiple voice lanes on the same staff (`staves.size === 1`, up to 4 voices).
2. Update clip structure validation to allow 1 to 4 voices in `bar.voices` for phrase clips.
3. Update `makeMusicClip` phrase slicing to extract each selected voice lane in `bar.voices`, preserving declared empty voice enforcement (`Mixed empty or partial voice lanes require complete-bar copying.`) and fermata/pedal filtering.
4. Update `pastePhrase` in `src/editor/clipboard-paste.ts`:
   - Validate destination contains all copied voices: `target.voice + v < staff.bars[target.bar].voices.length`.
   - Support multi-voice phrase placement: when `voicesCount === 1`, retain exact beat-by-beat placement across measure boundaries; when `voicesCount > 1`, place beats for each destination voice simultaneously across the phrase timeline.
   - Detach overwritten notes (`detachNote`) and preserve prefixes/suffixes per affected destination voice.
   - Scope mix automations and metadata annotations (`${index}/${destVoice}`) per affected voice without colliding or touching unaffected voices.
5. Update i18n text `editor.clipboard_single_hint` across English, German, and Estonian.
6. Provide comprehensive test coverage in `clipboard-source.test.ts` and `clipboard-paste.test.ts`.
7. Update parity tracker matrix (`docs/validation/2026-10-15-gp8-parity-progress.md` and `.json`).

## Delivered Changes

- `src/editor/clipboard-source.ts`:
  - Updated `validateStructure` to permit 1 to 4 voices in phrase clips (`array(bar.voices, 1, 4)`).
  - Updated `musicClipSelection`: in `singleTrack` mode, permitted multiple voice lanes on the same staff (`staves.size === 1`).
  - Updated `makeMusicClip`: sliced all selected voices in each measure over `[barStartTick, barEndTick)`, maintaining declared empty voice detection and fermata/pedal filtering.
- `src/editor/clipboard-paste.ts`:
  - Validates `target.voice + v < staff.bars[target.bar].voices.length` upfront.
  - Multi-voice phrase placement: when `voicesCount > 1`, iterates measures and places beats for each voice in parallel, tracking onsets per voice.
  - Suffix and prefix preservation per voice, cleanly detaching severed notes using `detachNote`.
  - Scoped `removedMix` to only target voices placed into, preventing duplication on untouched voice carriers.
  - Scoped `metadata` annotations per voice `${index}/${destVoice}` to prevent collision across voice 0 and voice 1 annotations.
- `src/editor/clipboard-source.test.ts`:
  - Added `copies a partial multi-voice phrase range on the same staff` verifying multi-voice extraction into phrase clips.
  - Updated description of declared empty voice rejection test to clarify intent.
- `src/editor/clipboard-paste.test.ts`:
  - Added `pastes a multi-voice phrase overwriting multiple destination voices simultaneously` verifying simultaneous voice placement and prefix/suffix preservation across voices.
  - Added `rejects pasting a multi-voice phrase when destination lacks the required voices` verifying clean refusal when destination staff has fewer voices than copied clip.
- `src/i18n/en.ts`, `src/i18n/de.ts`, `src/i18n/et.ts`:
  - Updated `editor.clipboard_single_hint` to indicate that single-track phrases require a single staff rather than a single voice lane.
- `docs/validation/2026-10-15-gp8-parity-progress.md` and `.json`:
  - Updated E02 and E08 remaining gaps to remove partial multi-voice slicing.

## Verification

- `npx vitest run src/editor/clipboard-source.test.ts`: 35/35 tests pass.
- `npx vitest run src/editor/clipboard-paste.test.ts`: 34/34 tests pass.
- `npx vitest run src/editor`: 83 test files (1,103 tests) pass.
- `npx vitest run src/i18n`: 4 test files (179 tests) pass.
- `npm run typecheck`: clean TypeScript check with 0 errors.

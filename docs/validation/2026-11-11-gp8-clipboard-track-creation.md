# THE-66: Track creation on multitrack paste (E09, Slice 3)

2026-11-11. Branch `agy/the-66-selection-clipboard`.

## Behavior

A multitrack bar clip can now be pasted into a score that has fewer tracks than the clip. A destination mapping whose track index is past the last existing track asks the paste to append that track.

- Only multitrack bar clips can create tracks. Single-track clips and phrases still need an existing track.
- New track indices must directly follow the existing tracks, in order (`n`, `n+1`, ...). A new track keeps the copied staff order (`staffMap` is `[0, 1, ...]`).
- A new track takes the copied instrument context from the clip: name, program, bank, volume, pan, percussion articulations, and per staff the tuning, capo, transposition, notation and tablature visibility, and percussion flag. It gets free MIDI channels (channel 10 for percussion) and is never muted or soloed. If no MIDI channel is free, the paste is refused.
- Measures outside the pasted bars are filled with rests in the destination meter. Each staff gets as many voices as the copied staff uses, and takes its clef from the copied first measure and its key from the first existing track.
- The new track is created on the detached candidate score, so a refused paste leaves the document unchanged. Paste and track creation are one history step.
- In the engine, each created track gets its own identity (`added/<edit>/paste/<k>`), so its mix and engraving settings never reuse another track's. Track-ordered GP interchange entries are forgotten, as for other track edits. Reopening and settings replay produce the same score and settings.
- The clipboard panel lists "New track N" in each destination track list for multitrack bar clips, and maps copied tracks without a destination to new tracks by default. Ctrl+V does the same. Staff choices for a new track are fixed to the copied order.

No protocol change: destination track indices were already plain `u32` values, and saved histories cannot contain out-of-range indices, because they were refused before.

## Tests

- `src/editor/clipboard-track-creation.test.ts`: instrument context, channels, rests outside the paste, unique IDs; refusals for skipped indices, reordered staves and single-track clips, with the destination unchanged; identities, reopen and settings replay.
- `src/editor/ClipboardPanel.test.tsx`: new-track default, option, disabled staff choice, dispatched mapping, and refusal of a skipped index.

## Verification

- `npx vitest run src/editor src/workspace src/clipboard-interaction.test.tsx`: 98 files, 1,335 tests pass (one benchmark skipped).
- `npx vitest run src/i18n`: passes.
- `npm run typecheck`: clean.

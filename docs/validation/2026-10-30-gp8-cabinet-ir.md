# GP8 parity A06: cabinet impulse responses (2026-10-30)

A track's cabinet can now use an impulse response the user imports. The row stays partial: see Limits. Timing tables and the review findings are in [the review-fixes note](2026-10-30-gp8-cabinet-ir-review-fixes.md).

## Behavior
- **Library:** a WAV is imported into a local library by the hash of its bytes. A document stores the identity, name and level trim, never the audio.
- **Sound:** the response replaces the built-in cabinet in playback and export, with a level trim.
- **Missing response:** the document opens unchanged, shows a notice and plays the built-in cabinet. Importing the same file restores it.

## Evidence
- **Merged branch:** 886 Rust tests passed, `tsc` was clean, `src/App.test.tsx` passed 143 of 143, and the rest of the suite passed 4,021 with 1 skipped; `src/editor/corpus.test.ts` is excluded from that run.
- **Desktop:** `tests/desktop/parity-cabinet-ir.mjs` passed on a Windows desktop-test build.

## Review
- **Hot path:** the first reviews rejected tail cost, all tracks working in one callback and a startup failure. A fresh review approved 4354d10, with fuzzing over 5.59M frames at a worst error of 4.7e-6 against direct convolution.

## Limits
- **Why partial:** no responses ship with the app, and the new rig view does not show this control yet.
- **Glitches:** a kernel join and a wake with unequal channels each do their work in one frame, so 8 tracks together can glitch once at small buffers.
- **Platforms:** macOS and Linux were not run, and the sound was not judged by ear.

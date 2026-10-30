# GP8 parity S22, S23: track interpretation (2026-10-30)

GP8 lets a track choose how it is played without rewriting the score. TabPlayer had no such setting. This slice adds one, following `docs/superpowers/specs/2026-10-24-gp8-track-interpretation-design.md`. Claude implemented it with an agent, had it reviewed three times, and ran it on a Windows desktop build. Both rows are partial: see Limits.

## Behavior
- **Settings:** the Sound task has playing style, palm mute intensity, strong-beat accent, automatic brush and automatic let ring for stringed tracks.
- **Storage:** each change is one `setTrackMix` edit, so it is undoable and stays usable on a finalized score. The score is never rewritten.
- **Written marks win:** written palm mutes, pick strokes, finger marks, brushes and bends outrank a setting.
- **Older projects:** a track with no setting plans exactly as before.

## Evidence
- **Rust:** 850 tests passed on the merged branch, none failed.
- **Frontend:** `tsc` was clean. At a9b2675, `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout, and the rest of the suite passed 3,831 with 1 skipped; `src/editor/corpus.test.ts` is excluded from that run. After the brush fix, `src/audio` passed 830 with 1 skipped.
- **Desktop:** `tests/desktop/parity-track-interpretation.mjs` passed on a Windows desktop-test build. Each setting was one undoable edit, undo and redo restored the record, and each setting's exported WAV differed from the default and from every other setting. A heavy palm mute measured softer, a strong accent louder, and let ring longer in the first half. Clearing every setting returned the default export byte for byte.

## Review
- **First review:** rejected for accent bugs.
- **Second review:** rejected the fix, which made focus 30 times slower.
- **Third review:** approved, with a later fix that measures a pickup by its heard bar across all parts.
- **Desktop run:** found a real bug that no unit test had. A chord would not brush when one of its notes was played again straight after it, because a flat pitch point at the note's end counted as a bend. Brushable now means a flat pitch curve, a point at the note's end stays there, and a regression test pins both. The earlier driver failures were in the fixture and in `check()` on a controlled checkbox.

## Limits
- **Why partial:** there are no picking or slap voices, so those GP8 styles are not offered.
- **Project only:** the settings are not read from or written to GP files.
- **Audition:** note audition follows the style only.
- **Tuplets:** accents allow 7 ticks of drift, so a heavily nested tuplet may miss one.
- **Playback:** changing a setting prepares playback again, which stops it and clears any loop.

# A18 master effects

## Behavior

A song now has a master chain: level, balance, compressor, EQ, reverb and limiter. It is one undoable `setMaster` edit, saved with the document, and heard in playback and export alike. The strip is in the Mixer dock. Tracks and the backing pass through the whole chain. The playback click joins at the limiter and the count-in click stays outside it. A chain left at its defaults is bit-identical to no chain at all.

## Evidence

- Merged test run at e7d220c: `tsc` clean; `App.test.tsx` 143 of 143; the other Vitest files 4042 passed, 1 skipped; 908 Rust tests passed, including `audio_master`.
- Desktop driver `parity-master-effects` passed in the real app: -6 dB took the export from -6.57 to -12.57 dB; a -10 dB limiter held it to -10.00 dB; undo restored all 576000 samples exactly; the level changed while playing without stopping playback; reset is one edit.
- The driver's first run failed on its own limit. Export adds triangular dither of up to one step before rounding, so a held ceiling can read up to 1.5 steps over. The driver now allows that; the limiter did not change.

## Review

Hot-path Opus review rejected the first version over a subnormal cost in silence, then approved e1e018e with no High or Medium findings. Measured there: at 300 s of silence the worst case fell from 1785 to 112 ns per frame; playback and export differ in 0 of 192000 frames; a change of settings makes 0 heap operations; the limiter's output never passed its ceiling. Two wrong statements it found (the click path and the reason for the export's hard tail) were corrected afterwards.

## Limits

- Windows x86-64 only, on local Rust rather than CI's 1.88.0 for the probes.
- The chain was measured, not judged by ear.
- The export's effect tail is a hard cut: a long reverb stops abruptly unless the tail is lengthened. Playback renders no tail at all.
- Tracks keep their subnormal tails, which is unchanged from before. That cost on a single track was not timed.
- The strip is not yet placed in the Sound view's rig slot.

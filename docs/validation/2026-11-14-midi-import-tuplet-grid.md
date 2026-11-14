# THE-210 Validation: MIDI import refused some unquantized drum playing

**Date**: 2026-11-14
**Branch**: `agy/the-210-midi-tuplet-grid`

## Trigger
Running the body of the random import test over seeds 1 to 60 (7200 rounds) refused 15 rounds with "A rhythm in this file could not be placed on the tuplet grid." Over seeds 1 to 400 (48000 rounds) 109 were refused. Every refused round was on the percussion channel, with 4 voices allowed, a tuplet mode other than `none`, and a time signature whose bar is not a whole number of quarter notes (5/16, 7/16, 11/16, 13/16, 10/32, 13/32). The search found quantization 8 (79 rounds), 16 (28) and 32 (2); the absence of other values elsewhere is an artefact of how often the generator draws them, not a limit of the fault. 1/32 triplets fail the same way (13/32, three hits). One hit is enough for the smallest cases:

- 13/32, 1/8 quantization, triplets: one hit `[start 2789, length 480 ticks]` at 480 ticks per quarter.
- 5/16, 1/8 quantization, triplets: one hit `[1706, 248]`.
- 13/32, 1/32 quantization, triplets: three hits `[1016,38]`, `[1176,27]`, `[696,35]`.

The hit starts in the short last quarter of a bar. Its end used to lie in the next bar and snapped onto a triplet grid chosen for that bar's first quarter.

## Cause
`src/interchange/midi-import.ts`, the percussion branch of `importMidi` (about line 283). A drum hit lasts to the end of its quarter note, counted from its own bar line. In a bar of a non-whole number of quarters, or a bar shorter than a quarter, that quarter runs past the bar line, so the hit's end lay in the next bar or bars. Two things followed:

1. In every case without a tuplet the hit tied across the bar line into a small stub in the next bar (for 13/32 at 1/8 with tuplets none: a 90-unit tied stub).
2. If the next bar's first quarter was chosen as a triplet or quintuplet grid (`chooseLattices`), the end was not a multiple of that grid's step. The span was written as a tuplet and the placement check in the beat-building loop (`Number.isInteger(slots)`, line 337) refused the whole file.

## Fix
A drum hit's end now never passes its own bar line: `Math.min(spanStart+SPAN, bar end, next onset, total)`. One expression, uniform, O(hits), no search, no report note (a drum symbol has no meaningful length, so a player needs no telling).

**This changes existing output for drum tracks in bars that are not a whole number of quarters, including files that imported before: the tied stub in the next bar disappears and the hit ends at its bar line.** Pitched notes, and drum hits in bars of whole quarters, are unchanged.

An earlier version of this change only shortened the hit when its end was off the tuplet grid and added an import note (`simplified_rhythm`). It was replaced because it treated one symptom, left the tied stub in all other cases and made the result depend on unrelated hits in the next bar. The note and its en/et/de strings are gone.

## Is the refusal at line 337 reachable?
Reasoning: a piece is cut at every bar start and at both ends of every span that has an off-quantum chord point, so the only interior cut points of a span are chord starts and ends. A chord start comes from `snap`, which lands on the span's own grid. A pitched end comes from `snap` too, or `min(.., bar end)`, `start + lattice step` or another chord's start. A drum end is now a snapped onset, a span end or a bar end. A bar end lies in a full span only at its edge; a partial last span never has a tuplet grid. So every interior point of a tuplet span is a multiple of its step, and `slots` is an integer. I found no input that reaches it.

Search, run after the change (a scratch test, not committed): 60000 random files from seeds 1 to 1000, with divisions 96, 192, 480 and 960; numerators 1 to 32 over denominators 1, 2, 4, 8, 16 and 32; a second meter change in half of them (30035 files); pitched only, drums only and both (19954 files with two note tracks; 40063 files with a drum track); every quantization, tuplet mode and voice count. Result: 0 refusals, 0 other errors, 0 bars not exactly filled. The same search against the importer before the change refused 342 files, so it can find the fault. The earlier 48000-round search of the original random test (seeds 1 to 400) also gives 0 refusals.

The throw stays as an internal-consistency error. It cannot hang or corrupt (it throws before any beat of the piece is built). THE-210's third question, whether the message matters, is closed: it can now only appear for an internal error, so the wording is not a user concern.

## Other refusals an ordinary file can still hit (no change)
- More than 3000 measures (`MEASURE_LIMIT`, `midi-import.ts` line 69).
- More than 32 instrument parts (`TRACK_LIMIT`, line 223).
- "no notes this import can read" (line 358): for example a file whose only notes are unmapped drum keys on channel 10. `midi-smf.ts` line 146 refuses a file with no notes at all.
- `midi-smf.ts` limits: files over 8 MB, over 60000 notes, over 2,000,000 events; RIFF-wrapped files, format 2 and SMPTE timing; malformed files.
- "does not fit a 64th-note grid" (line 178) is also kept; no length below 15 units can occur at the finest quantization.

## Verified
- Tests: the three minimal triggers; 13/32 at 1/8 with no tuplets (no tied stub, bars exact, the hit only in its bar); a mid-file change to four bars of 1/16 with a hit spanning several bars at every quantization and tuplet mode; an on-grid hit end inside a triplet quarter, unchanged; eight formerly refused rounds named by seed, round and meter, each checked for percussion, hit count and no note crossing a bar line, with a Guitar Pro round trip.
- Pitched rounds of seeds 2, 3 and 5 are fingerprinted beat for beat with the import report. The fingerprints came from running the same loop against a scratch copy of `midi-import.ts` as it is in HEAD before the change. Drum rounds check invariants only (bars exact, hit count preserved, nothing crossing a bar line).

## Limits
- No real sequencer MIDI file was tried; no committed fixture covers one. Evidence is generated input only.
- Drum hits in odd meters lose the part of their length that crossed the bar line, a change in existing output.

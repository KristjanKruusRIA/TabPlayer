# Tremolo guard and unequal-pickup lanes (2026-10-30)

A tremolo-picked beat could make alphaTab 1.8.4 add MIDI attacks without end, freezing the window or exhausting memory. Separately, a track with a shorter pickup than another track could not be planned once it played after the pickup.

## Cause
- **Tremolo:** `_generateTremoloPicking` steps `getDurationAsTicks(duration) * beatDurationFactor` ticks along the note and never ends when the step is zero, negative or not a number. That happens for:
  - a beat whose grace notes took all its time, with its note tied or slid onward;
  - a 128th with 5 marks or a 256th with 4 or 5 marks, whose step truncates to 0 ticks, with no grace note and no tie;
  - a tremolo with no mark count (MusicXML `<tremolo/>`).
  A tiny positive step does end, but adds attacks by the hundred thousand.
- **Every route calls that one method:** the playback plan, drawing (`loadMidiForScore` on the main thread), MIDI export, score timers and reference-sync positions.
- **Pickup:** the public generator sizes a pickup bar from the staves it is given, so a per-track lane starts every later bar earlier than the complete score does. Attacks and the bends carried across the gap were read on the wrong clock.

## Behavior
- `src/tremolo-guard.ts` wraps that one method, once, with no audio or editor dependency. It is imported by each module that generates, loads or renders MIDI, and a test lists them.
- Outside the failing cases the original method runs unchanged. A guarded tremolo plays the plain note the beat would play without the effect. The document keeps the tremolo.
- **Limits:** 16,384 attacks for one beat, 100,000 for one generation.
- **Lanes:** the lane clock is mapped onto the complete score's per bar for attacks, and for the bends of a note by the bar it begins in (a note keeps its own clock where it runs on). A lane whose bar count differs from the complete score's is refused.

## Measurements behind the limits
- The seven Guitar Pro fixtures hold no tremolo. Three marks on a quarter add 8 attacks. A whole note with 5 marks adds 32 per bar, so 16,384 is about 500 tied bars.
- A plan costs about 3 KB per attack: 51,200 attacks took 2.9 s and 179 MB, 102,400 took 7.7 s and 309 MB, and about 125,000 notes fail outright with a stack overflow in the plan's `Math.max(...)` spread (existing, not addressed).

## Evidence
- Tests: `src/tremolo-guard.test.ts` and `src/audio/plan.unequal-pickup.test.ts`.
- Against `bad6439` (the plan from the base source and from this source, same scores):
  - 2,500 random scores of up to three tracks and two staves, with repeats, pickups, graces, tuplets, ties, bends and tremolos: the guard acted on 61. Of the 731 the base planned and the guard left alone, all 731 plans are byte-identical. None failed that the base planned.
  - 7,000 random multi-track pickup scores of clean quarter notes with bends and ties: the base planned 2,003 and the head planned 2,001 identically. The other 2 differ in `pitch` only, and both are the bend defect fixed here (a tied note with its own bend after the pickup gap; the base put that bend early). The base could not plan the other 4,997; the head plans them.
  - The existing golden `plan.pickup-performance.test.ts` (a bent note tied across the gap) is unchanged, because a note's own bend keeps its own clock.
- The guarded and unguarded generators write the same MIDI file for tremolos they can sound.

## Limits
- A guarded tremolo is not reported to the person. No document notice path exists for it; `collectUntimedTremolo` returns the beats for a caller that wants one.
- The generation limit counts per generator run. A lane run counts fewer attacks than the complete run, so a score past the generation limit can still be refused by the plan with a clean error rather than an out-of-memory.
- Repeats multiply a bar's attacks and are counted as they are generated.

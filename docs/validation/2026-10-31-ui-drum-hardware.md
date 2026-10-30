# Drum hardware for every tabbable hit

## Behavior

The drum view is a three-quarter studio kit with 17 pieces: two kicks, six toms, snare, hi-hat and seven cymbals on a tom rack and boom stands. A scrolling Percussion row below it holds 35 more instruments, each with its own drawing. Every standard articulation in `src/editor/percussion-catalog.ts` belongs to exactly one piece. Pressing a piece enters its plain hit, or removes whichever of its hits the beat holds. When a piece with several hits has focus, a row of named hits appears (for example rim shot, side stick) and each one enters or removes that hit alone.

## Evidence

- `npx tsc --noEmit -p .` passes and `npx vitest run src/instruments` passes 79 of 79.
- The new test proves 94 distinct articulation ids map one to one onto instruments, every percussion instrument has a drawing, and no sounding pitch lights two instruments.
- Busy refusal of the named hits and focus staying available are covered by test.
- Kit and percussion drawings were reviewed in rendered screenshots from the real components.

## Review

Pending. Not yet reviewed by a fresh reviewer.

## Limits

- Not yet run in the built app, and `tests/desktop/instruments.mjs` was edited without being run.
- During playback only a pitch is known, so instruments that share one light once or not at all: cowbell low and high (56, lights Cowbell), maraca right (70), bell tree, jingle bell, grancassa, piatti, reverse cymbal, metronome and golpe. In edit mode they are identified exactly.
- The kit is seen as one fixed layout. It does not change with the track's own articulations; custom ones attach to a piece by pitch.

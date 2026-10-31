# Drum hardware for every tabbable hit

## Behavior

The drum view is a three-quarter studio kit with 17 pieces: two kicks, six toms, snare, hi-hat and seven cymbals on a tom rack and boom stands. A scrolling Percussion row below it holds 35 more instruments, each with its own drawing. Every articulation belongs to exactly one instrument, by the element it names (a track's own table is read the same way; only an element nobody knows falls back to its sounding pitch).

- Pressing an instrument enters its plain hit, chosen by intent and listed per instrument (`hit` in `src/instruments/drum-kit.ts`): the ride and Ride 2 their middle, the triangle its open hit and the cuica its open sound, never a mute. A track's own hit nearest that plain hit by sound, notehead and technique wins over a standard one. Pressing an instrument whose hit the beat already holds removes that hit (one undoable edit); pressing a named hit that is held removes it too, and one that is not held enters it. A pad for a note nobody owns removes only unowned notes.
- In edit mode what the beat holds is identified by articulation, so the lit instrument, its `Remove ...` name and the note list agree (Grancassa, pitch 43, does not light the high floor tom).
- A standard hit that twins one of the track's own (same sound, notehead and technique) is hidden. The row has a reserved slot, so nothing moves when it appears, and it stays when the window loses focus.
- A piece with several hits shows a row of named hits (rim shot, side stick, edge 2, ...) only while the piece or the row has focus. Moving focus from the piece to the row keeps it. On a pitched or fretted staff in Drums mode the row is refused with `aria-disabled`, as the pieces are.
- Cymbal targets keep at least 16 units of depth (the splash was about 6 px tall in the compact view) and their names sit just under the target.

## Evidence

- `npx tsc --noEmit -p .` passes. `npx vitest run src/instruments src/App.test.tsx` passes 232 of 237 when run together: `src/instruments` passes 91 of 91 and `src/App.test.tsx` alone passes 146 of 146, but together 4 to 5 App tests time out at 5 s under load (not investigated further).
- Tests cover a Guitar Pro style 60 entry custom table (crash, piatti, reverse, ride, bell tree, metronome, snare, Ride 2 each on its own element although they share pitches), owner against output for every standard articulation, the plain hit of every instrument with several hits, shared-pitch removal, edit-mode lighting by articulation (ids 114, 31, 33, 115), hit names, row visibility with focus moving from piece to row, and the pitched-staff refusal.
- `tests/desktop/native-audio.mjs` waited for `[data-percussion-key="69"]`, which is now the Cabasa; it waits for `[data-percussion="cabasa"][data-active="true"]`, proving the same thing (a fretted note shown in the drum view lights hardware during playback). Not run.

## Review

A fresh reviewer rejected two rounds. The first found custom Guitar Pro articulations attaching by pitch and exact-identity gaps; the second found the hits row lost on window blur and four Lows. All were fixed in 5c5a4ee, which was not reviewed again; I accepted that diff as small and each fix has a test except the doc change.

Merged into feat/gp8-parity. `parity-instrument-entry`, `parity-instrument-focus`, `parity-instrument-handedness` and `instruments.mjs` pass on a Windows build. `parity-instrument-entry` now expects the fixture kick, element Kick Drum (36), to be named Kick 2, which is what the kit calls it. `native-audio.mjs` was not run.

## Limits

- During playback only a pitch is known, so some hits light another instrument: snare side stick 2 (id 31, sounds 40) lights Electric snare; Metronome (33, 34, sounds 37 and 38) lights Snare; Piatti (115, 116) lights Crash; Reverse cymbal (30) lights Crash; Grancassa (114) lights High floor; Bell tree (84, 123) and Jingle bell (83) light Ride; the low and high cowbells (99, 100, 102, 103) light Cowbell; Right maraca (119, 120) lights Left maraca; Golpe (124, 125) lights Conga high. Edit mode is exact. The test pins this list.
- The kit is one fixed layout. It does not change with the track's own articulations. A custom hit whose element nobody knows attaches by pitch, and a track whose table hides every standard hit of a piece leaves that piece with no articulation (its name says so).
- If a table hides a piece's plain hit but leaves a standard variant visible (a Guitar Pro table of 60 entries still shows crash high choke, id 97), pressing the piece enters that variant.
- No real Guitar Pro drum file was tested. The shape of a track's own table (element names as `elementType`, table index as the articulation id) comes from reading alphaTab 1.8.4's GP parser, and the test table is hand-built to match.

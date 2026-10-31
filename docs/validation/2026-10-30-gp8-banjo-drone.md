# GP8 parity S20: banjo short drone (2026-10-30)

GP8 offers a short drone string on a 5-string banjo. TabPlayer treated the fifth string as a full-length string. This slice adds a drone setting to the staff. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-banjo-drone-design.md`. Claude implemented it with an agent, had it reviewed three times, and ran it on a Windows desktop build. The row is partial: see Limits.

## Behavior
- **Setting:** the Staff panel has a Banjo drone control, for 5-string staves only, with string 1 tuned above string 2.
- **Rule:** with a drone at fret 5, fret 0 is open, frets 1 to 5 do not exist on that string, and fret 7 sounds two semitones above open.
- **Edits:** no new edit command. `setStaffSettings` and `addStaff` take an optional `droneFret`.
- **Missing frets:** they are refused when entered, and never offered by fingering, transposition, string moves, paste or chord search. A range edit re-fingers where it can.
- **Coverage:** playback, audition, notation, the instrument view, ASCII heading and exports follow the rule.
- **GP and MusicXML files:** the drone is never read from a file. Export writes the same sound with the short string's frets counted from its own start, so a reopened GP file is a plain banjo with the same pitches.
- **Older projects:** projects with no drone replay unchanged.

## Evidence
- **Rust:** 849 tests passed on the merged branch, none failed.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 143 of 143 alone at a 60-second timeout. The rest of the suite passed 3,808 of 3,809 with 1 skipped; `src/editor/corpus.test.ts` is excluded from that run.
- **Review comparison:** across five tunings with plain, capo and partial capo setups, 2,587 result rows on staves with no drone matched the base commit. Older logs with out-of-range trills opened through full replay.
- **Desktop:** `tests/desktop/parity-banjo-drone.mjs` passed on a Windows desktop-test build of the merged source. It set a drone from the Staff panel, compared the pitches the instrument view showed before and after, and checked missing frets were refused.

## Review
- **First review:** rejected. Ordinary paste, refinger and transpose on a drone staff were refused, an open drone could not move up, moves across the string failed, MusicXML export refused any drone staff, and chord search offered missing frets.
- **Second review:** rejected the fix. A new trill check ran on every staff and could stop a rare older project opening. It now runs only when the drone changes a trill's pitch, and a full replay test pins this.
- **Third review:** approved, with no High or Medium findings.
- **Desktop run:** the first runs failed in the driver, on the fretboard's role and the wait order.

## Limits
- **Why partial:** how GP8 stores the drone, and whether it numbers frets this way, is unconfirmed, because no GP8 banjo file was available. A GP8 file that stores a drone reads here as a plain staff.
- **One drone:** one per staff, always string 1.
- **Natural harmonics:** one at neck fret 12 sounds 74 in the app and 79 after a GP reopen.
- **Chord diagrams:** they are not converted on GP export, and a pasted diagram or an existing one under a new drone can sit on a missing fret. Transposed open shapes can draw a dot one row below the 5-row grid.
- **ASCII tab:** re-import reads fret 7 as a plain fret.
- **Tab display:** a trill on the drone string shows its plain fret, for example `(2)` rather than 7.
- **Older builds:** a log using `droneFret` does not open in builds before this one.

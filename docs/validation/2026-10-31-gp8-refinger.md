# Validation Report: Keep Pitch on Retuning and Capo Change (S19)

## Behavior

- **Option to Keep Sounding Pitch (`keepPitch`):** Optional `keepPitch?: boolean` on `setTuning` (`{ type: 'setTuning', track, tuning, tuningName?, keepPitch? }`) and on `StaffSettings` (used by `setStaffSettings` and `addStaff`; it means nothing for `addStaff` and the interface never sends it there).
- **Default Preserved:** When `keepPitch` is `false` or omitted, frets are kept and sounding pitches change, exactly as before. Old projects replay unchanged.
- **Sounding Pitch Calculation:** With `keepPitch`, notes are refretted to the same sounding pitch under the staff's current transposition:
  pitch = tuning[tuning.length - s] + fret + stringCapo(s) + droneShift(s, fret) - transposition
- **Transposition is not compensated.** Keep pitch compensates for tuning, capo, partial capo and the banjo drone. Changing the sounding transposition in the same edit changes what sounds, as it does without the option; frets are not moved to cancel it. The resulting pitches are range-checked (0 to 127).
- **Trills** store an absolute pitch. Refingering keeps the sounding pitch, so trills are left alone; the usual trill rebasing for a partial capo or drone change is skipped when `keepPitch` is set.
- **Chord diagrams** follow their strings: each fret is recomputed for the same pitch. Finger marks are cleared for strings that moved differently (a barre is kept only when every played string moved equally). A diagram string no fret can reach refuses the edit and is listed.
- **Unreachable Notes Reported:** If a note cannot be placed within the playable fret range (0 to max(24, old fret)) on any candidate string, every such note is listed with its staff, voice, bar, real beat number (grace beats do not count; a grace note reads "grace note before beat N"), string and pitch name, and the reason: no string reaches the pitch; a harmonic cannot move; a tied, slid or hammered note cannot leave its string; or the beat's notes have no free strings for all of them. The text comes from the interface language (`en`, `et`, `de`). Nothing is dropped silently and no partial edit is committed.
- **Chords and voices:** Bipartite matching (`placeBeat`) gives every note of a beat its own string. Beats of other voices that sound at the same time (overlapping `playbackStart` and `playbackDuration` in the bar) are placed first-come and their strings are kept free, so two voices never land on one string at one moment. A string two voices already shared before the edit may stay shared.
- **Note links:** Ties, hammer-ons, pull-offs and slides must keep the next-note relationship on their string (`holds(...)`); a link that held and would no longer refuses the edit.
- **Interface:** `TrackSettingsPanel` and `StructurePanel` have a "Keep pitch" checkbox (`KeepPitchBox`). It sits outside the busy fieldset and uses `busyGuard`, so it keeps focus while an edit is pending. It resets when the staff or track changes and when another document opens, and the flag is never sent for a staff with no strings or with Add staff. Applying the tuning or staff settings the staff already has records nothing, ticked or not.
- **Undo and replay:** One gesture is one undoable edit. Undo restores frets and tuning; redo restores the refingered frets.

## Evidence

- `src/editor/refinger.test.ts` (24 tests): tuning, capo up and down, partial capo removal, a trill under a partial capo, banjo drone, ties, slides, hammer-ons, bends, grace notes, harmonics (refused when they would move, kept when not), chords of one beat, overlapping voices, chord diagrams, transposition left alone, range check on a staff with no strings, the unreachable-note messages, undo and redo, and a seeded fuzz of 40 random two-bar scores with ties and random tunings that checks every sounding pitch, tie and string, or a clean refusal.
- Panel tests in `src/editor/panels.test.tsx` and `src/workstation/TrackSettingsPanel.test.tsx`: the box resets on another staff, is not sent with Add staff, keeps focus and value while busy, and applying current values records nothing. Existing tests that applied unchanged values only to check the draft tuning name now change a value first.
- Wire format: `keepPitch` is in `tests/protocol.json` (82 entries) for `setTuning` and `setStaffSettings`; `src/parity-commands.test.ts` checks it is an optional boolean there only; the Rust `protocol` test round-trips both.
- Commands run for this report: `npx tsc --noEmit`; the full Vitest suite with `--testTimeout=60000 --maxWorkers=3`; `cargo test --locked -j 2 --test protocol`. The results are in the commit report for the branch, not restated here.

## Review

Independent review of the first version found these. All are fixed on this branch, each with a test that fails without the fix:

1. A trill's pitch moved when a partial capo and Keep pitch were applied together (it was rebased a second time).
2. Two notes could land on one string at one moment across voices.
3. The flag went stale (not reset on staff or document change), skipped the pitch-range check on staves with no strings, and was written into Add staff edits.
4. The unreachable list gave only bar and a raw beat index; it is now actionable and localized.
5. The checkbox sat in a disabled fieldset and lost focus when busy; it also used an unstyled class.
6. Applying the current tuning or staff settings recorded an edit.
7. Chord diagrams were not remapped; changing the transposition with the box ticked moved frets to cancel it (now pinned the other way).

## Limits

- **Not verified in the desktop app.** Only unit, component and engine tests ran. No screenshot, keyboard or real-shortcut check of the checkbox, its focus behavior or the messages was done.
- **`setStringCount` has the same cross-voice gap.** It places notes per beat per voice, so notes of two voices that sound together can still land on one string when the string count changes. It was not changed here.
- **What is refused (the whole edit, nothing applied):** a note no string can reach within fret 24 (or its own higher fret); a harmonic, or a tied, slid or hammered note, that would have to change string or fret; a beat whose notes cannot all have their own string, counting the strings other voices use at the same time; a link that held on its string and would no longer; a chord diagram string no fret reaches; a result outside MIDI pitches 0 to 127.
- **Relocation ceiling:** the highest relocated fret is 24 above the open string, or the note's own fret if it was already higher.
- **Dead notes** have no pitch and keep their written fret.
- **Banjo drone string:** string 1 has only the open string and frets above the drone fret; frets 1 up to the drone fret do not exist and are never chosen.
- **Chord diagram fingering:** finger marks are cleared when strings moved by different amounts. Theory chord names are re-checked by the existing chord-source rules and fall back to manual if they no longer match.
- **Voice order:** voices are placed in index order, so a later voice moves around an earlier one; another order might fit a crowded case that is refused.
- **Not changed:** the parity progress files, `tone.rs`, generated directories, and `setStringCount`.

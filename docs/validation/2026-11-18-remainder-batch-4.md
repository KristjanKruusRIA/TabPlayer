# Left-over items, batch 4 - validation, 2026-11-18

Branch `agy/remainder-batch-4`, cut from `develop` at `43ac089`. Five items, each implemented by one engineer and reviewed by a second,
read-only one; findings were fixed and re-reviewed until approved (drag reorder twice, fade and dialog help once each). The final checks
were run by the orchestrator on the final tree. Nothing here was tried in the desktop app, and nobody listened to or looked at anything.

## What changed

| Item | Change |
|---|---|
| Fade on an automated track (tracker row T26) | A fade in, fade out or swell on a track under volume automation ramps from the level in force, not from the written track volume, in playback and in MIDI export, so the level no longer jumps at the fade start. A fade that starts where another ends opens where it should. Tracks without volume automation are unchanged (golden hash test). The three series the renderer test plays are in `tests/fixtures/fade-automation-series.json`, which the plan test asserts the plan produces. |
| MusicXML export of drum tracks (row F13) | A single-staff percussion track is written as a percussion part: percussion clef, one instrument per drum sound with its key and channel, unpitched notes on the staff line the app draws them on, note heads where one is defined, and rhythm, ties, tuplets, voices, dynamics and repeats as for pitched parts. Pitched output is byte-identical to before on the seven real files of the compatibility set. |
| F1 inside dialogs (row W21) | F1 in the Export, MIDI import, ASCII import and Batch convert dialogs opens the help at the dialog's topic, above the dialog and without closing it. Escape closes the help first; focus returns to where it was, or to the dialog's first enabled control when that control has gone. |
| Chord and scale audition (rows U04, U06) | "Play chord" beside the chord diagram strums the sounding strings low to high through the track's sound; "Play scale" in the scale panel plays the scale ascending. Both use the existing note audition command (no native change), only while the transport is stopped, and record no edit. |
| Drag reorder of tracks (row S03) | A track row in the dock overview has a grip: drag it to a new position (one undoable edit however far it moves), or press Alt+Up / Alt+Down on it. Dropping in place or pressing Escape records nothing. Focus and the active track follow the moved track. No edit type changed. |

## Review findings and how they were settled

- **Fade.** Medium: a fade in or swell starting on the tick where an earlier fade ended still opened at the full level. Fixed. Low,
  fixed: the renderer test played typed-in series with no tie to the plan.
- **Dialog help.** High: over the two import dialogs the help was painted underneath the dialog. Medium: after a batch run finished with
  the help open, focus was lost. Both fixed; approved.
- **Drag reorder.** Round 1, medium: after a move the focus stayed on the row position, so the keyboard path could not move a track more
  than one row. Round 2, medium: Escape did not cancel a drag while the pointer was over the starting row. Both fixed; approved.
- **MusicXML and audition:** approved at the first review with low findings only.

## Checks (orchestrator's run, on the final tree)

- `cargo fmt --all -- --check`: clean. `npm run typecheck`: clean. `node scripts/secret-scan.mjs`: 0 findings.
- `cargo test --locked --workspace --no-fail-fast`: exit 0, 100 test programs passed.
- Real-helper suites, `--ignored --test-threads=1`: all six programs passed.
- `npm test -- --testTimeout=60000`: node tests 78 pass; `Test Files 465 passed | 4 skipped (469)`, `Tests 7787 passed | 5 skipped (7792)`.
- Not run locally: the release resource-budget test (CI runs it).

## Limits

- Fade: fades of two voices of one track, or of the two channels of a track, still share a channel and interleave. A track whose written
  volume is 0 but whose automation raises it still fades from the written level (found in review, existed before). A volume move inside
  a fade is a step, as volume automation is breakpoints only. The curve was not compared with Guitar Pro's.
- MusicXML: re-import through the app's own reader keeps key, staff line and length but not the standard sound id, so open and half-open
  hi-hat stay apart only by instrument; heavy-X and circle-slash heads come back as plain x and circle-x. A key outside 0 to 127 in a custom
  sound table is not range-checked. Not validated against the schema file or opened in another program. Grand staff, more than four
  voices and the other refused cases are unchanged.
- Dialog help: the stacking and the focus return were tested by document order and with a faked lost control; nobody has seen the help
  above a dialog in the real app.
- Audition: the strum spread, the hold and the scale's range are choices nobody has heard. A chord or scale of more than 12 notes plays the
  first 12. The Play scale button stays visible but inert for a percussion staff.
- Drag reorder: pointer capture, touch and the look of the grip and drop line were not tried in the real window; no edge scrolling; the
  grip is only in the dock overview rows.
- Estonian and German strings were written without a native review.

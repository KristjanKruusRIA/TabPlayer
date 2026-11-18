# Batch 5 and a new real-app driver - validation, 2026-11-18

Branch `agy/remainder-batch-5`, cut from `develop` at `e84bff1`. Each item was implemented by one engineer and reviewed by a second,
read-only one, with fixes until approved. The final checks, the rebuild of the desktop test app and the driver runs below were done by the
orchestrator on the final tree. Windows only, silent output; nobody listened to anything.

## New driver: `tests/desktop/parity-recent-controls.mjs`

Checks, in the real app and on a score it authors (guitar, bass, drums), the controls added on 17 and 18 November:

- Track reorder: a drag of the grip is one edit and one undo; a drop in place and Escape record nothing; Alt+Down moves the track and keeps
  focus on its grip; every dock row has exactly one fader after a move.
- F1 in the Export dialog opens the help above it; Escape closes the help only, and the dialog keeps its state.
- Export options: "Include count-in" is unchecked and unavailable with no count-in bars, enabled and unchecked for the five audio file
  types once the practice settings have bars, and absent for stems; "Apply drum maps" is off by default, changes the exported keys when a
  map row changes a key (five snare hits move from 38 to 52), and gives identical bytes when no map is set.
- Play chord and Play scale raise the native audition counter and the rendered peak with the transport stopped and record no edit; Play
  chord is inert with every string muted.
- Trim to fit announces a shortening, records one `fitVoice` edit with `shorten`, leaves the note as a quarter, and one undo restores it.
- The ASCII export holds the six labelled drum tab lines.

On its first runs it failed on two product defects, which are fixed in this batch; it now exits 0.

## Defects found by the driver and fixed

- **Doubled mixer controls after a track move.** After any change of which track a dock row shows (drag, Alt+Down, the Move up and Move
  down buttons, undo of a reorder) every row had two volume faders and two pan knobs, and the row's controls were garbled. Cause: the
  fader and the knob of a row were siblings with the same React key (since `9c4c47b`, 14 November), so the reconciliation lost track of one
  of them and left its node behind. Fixed with distinct keys; `src/TrackPanel.dock-rows.test.tsx` failed before the fix ("expected 2 to
  have a length of 1").
- **Stale count-in text.** The Export dialog said audio export does not include the count-in right above the new option, and the help said
  the same. The dialog now says what is still not included, where the count-in bars come from and why the option is unavailable when the
  practice settings have none; stems still say they include no count-in. The help paragraph is corrected. en, et, de.

## Other items

- **Play right after setting a loop** (found by the sweep): the playback controller remembers the loop it asked for until the native status
  shows it or refuses it, so Play uses it; Play right after clearing a loop no longer uses the old one. A fake bridge with a lagging status
  reproduces both.
- **New-score defaults on the blank startup score** (tracker row L06): the score the app creates at start, and the blank tab left when the
  last score is closed, carry the stored defaults, through the same constructor as New. Review, high, fixed: such a blank tab was no longer
  replaced when a file was opened, because it carries a metadata baseline edit; an untouched blank whose baseline holds only that is
  replaceable again.
- **Fade on a track written at volume 0 with volume automation:** the fade now ramps relative to the level in force, in playback and in MIDI
  export. Tracks without volume automation and tracks with a written volume above 0 give the same plan as before (golden hash and the
  fixture untouched).

## Checks (orchestrator's run, on the final tree)

- `cargo fmt --all -- --check`: clean. `npm run typecheck`: clean. `node scripts/secret-scan.mjs`: 0 findings.
- `cargo test --locked --workspace --no-fail-fast`: exit 0, 100 test programs passed.
- `npm test -- --testTimeout=60000`: node tests 78 pass; `Test Files 467 passed | 4 skipped (471)`, `Tests 7799 passed | 5 skipped (7804)`.
- `scripts/build-desktop-test.ps1`: exit 0; then, each exit 0: `parity-recent-controls`, `parity-move-track`, `parity-key-shift`, `exports`.
- Not run: the real-helper suites (no plug-in code changed), the rest of the desktop drivers after this batch, the release
  resource-budget test (CI runs it).

## Limits

- The driver checks the count-in option's presence and state, not an exported file with a count-in; drag by touch was not tried; audition
  is confirmed by the native counter and the rendered peak, not by ear.
- Loop: a status that native read before it applied the loop and delivered after the command returned can still drop the loop for one
  Play. The Loop button itself still follows the polled state, so two quick clicks send "set" twice.
- Startup score: the native side reads only the settings file, so defaults that so far exist only in the browser copy are missing from the
  startup score until they have been saved once; the read happens under the workspace lock when the last tab closes.
- Fade: the fix sets the track's written volume for the length of one generator call and restores it.
- The mute and solo buttons of a dock row still use `disabled` while busy (found in review, existed before).
- Estonian and German strings were written without a native review.

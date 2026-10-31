# GP8 parity N09 and T26: close the remaining software gaps (2026-10-31)

Branch `feat/slice-notation`, based on `develop`. This slice closes the software-only gaps of two partial rows so they can move to implemented. The progress files are not edited here.

## Why these two

I read every notation (N) and technique (T) row that is partial in `2026-10-15-gp8-parity-progress.md`. Most remaining gaps need an alphaTab change (N06, N22, N21, N26 barre display, T17 GP5 buzz roll), hardware or listening (T12, T22, T23, T24), the original GP8 (N17 pickup ordering) or a product definition that does not exist yet (N18 fermata length units, T29 "all techniques"). Two rows had a small, concrete, software-only gap that matters to someone writing tablature:

- **N09, ties across voices.** Tying a note whose fret differs from the note before it was refused outright, and there was no keyboard shortcut. Those are the two gaps the row lists.
- **T26, fade in, fade out and swell.** The row lists one gap: no measured native PCM envelope for the three fade types. That needs a test, not a feature, and it also finds out whether the renderer really follows the volume events.

## Behavior

### N09
- **Music selection, Selected notes:** a new button, **Tie to earlier pitch**, ties each selected guitar or bass note to the nearest earlier note on its string and gives it that note's fret and harmonic. This is GP's "tie takes the earlier pitch" behavior. It is one undoable edit, `tieSelectionToEarlierPitch {selection}`.
- **Same rules as a plain tie:** the origin must be at most three bars back, with no rest or missing voice between and not dead. Drum hits are refused. A tie that would cut another note's tie is refused. Nothing changes when any selected note is refused.
- **A run of selected notes** passes one fret along in time order: select beats 2 and 3 and both take beat 1's fret.
- **Retuning is refused** when the note already ties into a later note that would then disagree, so a retune never silently breaks a tie. Selecting that later note too retunes it as well.
- **Already matching notes** behave exactly like a plain tie. Doing it again records nothing (refused as already tied).
- **Pitched (non-string) staves:** these never need retuning because their origin is found by pitch, so the button acts as a plain tie there.
- **Keyboard:** with the score focused and a music selection, Ctrl/Cmd+T ties the selection (the plain tie) and Ctrl/Cmd+Shift+T unties it. Each is one edit. The keys do nothing in text fields and dialogs, while busy, on a repeat, or in the Sound view; a finalized document shows the usual finalized message. The help panel lists them.
- **Saved form:** the new edit type carries only `selection`. Existing projects never contain it and every existing edit type is unchanged, so old `.tabplayer` projects and edit logs replay as before. The frontend and Rust both refuse extra or missing fields.

### T26
No behavior change was needed. The native renderer already follows the volume events of a fade; this slice measures it.

## Evidence

- **N09 tests written first.** `src/editor/selection-tie-match.test.ts` (7 tests) failed 7 of 7 before the change in the red run before the implementation and passes now:
  - retune to the earlier fret, with tie origin and destination links and equal sounding pitch;
  - a selected run passes the fret along, and a harmonic's type and value are carried;
  - already-matching input equals a plain tie, and a second click is refused;
  - refusals are atomic (rest, dead origin, wrong string, drum) and a retune that would break a later tie is refused, then allowed when the later note is selected too;
  - a GP7 export and reopen keeps the tie and the retuned fret;
  - the saved envelope accepts the exact fields and refuses extra or missing ones.
- **UI tests:** `RangePanel.test.tsx` (button sends one command, refusal raises an alert, disabled for drums) and `App.test.tsx` (Ctrl+T and Ctrl+Shift+T are one edit each, ignored in the Fret field and in the Sound view). Both failed before the change.
- **Rust:** `edit_types.rs` round-trips the new edit for every selection kind and refuses extra or missing fields and a reversed bar range. The wire fixture `tests/protocol.json` has the new example (79 examples; `harmony-commands.test.ts` count updated).
- **T26 measured PCM:** `fades_shape_the_rendered_level_of_a_held_note` in `src-tauri/tests/audio_render.rs` renders one second of a sustained note through the real `Renderer` with the volume (CC7) series a fade writes, and measures RMS in 50 ms windows against the same note without a fade:
  - fade in starts below 20% of the steady level, rises in every 50 ms window for the first 0.4 s and settles within 10% of the written level;
  - fade out starts within 20% of the written level, falls in every window and ends below 2%;
  - the swell opens quiet, peaks in the 0.15 to 0.30 s windows, and is below 5% again by 0.5 s;
  - an unfaded note keeps sounding to the end of the window, so the written length is untouched.
  Mutating the fade-out series to stay at 120 makes the test fail on "fade out ends silent".
- **Link between the two layers:** `gestures.test.ts` `fade_volume_series_match_the_native_envelope_fixture` pins the generator's exact (tick, value) series for the three fades to the series the Rust test renders, so neither side can drift alone. The existing endpoint test and the replay and rebuild test still pass.
- **Verification run:** `tsc --noEmit` clean. Vitest on `src/editor`, `parity-commands`, `harmony-commands`, `range-commands`, `engine` and `App` with `--testTimeout=40000 --maxWorkers=2`: 1,101 passed, 1 skipped, 0 failed. `cargo fmt --check` clean. `cargo test --locked --lib`: 381 passed, 31 failed, all 31 in device, drum-kit and renderer selection tests that read `src-tauri/resources/audio/soundfont/sonivox.sf2`, which this worktree does not have (fetched by `npm run prepare:audio`, not run here). The `edit_types` tests and the integration tests `audio_render` and `audio_plan` pass. No Windows desktop run was made.

## Review

I did not use a subagent reviewer for this slice. Self-review found and fixed: the harmony wire-fixture count; fade-out series that starts at the default level and so needs de-duplicating in the cross-layer test; an App test that selected the whole bar and so (correctly) refused the first beat with no origin. Mutation check on the T26 test is recorded above; the N09 guards share the plain-tie code, which is mutation-checked in `2026-10-22-gp8-selection-ties.md`. An independent adversarial review is still advisable before merge.

## Limits

- N09 retune works on guitar and bass strings. It does not choose a different string for the destination, and it does not retune a note on a pitched staff (not needed there).
- Ctrl/Cmd+T is the plain tie; the earlier-pitch tie has a button but no key.
- There is no comparison with the original GP8; its tie-retune details are inferred from its documented behavior.
- T26 shows the control path and the rendered envelope on the synthetic sample voice at the renderer level, with the volume events taken from the generator. It is not a listening test on the real guitar or bass sounds, and not a comparison with GP8's fade curve.
- Proposed progress changes (for the owner of the progress files): N09 partial to implemented; T26 partial to implemented with the limit above.
- The 31 audio-resource tests above were not run with the sound bank present.

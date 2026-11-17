# Left-over items, batch 3 - validation, 2026-11-18

Branch `agy/remainder-batch-3`, cut from `develop` at `238285f`. Five items, each implemented by one engineer and reviewed by a second,
read-only one; findings were fixed and re-reviewed until approved (the pan item twice, the paste item once). The final checks were run by
the orchestrator on the final tree. Nothing here was tried in the desktop app or with a real plug-in, and nobody listened to anything.

## What changed

| Item | Change |
|---|---|
| Paste after a cut through a held note (tracker row E08) | A phrase clip remembers which of its first notes were tied from a note before it and which of its last notes were tied to a note after it (an optional `held` marker). Pasted directly next to a beat with the same pitch on the same string, in the same voice, the note is tied; anywhere else it is struck, as before. A clip without the marker pastes exactly as before, and recorded pastes without it replay unchanged; the Rust and TypeScript validators both accept the optional field, and `tests/protocol.json` has one added case. |
| Pan of a hosted instrument | The score's pan and pan moves are applied to the output of an instrument plug-in, with the same pan law as the built-in voices of the track, a 10 ms glide and the plug-in's delay. A centred track renders as before (golden test); tracks without plug-ins and effect tracks are unchanged. Details: `2026-11-17-instrument-pan.md`. |
| Drum maps in exported MIDI | MIDI export has "Apply drum maps", off by default: each mapped hit is written on its mapped key and silenced hits are left out, using the functions playback uses. Off or absent gives byte-identical files. |
| Preferences in the native settings file (rows L05, L06, L07) | The score-error marking, the new-score defaults and the default view are kept in the app's settings file as well as the browser copy, so they survive a reset of the browser profile. Each field is validated alone on reading, the commands refuse bad values, unknown fields are kept, and a file from the current build without these sections loads. |
| Drum tab leftovers | Score-error shading covers both staves of a standard + tab pair; adding a staff to a drum track shown as tab is refused with a message that names drum tab (en, et, de); the print test checks the line of every number and that no tuning header appears; the left-off count is memoised. |

## Review findings and how they were settled

- **Pan.** Round 1, medium: removing an instrument, or switching it to an effect, changed the placement factor at once while the leaving
  plug-in was still fading, a step of up to 3 dB on a hard-panned track. Round 2, medium: during a switch between an effect and an
  instrument the pan moved from before the board's first stages to after them in one frame, which a mono or room microphone stage turned
  into a step. Both fixed with tests that failed first; the pan is now split between the two points and glides over the 10 ms. Third
  review approved.
- **Paste.** Medium: the added fixture line left a lone carriage return in `tests/protocol.json`, so Git treated the file as changed
  throughout. Fixed; the diff is the one added case. Low, fixed: a crafted record could mark a middle note; the help text described a
  clipboard from before the update, which cannot exist.
- **MIDI export, preferences, drum tab:** approved at the first review with low findings only.

## Checks (orchestrator's run, on the final tree)

- `cargo fmt --all -- --check`: clean. `npm run typecheck`: clean. `node scripts/secret-scan.mjs`: 0 findings.
- `cargo test --locked --workspace --no-fail-fast`: exit 0, 100 test programs passed.
- Real-helper suites, `--ignored --test-threads=1`: `plugin_helper` 17, `plugin_playback` 9, `plugin_export` 8, `plugin_editor` 6,
  `plugin_library` 2, `plugin_instrument` 25, all passed.
- `npm test -- --testTimeout=60000`: node tests 78 pass; `Test Files 463 passed | 4 skipped (467)`, `Tests 7743 passed | 5 skipped (7748)`.
- Not run locally: the release resource-budget test `selected_real_100bar_fourtrack_resource_budget` (CI runs it).

## Limits

- Paste: only ties are restored; a slur, slide or hammer-on across the cut edge is still severed. Bar clips are not marked, a repeated
  paste ties only its first start and its last end, and a rest or grace beat next to the paste prevents the tie. A plain Copy of a range
  that starts or ends on a tied note carries the marker too. The position check of the marker is on the TypeScript side, which replay
  uses; Rust checks its shape. An older build refuses a project that holds a paste with the marker.
- Pan: only a microphone stage was tested between the two points; a wah, octaver or pitch stage placed before the drive sees the same
  split. A side the score silences carries up to 80 dB down during the 10 ms of a switch. The built-in kit that stands in while an
  instrument loads now uses the renderer's pan law. Several MIDI channels on one track take the pan set last.
- MIDI export: the map is not applied to golpe hits; the tests use General MIDI and explicit rows, not a library preset; no drum library
  was loaded with an exported file.
- Preferences: native values are read once at start; a panel already open shows them when it is next opened. A group is saved whole. The
  new-score defaults are still not applied to the natively created startup score and blank tab. The bridge was exercised with a fake, not
  the running app.
- Drum tab: the shading test uses faked staff bounds and was not looked at on screen; the refusal also fires for a mixed track of a
  guitar staff and a percussion staff.
- Estonian and German strings were written without a native review.

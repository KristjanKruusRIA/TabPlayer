# Antigravity task handoff, second batch

Six follow-ups from the first batch's reviews and the GP8 parity tracker. Each is well specified, can be proven by tests, and stays out of file formats and audio callbacks that need a judgement call.

Start them after `agy/s19-refinger` and `agy/l09-diagnostics` are merged, because tasks 2 and 4 touch the same areas.

| # | Row | Task | Branch | Tier | Size |
|---|---|---|---|---|---|
| 1 | T17 | Report buzz-roll loss on GP export | `agy/t17-loss-warning` | flash | Small |
| 2 | W20 | Finish interface translation | `agy/w20-remaining-text` | flash | Medium |
| 3 | E19 | Automated tests for page layout symbol hits | `agy/e19-page-hits` | flash | Small |
| 4 | S19 | Close the cross-voice gap in string count changes | `agy/s19-string-count` | pro | Small |
| 5 | F27 | Keep the fields the matrix found lost | `agy/f27-kept-fields` | pro | Medium |
| 6 | None | Library search speed over 50,000 rows | `agy/library-search-speed` | pro | Small |

## Starting a task

Follow "Starting a task" in `docs/handoffs/2026-10-31-antigravity-tasks.md`, using this file's name in the prompt and the branch above, for example:

```bash
agy-job.sh start --tier flash --yolo --dir . --timeout 90m "Read docs/handoffs/2026-10-31-antigravity-tasks-2.md. Follow its Shared rules, then do task 1 only."
```

## Shared rules

- All Shared rules in `docs/handoffs/2026-10-31-antigravity-tasks.md` apply.
- Never run a full `cargo test`. It links more than 60 programs. Run one target, such as `--lib` or a single `--test`, with `-j 2`.
- Do not run desktop drivers. They need port 9223, and merging covers them. State this in Limits.
- Use only new temporary paths, and never delete a folder you did not create.
- Restore `src/audio/__snapshots__/plan.performance.test.ts.snap` if a test run rewrites it.

## Task 1: T17 report buzz-roll loss on GP export

GP 7/8 files have no buzz-roll field, so a buzz roll comes back as ordinary tremolo. `src/export/gp5.ts` reports this loss for GP5, but GP 7/8 export says nothing. `curveLosses` in `src/interchange/curves.ts` is the shared loss list.

Done when:
- A GP 7/8 export of a buzz roll lists that loss, in the app before writing and on the batch row.
- A selected-tracks or bar-range export names the source track and bar, not the exported position. Today `wherever` in `curves.ts` numbers the projected document, so fix that for curves and slurs too.
- A score with no loss still gets the plain question.

## Task 2: W20 finish interface translation

These are still English: the Sound inspector, knob and fader labels, the curve editor, generated descriptions, engine messages, tuning preset names and group titles (`src/tuning-presets.ts`), and refusal text from `src/engine.ts`.

Done when:
- A test fails if a user-visible string in those areas bypasses `src/i18n`.
- Every new key has `en`, `et` and `de` entries.
- Preset ids and saved data do not change.
- Limits says that no native speaker has reviewed the translations, and lists anything left in English.

## Task 3: E19 page layout symbol hit tests

Double-click and context menu hits on the page layout were checked by hand once. See `src/editor/symbol-hit.ts` and its test.

Done when:
- Tests cover title, tempo, chord and clef hits in page layout, on a later page, and with zoom, using real alphaTab rendering if it works in the test setup and exact bounds otherwise.
- Any defect found is fixed in a separate commit with its own failing test, or reported if the fix is not small.

## Task 4: S19 cross-voice gap in string count changes

`setStringCount` can place two voices' notes on one string at the same moment. The keep-pitch path in `src/editor/refinger.ts` now refuses this. Share that check rather than copying it.

Done when:
- Overlapping notes in different voices never end up on one string after a string count change. The edit lists them instead.
- Overlap uses current rhythm, including a rhythm edit made just before.
- Old logs replay exactly as before. If that is not possible, stop and report it.

## Task 5: F27 keep the lost fields

`src/interchange/field-preservation.test.ts` holds `it.fails` entries for `Note.durationPercent`, `Note.isVisible` and `TremoloPickingEffect.style`. Add them to the `TabPlayerCurves` staff property in `src/interchange/curves.ts`, which already has the safety checks an imported file needs.

Done when:
- All three round trip through TabPlayer's writer and reader, and their `it.fails` become plain tests.
- A hostile value is skipped with a warning, with tests, and a stale item does not restore onto a changed note.
- A score without these values writes the same bytes as before.
- Limits says that Guitar Pro 8 does not read this property. Task 1's buzz-roll warning stays, because the loss is still real there.

This reads untrusted files, so it gets a separate review before merge.

## Task 6: Library search speed

`a_page_search_over_fifty_thousand_rows_stays_fast` in `src-tauri/src/file_library/index.rs` takes about 1.96 to 2.00 s alone against a 2 s limit in a debug build, and fails under load. It has failed in most full runs.

Done when:
- The cause is found by measurement, and the measurements are in the report.
- Search gets faster without changing results, ordering or paging. Do not raise the limit or weaken the test.
- If it cannot get clearly faster without a schema or index format change, stop and report that.

## Not in this batch

These need a decision or hardware first: MP3 and OGG export (encoder dependency and licensing), MIDI input and the tuner (audio or MIDI capture), nested tuplets (model change), MIDI output ports, Line-In, Fretlight and mySongBook. Triage of the 22 failing desktop drivers also stays out, because it needs the real app and port 9223.

## Merging a finished branch

Follow "Merging a finished branch" in the first handoff. Tasks 4, 5 and 6 need a separate review.

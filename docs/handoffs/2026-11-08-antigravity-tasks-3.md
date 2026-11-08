# Antigravity task handoff, third batch

Six tasks from the 2026-11-08 work: the practice walk (THE-54), reviews of the loop and symbol-hit work, and the tracker's remaining rows. Each one can be proven by tests or produces a written digest. None of them touches the VST branch, audio callbacks, or project schema.

| # | Linear | Task | Branch | Tier | Size |
|---|---|---|---|---|---|
| 1 | THE-198 | Replace an untouched Untitled tab when opening a score | `agy/the-198-replace-untitled` | pro | Small |
| 2 | None | Finish moving visible English text into i18n | `agy/i18n-sweep-3` | flash | Medium |
| 3 | None | Close test gaps found in review | `agy/test-gaps-3` | flash | Small |
| 4 | THE-63 | Audit legacy Guitar Pro import with authored fixtures | `agy/the-63-legacy-gp` | pro | Medium |
| 5 | THE-67 | Nested tuplets: what alphaTab can do (digest only) | `agy/the-67-tuplet-digest` | pro | Small |
| 6 | THE-197 | Typed practice speed | `agy/the-197-typed-speed` | pro | Small |

Tasks 1 to 5 can start now. Start task 6 only after THE-193 (`ux/the-193-draw-selection-loop`) is merged into develop, because both touch the transport.

## Starting a task

Follow "Starting a task" in `docs/handoffs/2026-10-31-antigravity-tasks.md`, using this file's name and the branch above, for example:

```bash
agy-job.sh start --tier pro --yolo --dir . --timeout 90m "Read docs/handoffs/2026-11-08-antigravity-tasks-3.md. Follow its Shared rules, then do task 1 only."
```

## Shared rules

- All Shared rules in `docs/handoffs/2026-10-31-antigravity-tasks.md` and `docs/handoffs/2026-10-31-antigravity-tasks-2.md` apply.
- Branch from the current `develop`. Commit only on your branch. Never merge or push.
- Never run a full `cargo test`. Run one target, such as `--lib` or a single `--test`, with `-j 2`.
- A full `npx vitest run` now uses at most 6 workers and takes about 4 to 5 minutes; that is expected. Run the files you touched first.
- Do not run desktop drivers (they need port 9223). Say so under Limits.
- Restore `src/audio/__snapshots__/plan.performance.test.ts.snap` with `git restore` if a run rewrites it. Never commit it.
- New UI text goes through `src/i18n` with `en`, `et` and `de`. Say under Limits that no native speaker reviewed it.
- A control holding focus never gets `disabled` for busy; use `src/ui/useBusyGuard.ts`. One gesture is one undoable edit, and choosing the current value records nothing.
- Never commit private scores, extracted binaries or generated test output. Fixtures you author must be small and written for this repository.
- Finish with a short report: what changed, the tests you ran and their results, and Limits.

## Task 1: THE-198 replace an untouched Untitled tab

Opening the first score always leaves a spare empty "Untitled" tab beside it. Found in the practice walk, `docs/validation/2026-11-08-the-54-practise-walk.md`.

Rule: when a score opens from the Library, File → Open, a drop or the command line, it replaces a document that has no edits, has never been saved and was created blank by the app. It never replaces a document with any edit, any history, a file path, or one opened from a file. Look in `src/workspace/` for how documents are created and closed.

Done when:
- Tests cover each kind of open, plus the cases where nothing is replaced: an edited blank document, a blank document after undo back to empty (it has history, so it is kept), and a saved one.
- Recovery and session restore are unchanged, and their existing tests pass.
- Closing the replaced tab records nothing in any undo history.

## Task 2: finish moving visible English text into i18n

Some user-visible text is still hard-coded English. A known case is `practiceNotice` in the native playback controller (`src/audio/NativePlaybackController.ts`). The new `loopNotice` beside it is already translated.

Done when:
- Every string a user can see in `src/` outside tests goes through `src/i18n`, or is listed under Limits with a reason (for example, text from a file the user opened).
- A test fails if a new hard-coded English string appears in the areas you changed. Extend the guard from the second batch's task 2 if it exists.
- Every new key has `en`, `et` and `de` entries. Saved data, ids and file formats do not change.

## Task 3: close test gaps found in review

Three gaps reviewers found but left open:

1. `src/library/LibraryDialog.test.tsx` covers double-click on an example row only. Add Templates and Folders rows. A double-click opens the row once, as Enter does.
2. `src/editor/symbol-hit.page.test.ts` covers one track. Add a multi-track system and a staff-gap shift, using real alphaTab rendering as that file does.
3. `src/audio/kept-loop.test.ts`: add a loop across a repeat where the edit removes the repeat sign. The loop is kept if its passes are still unambiguous, and otherwise cleared with the notice.

Done when each new test passes against the current code, or fails on a real defect. A defect gets its own failing test and a separate fix commit if the fix is small, otherwise a report.

## Task 4: THE-63 audit legacy Guitar Pro import

The tracker rows F01 (legacy GP import) and F12 (large MIDI export) are unverified since the baseline.

Done when:
- Small authored GP3, GP4 and GP5 fixtures under `tests/fixtures/` exercise bends, overlapping bends, slides, hammer-ons, harmonics, tuplets, repeats, multiple tracks and a percussion track. Create them with the repository's own exporters, or by hand from the format specification. Do not download or copy files from the web.
- Tests import each fixture and assert what survives and what is lost.
- One test exports MIDI from a large generated arrangement (at least 16 tracks and 1,000 bars, built in the test) and checks that the event count, track count and end time are right, with a time bound measured on this machine and stated in a comment.
- `docs/validation/2026-11-08-the-63-legacy-gp.md` lists, per GP generation, what works, what is lost, and what is unsupported. The F01 and F12 rows in `docs/validation/2026-10-15-gp8-parity-progress.md` and `.json` get matching text, with the same status words unless the evidence supports a change.

## Task 5: THE-67 nested tuplets digest

N06 nested tuplets is the only notation row still missing. Do not write product code for this task.

Read alphaTab 1.8.4 in `node_modules/@coderline/alphatab` and the importers and exporters in `src/`. Write `docs/validation/2026-11-08-the-67-nested-tuplets.md` covering:
- whether alphaTab's model can hold a tuplet inside a tuplet, and whether it can render and play one (try it in a scratch Vitest file, then delete the file);
- what GP7/8, GP5, MusicXML and MIDI import and export do with nested tuplets today;
- what a TabPlayer edit type would need, and how old projects and edit logs would stay replayable;
- a recommendation: build it, build a limited form, or record it as an alphaTab limit.

## Task 6: THE-197 typed practice speed

Start only after THE-193 is merged. Found in the practice walk.

Add a speed field next to Slower and Faster in the transport (`src/Transport.tsx`), for example 60 percent.

Done when:
- Typing a number from 10 to 300 and pressing Enter, or leaving the field, sets the speed. Escape restores the shown value. A value out of range or not a number is refused with an inline message, and nothing changes.
- The preset steps of Slower and Faster still work and update the field.
- A fixed-tempo practice setting restricts the field the same way it restricts the buttons today.
- Speed stays a session control: nothing is added to undo history, and choosing the current value does nothing.
- Tests cover all of the above.

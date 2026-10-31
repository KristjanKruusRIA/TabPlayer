# Antigravity task handoff

Five tasks from the GP8 parity tracker that Antigravity can take on its own, each on its own branch. They were picked because they are well specified, can be proven by tests, and stay out of the audio engine, security code and file formats that need a judgement call.

Start them after `develop` is pushed. Task 2 and task 5 add UI text, so start those after the current localization fixes (`feat/slice-w20c`) are merged, or they will conflict in `src/i18n`.

| # | Row | Task | Branch | Tier | Size |
|---|---|---|---|---|---|
| 1 | S13 | Tuning library for more instruments | `agy/s13-tuning-library` | flash | Small |
| 2 | S19 | Keep pitch when retuning or changing capo | `agy/s19-refinger` | pro | Medium |
| 3 | F27 | Import field preservation test matrix | `agy/f27-field-matrix` | flash | Medium |
| 4 | T17 | Buzz-roll tremolo in GP export | `agy/t17-buzz-roll` | pro | Small |
| 5 | L09 | Audio test tone and device diagnostics | `agy/l09-diagnostics` | pro | Medium |

## Starting a task

Each task gets a worktree, so Antigravity never touches your root checkout. From `E:\git\TabPlayer` in Git Bash, using task 1 as the example:

```bash
git worktree add -b agy/s13-tuning-library .worktrees/s13 develop
```

```bash
cmd //c mklink //J "$(cygpath -w .worktrees/s13/node_modules)" "$(cygpath -w node_modules)"
```

```bash
cd .worktrees/s13
```

```bash
agy-job.sh start --tier flash --yolo --dir . --timeout 90m "Read docs/handoffs/2026-10-31-antigravity-tasks.md. Follow Shared rules, then do task 1 only."
```

`agy-job.sh status <id>` shows progress and `agy-job.sh result <id>` fetches the report. Finished jobs send no notification. Run a job from the worktree, not from root.

Worktrees have no `.analysis/compatibility` fixtures or sound bank. `plan.test.ts` and many audio Rust tests fail there for that reason alone.

## Shared rules

- Work only in the current worktree and on its branch. Do not push, merge, rebase or switch branches.
- Read `CLAUDE.md`, `PRODUCT.md` and the task's tracker row in `docs/validation/2026-10-15-gp8-parity-progress.md` first.
- Never edit `src-tauri/src/audio/tone.rs`, `src-tauri/gen/`, `src-tauri/resources/audio/` or `.analysis/compatibility/`.
- Never edit `docs/validation/2026-10-15-gp8-parity-progress.json` or `.md`. The tracker is updated when the branch is merged.
- Add no dependencies.
- Do not invent facts. If a file format, tuning or behavior cannot be confirmed from this repository or a primary source, stop and report it instead of guessing. Name the source for every external fact.
- Do not weaken, skip or delete a test to get a pass, and do not patch installed packages or stub out a dependency.
- Edit types and project schema changes must keep old `.tabplayer` projects and edit logs replayable.
- One gesture is one undoable edit, and choosing the current value records nothing.
- New UI text goes through `src/i18n` with `en`, `et` and `de` entries. A control holding focus never gets `disabled` for busy; see `src/ui/useBusyGuard.ts`.
- Match the surrounding code. Stage named files only, never a directory.
- Write evidence to `docs/validation/2026-10-31-gp8-<slug>.md` with the headings `## Behavior`, `## Evidence`, `## Review` and `## Limits`. Report partial work as partial and state what was not checked.
- Before finishing, run `npx tsc --noEmit` and `npx vitest run <the affected folders> --testTimeout=60000`. Report the commands and their actual results.
- Commit with the trailer `Co-Authored-By: Gemini 4 Argon <noreply@google.com>`.
- End with the commit hash, the files changed, the steps taken, what failed along the way, and what is left.

## Task 1: S13 tuning library

Today there are about 25 guitar and bass presets. Add presets for banjo, ukulele, mandolin, bowed strings and shamisen to the existing preset catalog, using its current data shape.

Done when:
- Each preset's string count, pitches and order are pinned by a test.
- Every preset has a named source, and any tuning you can't source is left out and listed in Limits.
- The presets appear in the existing tuning controls and can be applied and undone as one edit.
- Existing preset ids are unchanged, so saved projects still resolve.

## Task 2: S19 keep pitch on retune or capo change

Today a retune or capo change keeps the frets and changes the pitch. Add an option to keep the pitch instead, moving each note to a fret that sounds the same on the new tuning.

Done when:
- Keeping frets stays the default and behaves exactly as before.
- With the option on, every note keeps its sounding pitch or is listed for the user when it can't be reached. Nothing is dropped silently.
- A chord never ends up with two notes on one string.
- The change is one undoable edit, and an old project replays unchanged.
- Tests cover drop tuning, capo up and down, an unreachable note, a chord, ties, and undo and redo.

Stop and report if this needs a new edit type you can't make replay-safe.

## Task 3: F27 import field preservation matrix

Row F27 asks for proof that import keeps every target notation, audio and layout field. Build the test matrix. This task is tests and a report, not fixes.

Done when:
- A table-driven test goes field by field through the score model: set the field on a score, write it with each format writer that claims it, read it back and compare.
- Each field is marked as preserved, knowingly dropped, or failing. Knowingly dropped fields must trace to a stated limit in the code or docs.
- Tests that fail on a real defect stay out of the passing suite with `it.fails` and a one-line reason. Do not fix the defect.
- The report lists every failing field with the file and line where it is lost.
- The field list comes from the model's own types, so a new field can't be missed unnoticed.

Use only synthetic scores made in the test. This does not prove interoperability with original Guitar Pro 8, so say that in Limits.

## Task 4: T17 buzz-roll tremolo in GP export

The native buzz-roll field can be written, but GP export comes back as the Default style. Find where the writer loses it and fix it.

Done when:
- A round trip through the GP writer and reader keeps the buzz-roll style.
- Other tremolo styles are unchanged, and a test pins them.
- If the target format's value can't be confirmed from this repository or from a real file, stop and report that rather than guessing a value.

Check against a real Guitar Pro file is out of scope; say so in Limits.

The notation slice recorded that the GP5 side of this may need an alphaTab change. Report that and stop rather than patching alphaTab; a fix limited to the GP7/GP8 writer is fine.

## Task 5: L09 audio test tone and device diagnostics

The Settings audio area lists output devices only. Add a test tone button and a diagnostics readout of the current device, sample rate and buffer size.

Done when:
- The tone plays through the same output the app uses, at a quiet fixed level, and stops by itself. It is refused cleanly during playback.
- A missing or failed device shows a plain message and leaves playback working.
- The readout shows only values the audio backend actually reports. An unknown value reads as unknown, never as a default.
- No allocation, lock or logging is added to the audio callback. Show this in the report, because this change gets a separate adversarial review before merge.
- Rust and UI tests cover the refused and failed paths. Desktop verification is left to the merge and stated in Limits.

Input meters and buffer changes are out of scope.

## Merging a finished branch

Antigravity's "all green" is a claim, not evidence. Before merging:

1. Read the diff and check that no test was weakened, and that no tooling or installed package changed.
2. Rerun `tsc` and the tests yourself in a clean state, with fixtures present.
3. Task 2 and task 5 need a separate review. Task 5 counts as hot path because it reaches the audio callback.
4. Add the tracker row with the evidence report, then remove the worktree. Run `cmd //c rmdir` on its `node_modules` junction first, so the removal can't touch the shared folder.

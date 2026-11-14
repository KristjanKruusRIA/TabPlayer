# THE-213: note edits on a long score

Date: 2026-11-14. Branch `agy/the-213-edit-speed`, cut from `develop` (77605bb). Work is uncommitted in the working tree.

## Question

The owner opened a real full-length score in the installed 1.0.0 build: every note edit took about half a second or more, every
click seemed to refresh the whole interface, and the editor was never quiet. The goal was an edit that shows and accepts the next
key within about 100 ms (hard requirement: median under 200 ms), does not slow down as edits accumulate, never waits for playback
to be prepared again, a cursor move that costs the same on a long score as on a short one, and no redraw when nothing changed.

## What was measured, and how

Test score: a synthetic 6-track, 200-bar score (about 310 KB as GP7) generated from alphaTex, against a 1-track, 8-bar one.
Real app (`scripts/build-desktop-test.ps1` build of this worktree, WebView2, CDP on port 9223), 14 repetitions of "digit key, then
Enter" on a note, medians. "Key to IPC" is the key to the answer of the native `apply_edit`; "key to drawn" is the key to the last DOM
change of the score; "key to editor free" is the key to the busy flag dropping; "key to Play" is the key to the Play button being
enabled again with native playback prepared. Idle is a 5 s CPU profile of the page; arrow keys are 20 moves.

One machine, one run per row, other agents working in the same checkout family on the same machine (the numbers moved by tens of
percent between runs). The baseline column is this worktree's own build before any change (the small-score baseline edit run failed
to start twice, so the small baseline edit row is the owner's own measurement from the task).

| Large score (6 x 200) | Baseline | Stage A | Final |
|---|---|---|---|
| key to native IPC answered | 398 ms | 15 ms | 12 ms |
| key to score drawn | 920 ms | 195 ms | 190 ms |
| key to editor free (busy flag) | 1059 ms | 212 ms | 124 ms |
| key to Play enabled | 3291 ms | 2275 ms | 1925 ms |
| long task time per edit | 1200 ms | 458 ms | 355 ms |
| arrow-key cursor move | 91 ms | 62 ms | 22 ms |
| idle main-thread busy (profile) | 51 % | 4.4 % | 3.0 % |
| native status events in 5 s idle | 156 | 156 | 5 |

| Small score (1 x 8) | Baseline | Stage A | Final |
|---|---|---|---|
| key to native IPC answered | 19 ms (owner) | 12 ms | 9 ms |
| key to score drawn | 63 ms (owner) | 70 ms | 62 ms |
| key to editor free | 75 ms (owner) | 87 ms | 71 ms |
| key to Play enabled | 430 ms (owner) | 781 ms | 699 ms |
| arrow-key cursor move | 29 ms | 15.6 ms | 13.8 ms |
| idle main-thread busy (profile) | 29 % | 5 % | 2.9 % |

Stage A is the build with the in-place edit, the projection that follows the edit, the quiet period before the playback plan, the
stable playback state, the isolated recovery text and the quiet view update. Final adds the validated-plan reuse, native status
de-duplication and the draw that gives way to waiting keys. Small-score Play readiness is longer than the owner's figure by the 300 ms
quiet period (see "What remains").

The new driver `tests/desktop/edit-speed.mjs` (24 edits, a 6-key burst, 20 cursor moves, 3 s idle, 3 compared edits) on the final build:

```
editIpcMedianMs 12, editFreeMedianMs 182 (worst 228; early 196, late 165), burst: 6 edits, worst IPC 22 ms, 1 audio_prepare,
cursorMedianMs 10, idleBusyPercent 0.4, idleStatusEvents 3 in 3 s, 3 edits compared with a full rebuild, 0 mismatches
```

Reached: the hard requirement (median under 200 ms from key to the score drawn on the 6 x 200 score: 182 to 190 ms in two drivers,
worst 228 ms), no growth with edit count (the 24th edit is not slower than the 2nd), no wait for playback preparation (6 edits typed
150 ms apart answered in at most 22 ms each, one `audio_prepare` for all of them), a cursor move on the long score within 9 ms of the
short one, idle near zero.

Not reached: "about 100 ms". The floor is the alphaTab layout and SVG painting of the whole rendered score (about 100 ms in
`renderScore` on this score, plus about 55 ms placing the SVG chunks and about 25 ms of forced layout while placing overlays), which
alphaTab 1.8.4 cannot do for part of a score. See "What remains".

## Where the time was, and what changed

Profile of one note edit on the long score before the change: file parse and replay of every edit, then a JSON round trip (`rebuild`)
in `buildDocument` (about 390 ms before the native call), then the engraving projection (another full JSON round trip) and the render,
then the playback plan (`scoreToJson` on the main thread, a worker, native `audio_prepare` of 0.8 to 1.3 s). After the change a note
edit costs: a check on copies of one voice (0.1 ms), the native call (9 to 15 ms), the edit applied to the built score and that
track's derived state worked out again (2 to 3 ms; in node a full rebuild of the same score takes 1.9 s), the render.

| Change | Files | Effect, measured |
|---|---|---|
| Notes, rests, durations and beats are applied to the built document, not rebuilt from file and history. Checked first on detached copies of the touched voices (same refusals as the real edit), applied once native has recorded the edit | `src/engine.ts`, `src/controller.ts` | key to IPC 398 to 12 ms; node: full rebuild 1916 ms, check 0.1 ms, apply 2 to 3 ms |
| The new score is the same tracks under a new identity, so everything that follows a score by identity still sees a change | `src/engine.ts` (`newScoreIdentity`) | no change to any consumer |
| The engraving projection (the rendered copy of the score) takes the same edit instead of being rebuilt | `src/engraving/follow.ts`, `src/engraving/projection.ts` (`mapProjection`), `src/App.tsx` | removes the second JSON round trip (about 130 to 300 ms) from the edit |
| The playback plan waits 300 ms after the last edit (playback is invalid at once); a newer edit supersedes it | `src/audio/NativePlaybackController.ts` (`quietMs`), `src/App.tsx` | 6 edits, 1 `audio_prepare`; Play ready 3291 to 1925 ms; main thread idle during native preparation (profile: 1391 of 1815 ms idle) |
| Playback state keeps its object when nothing in it changed (native sends status 30 times a second) | `src/audio/NativePlaybackController.ts`, `src/same-data.ts` | idle busy 51 % to 4.4 % |
| The recovery text is its own subscription; a view update no longer notifies the whole workspace | `src/workspace/WorkspaceApp.tsx`, `src/main.tsx`, `src/workspace/WorkspaceController.ts` | a recovery status or a view change no longer notifies the workspace, so it no longer renders `App` (not counted per render; the driver shows no score redraw on 20 cursor moves and the move at 10 ms) |
| A plan that was frozen and checked is not checked again on every cursor move | `src/audio/plan.ts` (`freezePlan`), `src/audio/NativePlaybackController.ts` | arrow key on the long score 62 to 22 ms, 20 long tasks to 0 |
| Native sends an unchanged status once a second instead of 30 times | `src-tauri/src/audio/device.rs` | status events in 5 s idle 156 to 5; idle busy 4.4 to 3.0 % |
| A draw of the score gives way, up to 6 frames, to keys already waiting; the newest score is drawn | `src/ScoreView.tsx` | burst worst IPC 234 ms to 22 ms (first driver run to final) |

The per-change figures come from consecutive builds and from the profiles, not from isolating each change in its own build: three
builds were made (baseline, stage A, final), and a build of this app takes minutes.

## The equivalence check

An edit applied in place must give the document a full rebuild from file plus edit log gives. This is checked, not argued:

* `src/engine-verify.ts` describes a score independently of how it was made: the serialized model with object ids replaced by
  positions (note links by the positions of all notes of that id: a new note takes the next value of a counter that knows nothing of a
  loaded file, so ids can repeat), plus every plain field and object link of every bar, voice, beat and note, which covers what the
  serializer leaves out (beat chain, timings, effect slurs, lookups, indices). `firstDifference` names where two descriptions differ.
* `src/engine.in-place.test.ts` applies random edits (set note, remove note, rest, duration with up to 3 dots, insert and delete beat,
  two-step sequences; a quarter aimed at the end of a track) to a rich alphaTex score (ties, hammer-ons, slides, bends, grace notes,
  a triplet, let ring, palm mute, dynamics; each feature asserted present) and to a blank score with an added track. After every
  accepted edit the document is compared with `buildDocument` of the project; a refused edit must be refused with the same message by
  the check on copies, and must leave the document equal to the project. About 150 and 60 edits per run; seeds 7, 11, 101, 202, 303,
  404, 5 and 6 were run, all equal. This found five differences that the first version of the in-place code had (a lookup that is only
  ever added to, the beat chain at the end of a track, note indices after a removal, ids, and duplicate ids) and all are fixed.
* `src/engraving/follow.test.ts` compares the followed projection with a new one (with a track profile override and two edits drawn at
  once) and its maps.
* `src/controller.test.ts` runs edits, undo and redo through the controller with every edit compared with a rebuild, and checks that a
  refusal by the check or by native leaves the very same score.
* At run time `editCheck` compares every n-th in-place edit with a full rebuild (n = 25 in development builds, 0 in release; a person or
  a test can turn it on with `globalThis.__tabplayerCheckEdits = n`); a difference is reported with `console.error` and the rebuilt
  document replaces the edited one. The desktop driver compares 3 edits on the long score in the real app: 0 mismatches.

Fall back to the full rebuild: any other edit type; a track with managed or hidden lyrics or sustain pedals; a score with beats that
show a timer; reference timing; a track that does not exist; an edit that carries an asset or follows a partial-capo mark.

Audio, schema, history: edit types, the project schema, the recovery file and native history are untouched. `tone.rs` is untouched.
The file's own content is still validated when it is opened; each edit is still validated by `validateParityCommand` and by native.

## Verification run

All on the final working tree, in the worktree `E:\git\TabPlayer\.worktrees\edit-speed`:

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test -- --testTimeout=60000` (Node resource tests, then Vitest) | 415 files passed, 4 skipped; 7238 tests passed, 8 skipped, none failed (853 s). `plan.test.ts` passed here. `plan.performance.test.ts.snap` changed during the run and was restored with `git checkout --` |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | clean (after one `cargo fmt` of the new lines in `device.rs`) |
| `cargo test --locked --workspace --no-fail-fast --manifest-path src-tauri/Cargo.toml` | exit 0; 92 test binaries, 2026 passed, 0 failed, 96 ignored |
| `scripts/build-desktop-test.ps1` | built three times (baseline, stage A, final) |
| `node tests/desktop/edit-speed.mjs` (new) | exit 0, numbers above |
| `node tests/desktop/editor.mjs`, `parity-entry.mjs`, `loop-through-edit.mjs`, `parity-clipboard.mjs` | exit 0 each |
| `node tests/desktop/native-audio.mjs`, `parity-document-tabs.mjs` | first run exit 1: they need the debug Cargo build and the `capture_loopback` example, which did not exist yet in this worktree; after `cargo test` built them, exit 0 each |

The new Vitest files: `src/engine.in-place.test.ts` (4), `src/engraving/follow.test.ts` (1), one test added to `src/controller.test.ts`.
`TP_FUZZ_SEED` and `TP_FUZZ_COUNT` change the seed and the edit count of the first two tests for a longer fuzz.

## What remains slow, and the next step

1. The draw: about 100 ms layout and painting of the whole rendered score, 55 ms placing it, 25 ms forced layout. Next step: render
   only the systems that changed. alphaTab 1.8.4 has no partial layout (its `startBar`/`barCount` settings change what is laid out, not
   what is redone), so this means keeping the laid-out systems of the unchanged bars and re-laying out from the changed bar to the end
   of its system (a system's bars do not move unless the changed bar's width changes), which needs a layout cache in front of alphaTab
   or an alphaTab change. It would also remove `loadMidiForScore` (about 20 ms) from each edit.
2. Undo and redo still rebuild the document from file and history (about 1 to 2 s on the long score, and growing with the history).
   Next step: keep the inverse of an in-place edit (the touched voice's beats before the edit, restored through the same
   `settleTrack`), or a checkpoint of the built score every n edits.
3. Pitch-entry planning (`tryPreview` in `src/editor/score-entry.ts` and `src/editor/midi-capture.ts`) and the auto-duration pair
   check (`applyInOrder` in `src/editor/input-preferences.tsx`) still build a whole document per key (about 2 s each on the long
   score). They need the written score, so they need a speculative copy of one track. I did not change them: they sit next to the
   keyboard-entry code another change is working on.
4. The playback plan: `scoreToJson` of the whole score on the main thread (about 75 to 140 ms) once per burst, and native preparation
   of 0.8 to 1.3 s (off the main thread, but it is why Play is back about 1.9 s after an edit on the long score). Next step: keep the
   score in the plan worker and send it the edit, and make native preparation reuse the renderer for unchanged tracks.
5. Other edit types (selection edits, measures, tempo) still rebuild; the list in `inPlaceTypes` grows by adding a type and its
   cases to the equivalence test.

## Limits

* A synthetic score of identical bars and one machine; the owner's real score and machine were not used. Medians of 14 runs per row,
  one run each. Another agent's app uses the same test port and the same machine, so some runs were repeated.
* The small-score baseline edit row is the owner's measurement, not mine.
* `navigator.scheduling.isInputPending` exists in Chromium (WebView2); where it does not exist the draw does not give way.
* The 300 ms quiet period makes Play ready 300 ms later after a single edit on a short score (430 to about 700 ms); it is what keeps
  a run of edits to one preparation.
* The checks that edits equal rebuilds are a fuzzed comparison over the edit types and score features above, not a proof; the
  runtime comparison is off in release builds.

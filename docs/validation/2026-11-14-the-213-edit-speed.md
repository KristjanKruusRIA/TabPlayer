# THE-213: note edits on a long score

Date: 2026-11-14 to 2026-11-15. Branch `agy/the-213-edit-speed`, cut from `develop` (77605bb), then `develop` (1d00286, the mixer drag and
immediate fret typing) merged in. Everything after the one WIP commit is uncommitted in the working tree.

## Question

The owner opened a real full-length score in the installed 1.0.0 build: every note edit took about half a second or more, every
click seemed to refresh the whole interface, and the editor was never quiet. The goal was an edit that shows and accepts the next
key within about 100 ms (hard requirement: median under 200 ms), does not slow down as edits accumulate, never waits for playback
to be prepared again, a cursor move that costs the same on a long score as on a short one, and no redraw when nothing changed.

## What was measured, and how

Test scores: a synthetic 6-track, 200-bar score (about 310 KB as GP7) generated from alphaTex, a 1-track, 8-bar one, and (after the
first review) five of the owner's own scores, 52 to 79 KB, 81 to 142 bars, six tracks each. The owner's scores are private: they were
read from a scratch folder outside the repository, nothing from them is in the repository, and they are called "the owner's scores"
here; "the largest" means the one with the most music in the file (141 bars).

Real app (`scripts/build-desktop-test.ps1` build of this worktree, WebView2, CDP on port 9223), medians. "Key to IPC" is the key to the
answer of the native edit call; "key to drawn" is the key to the last big DOM change of the score; "key to editor free" is the key to
the busy flag dropping; "key to Play" is the key to the Play button being enabled again with native playback prepared. Idle is a 5 s CPU
profile of the page; cursor moves are 20 arrow keys. macOS and Linux were not measured: everything below is Windows 11, one machine.

One machine, other agents running their own apps and test runs on it at the same time, so every number moved by tens of percent between
runs. Where a run overlapped another heavy process it was repeated.

## Headline numbers

All medians, Windows 11, one machine. "Before" is this worktree's own build of `develop` before any change (the owner's small-score
figures where the small baseline run did not start). "Now" is the final build, **with typed digits** (a digit writes its fret at once on
this branch since the merge, so the edit key is the digit, not Enter).

Large synthetic score (6 tracks x 200 bars), a typed digit:

| | Before | Now |
|---|---|---|
| key to native edit call answered | 398 ms | 17 ms |
| key to score drawn | 920 ms | 203 ms |
| key to editor free (busy flag) | 1059 ms | 222 ms |
| key to Play enabled | 3291 ms | 2639 ms |
| undo, key to drawn | not measured (a rebuild: 1.9 s in node) | 274 ms (call 16 ms) |
| redo, key to drawn | not measured | 222 ms |
| two-digit fret (write, undo, write), second digit to drawn | not measured | 602 ms, drawn once |
| arrow-key cursor move | 91 ms | 13 ms (23 ms in the idle driver) |
| idle main-thread busy (profile) | 51 % | 3.1 % (0.4 % in the new driver) |
| native status events in 5 s idle | 156 | 5 |

Small synthetic score (1 track x 8 bars):

| | Before | Now |
|---|---|---|
| key to native edit call answered | 19 ms (owner) | 8 ms |
| key to editor free | 75 ms (owner) | 65 ms |
| key to Play enabled | 430 ms (owner) | 443 ms |
| undo, redo: editor free | | 57 ms |
| two-digit fret: editor free | | 130 ms |
| arrow-key cursor move | 29 ms | 8 ms (13.7 ms in the idle driver) |
| idle main-thread busy (profile) | 29 % | 2.8 % |

Play readiness after item 8: the 300 ms wait before every plan is gone for a single edit, so on the small score Play is back at
443 ms after an edit (it was 699 ms with the fixed wait, 430 ms before any change); on the long score it is 2.6 s
(1.9 s measured in the first round: native preparation takes 0.8 to 1.3 s, the plan about 0.5 s more, and the run overlapped
other work on this machine). During a burst of edits it is prepared once, for the last.

The owner's largest score (89 to 141 bars, six tracks), the same measurements, 16 repetitions (first four are warm-up and are in the
median; the median without them differs by less than 10 %):

| | Before | Now |
|---|---|---|
| edit (key that writes the note) to drawn | 723 ms | 675 ms |
| edit, native call | 179 ms | 25 ms |
| undo, key to drawn | 776 ms (call 187 ms) | 281 ms (call 5 ms) |
| redo, key to drawn | 762 ms | 298 ms |
| two-digit fret, second digit to drawn | not measured (undo and two edits by rebuild) | 1190 ms, drawn once |
| arrow-key cursor move | 35 ms | 21 ms |

So on a real score the 200 ms goal is **not** reached for a note edit: alphaTab's layout and painting of the score takes 400 to 650 ms
and a key typed while it runs waits for it. What changed is everything around it: the native call, the second copy of the score, the plan
(no longer on the input path), and undo, redo and the cursor, which are now 2.5 to 3 times faster than before. The two-digit fret costs
about one draw more than a single digit (the first digit is still being drawn when the second arrives 250 ms later in this test).


## What the review found, and what was done

The review of the first version listed five required fixes and five more. Each was reproduced as a failing test first; all of them
reproduced except where noted.

1. **Hammer-on and slide links.** Reproduced (`engine.in-place.review.test.ts` test 1, alphaTex `3.3{h} 5.3 ...`, delete the last beat,
   insert a rest between the two notes, write a note on it **on the string of the hammered notes**: with another string the sequence
   does not diverge). In place, finishing re-pointed the hammer-on from the old destination to the new note while the old destination
   kept its origin; `rebuild()` captures the note links before its round trip and puts them back after it. `settleTrack` now does the
   same for the track: capture, finish, restore.
2. **Master bars.** Reproduced for a pickup bar (`\ac`): inserting a beat moved `masterBars[1].start` in a rebuild and not in place.
   Chosen: the conservative option. An edit to a pickup bar, a free-time bar, a bar whose master bar holds a fermata, or a voice that
   holds one, is rebuilt (`inPlaceRefusal` says which, so a track's fallback reasons can be listed).
3. **Ids.** Reproduced (test 3): after another score was opened the counters sat inside the range of the live score's ids and a new
   note took an existing note's id. `raiseIdCounters` lifts the four counters above the score's highest ids before an edit creates
   anything (the highest ids are found once per score and carried to its successors). `verifyEditInPlace` and the fuzz now fail on
   duplicate ids (`duplicateIds`). **The full-rebuild path does not have the same cross-tab collision**: every build of a file parses
   it again, which sets the counters back to zero and numbers that build's objects in order, so ids are unique within each build; the
   fuzz asserts it after every undo (a full build) and the blank-project path, which does not parse, only creates objects in
   increasing order within one build.
4. **Coverage.** The fuzz now covers every staff and voice of every track; a fixture with a pickup bar, repeats, a fermata, plain lyrics,
   two voices, two staves and a percussion track; other scores opened between edits (counters reset); and undo and redo between edits
   (undo in place and by rebuild). The five of the owner's scores are fuzzed too (below). The fixtures found two more divergences that
   the first fuzz did not: the staff's set of voices that hold music is only ever added to by finishing (it now starts empty, and so
   comes out in a rebuild's order; test 4), and the let ring and palm mute marks of a rest depend on how many times a track was
   finished (a rebuild finishes twice, each edit in place once more), so a step that can change a beat into or out of a rest beside a
   marked beat is rebuilt (test 5; this one was found only by the owner's scores).
5. **Release safety net.** About 2 s after the last edit (cancelled by any new action) the document that was edited in place is compared
   with one rebuilt from the file and the history, in steps that give way to typing (`verifyEditStepwise`; the rebuild and the two
   descriptions are generators that yield every few thousand objects, and the check waits while `isInputPending`). On a difference
   the rebuilt document replaces it, the console says so, and a quiet note (en, et, de: `status.document_rebuilt`) shows in the
   status bar until the next edit. **What is true about exports** (corrected by the second review, see M1): the export dialog and GP export first await
   `controller.verified()`, which returns at once if the document's *score object* is the one a full build made or a check found equal, and
   otherwise compares it first. Which score is "known good" is tracked by the score object, not by a count of edits, so a settings edit
   (a page layout changed in the export dialog, a mixer drag) no longer makes an unchecked score look checked. Save writes native's project,
   which never held the in-place score. Other readers of the score (print preview, the playback plan) are not gated: the plan is built
   from the in-place score within a second of an edit, and a swap rebuilds it. Tests: the timer waits for the edits to stop,
   an injected divergence is repaired, a verified document is not checked twice. Cost, measured in node (cold, no UI, so an
   upper-ish bound on the work, not a replay of what the window feels): the whole check takes 2.8 s on the 6 x 200 score and 0.9 to 1.6 s on
   the owner's scores, in 13 to 21 slices; the longest slice that cannot be split (parsing the file, the final rebuild, the score's
   JSON) is 0.64 s on the 6 x 200 score and 0.2 to 0.43 s on the owner's scores. What the user would notice: if a key is typed during
   one of those slices (it starts 2 s after the last edit, and a new action cancels the check at its next step) the key waits for the
   slice, up to a fifth to a half second on a real score; nothing else changes on screen unless the documents differ. In the real
   window on the 6 x 200 score (three runs, one digit edit each, long tasks from 1.9 s after the edit on): 4 to 5 long tasks, the longest
   211 to 284 ms, 0.7 to 1.0 s in all, which includes the playback preparation's own JavaScript; the check compared once per edit and
   found no difference.
6. **Draw yields to input.** `isInputPending({includeContinuous:false})`, so a moving mouse does not delay a draw; the bound (6 frames
   of 16 ms, then draw) is unchanged.
7. **Following projection purity.** The result is cached by the score it was made for, so React running the render twice, or a render
   that is thrown away, edits the rendered copy once (test in `follow.test.ts`). Clicks during the gap: the rendered copy is edited in
   place, so a beat the edit left is still the object alphaTab laid out and is still found; a beat the edit removed is not (it is not
   there any more). Before, a new copy was made and nothing alphaTab had laid out was found until the redraw. The first draft of
   "copy only the touched track" was not done: a track copy costs a JSON round trip of the track (a sixth of 140 ms for six tracks, all of
   it for one) on every edit.
8. **Plan debounce.** The first change after a quiet spell builds its plan as soon as the change has been drawn (a frame and a task, at
   most 60 ms), not after 300 ms; only edits that follow within 300 ms, or arrive while a build is in flight, wait for the edits to stop
   and supersede one another. Playback is invalidated at once either way and Play never uses a stale plan.
9. **`sameData`.** Maps and sets are compared by their entries (keys by identity); two different ones are no longer "equal"; tested.
10. This note.

## Second review (M1 to M4 and the rest)

Each was reproduced as a failing test first; all four reproduced.

* **M1, a settings edit marked the in-place score as verified.** Reproduced (`controller.test.ts`: an in-place edit, the score corrupted, a
  mixer edit, `verified()` returned without comparing). The counter is gone: the controller remembers the *score object* that is known to
  equal a rebuild (set by a full build or an equal check), and a settings edit keeps the score object, so it keeps the doubt. Every action
  that ends while the document is unchecked (save, copy, lock, protect, an edit that records nothing, a settings edit, undo or redo of one)
  arms the 2 s check again.
* **M2, undo and redo in place had no fallback.** Reproduced with an injected throw (`controller.faults.test.ts`): native had acted and
  the controller rejected. A throw in `undoInPlace` or `editInPlace` after native acted now rebuilds the document from what native holds
  (the shared tracks are then dropped, so a half-edited redo cannot stay); a refusal by `checkEditInPlace` before a redo falls back to
  the full path instead of blocking it.
* **M3, notes and beats made in place could not be clicked.** The copy's objects get ids from the counters, so the document's new beat and
  the copy's new beat had different ids, and `canonicalBeat` looked the clicked object up by its id in a map keyed by the document's ids.
  The projection now also keeps the reverse maps by object (`renderedBeats`, `renderedNotes`), `ScoreView` uses them, and `follow.test.ts`
  checks every rendered beat and note, new ones included. The desktop driver does the real clicks: delete the beat under the cursor
  (Shift+Delete), insert one (Ctrl+Insert), click elsewhere, click the new beat, type a note on it, click elsewhere, click the note, and
  assert the status bar's bar, beat and string each time.
* **M4, the stepwise idle rebuild and the id counters.** Reproduced (`controller.faults.test.ts`: the counters put on the ids of the score's
  first note and beat between the steps: the check counted a mismatch and swapped in the corrupt rebuild). Three changes: the stepwise
  build puts the counters back to where it had taken them at every resume (`raiseCounters`); a rebuilt document that holds a repeated id
  cancels the check (it is never a repair); and a mismatch is never acted on from the stepwise result: a rebuild made in one piece is
  compared, and only that one can replace the document (if it equals the edited one, the check was a false alarm and says so in the
  console).
* **Idle check and playback.** The check waits while playback runs (or counts in) and is tried again each second; exports still verify at
  once.
* **The check's cost grows with the history.** Measured on the owner's largest score in node (cold), one slice per yield: after 0 edits
  1.0 s in 17 slices, longest 206 ms; after 200 edits (131 beat insertions and deletions) 30.6 s in 217 slices, longest 351 ms, 135 slices over
  100 ms; after 500 edits (357 of them) 103 s in 517 slices, longest 673 ms. The replay does a whole-score round trip for every edit that is
  not a plain note, rest or duration change; real histories hold far fewer than this random mix, but there is no bound. So past 12 such
  edits the idle check does not replay: it compares each track with the track a rebuild's round trip makes of it
  (`verifyTracksStepwise`: capture the links, serialize, deserialize, restore the links, compare). That costs 0.75 s in total and slices of
  at most 100 to 117 ms (up to 174 ms while other tests ran) after 0, 200 and 500 edits alike. It finds a derived state (a lookup, an index,
  a link, a chain) that an in-place edit left different from what a rebuild works out from the same notes; it does not replay the
  history, so it cannot find a note that was written wrongly. A difference found this way is confirmed by a rebuild in one piece before the
  document is replaced (which, on a long history, takes as long as the replay: it only happens when something is wrong). A real
  checkpoint (verify only the edits since the last verified point) would need `buildDocument` to start from a built score and its
  settings; that was not done.
* **`editsFitLive`** answers "unknown" (null) for a pair holding `deleteBeat`, for more than eight commands and for nested sequences
  instead of "false".

Also from the second round, because both sets of code are together now:

* **Typed fret digits.** A digit writes at once through `controller.edit`, which is the in-place path end to end. `applyInOrder`
  (auto-duration pair check, and the join's validity check) used to build a whole document per key; it now asks the open document
  (`editsFitLive`: checked on copies of the voices the commands touch, with the refusals of applying them) and only builds one when
  the open document cannot answer. `tryPreview` in pitch entry (`score-entry.ts`, `midi-capture.ts`) still builds a document per key.
* **Undo and redo in place.** Each edit applied in place keeps a journal (the touched voices' beats and notes, every note's fret, the
  links; 24 deep): undo restores it and finishes the track again, redo applies the edit in place. Native sees exactly what it saw
  before: apply, undo, apply for a two-digit fret; the history, the redo stack and the redo entry are unchanged. The rendered copy takes
  the undo in place too (its own journal), so the redraw after an undo does not make a new copy of the score. Undo is rebuilt when the
  document is not what the last in-place edit made, the edit before it was not applied in place, or the file's partial capo
  would differ.
* **One draw for a two-digit fret.** The join (write, undo, write) holds the score's draw until it is done (`holdDraw`), so the score is
  drawn once; there is no 1, original, 12 flicker.

## The equivalence check

(unchanged design; see the first version of this note) `describeScore` compares the serialized model with ids replaced by positions,
plus every plain field and link of bars, voices, beats, notes, staves, tracks and master bars. New since the first version: the private
fields are in it (that is where `_filledVoices` showed), ids must be unique, and the sets and maps are compared in order.

* `engine.in-place.test.ts`: rich file score (ties, hammer-ons, slides, bends, grace notes, a triplet, let ring, palm mute), a score
  with the extra features listed under 4, and a blank score; random edits on every staff and voice, other scores opened, undo (in place
  where the controller would) and redo between edits; every accepted edit compared with a rebuild, every refusal compared with the full
  path's message and checked to leave the document equal to the project. Seeds 3, 5, 6, 7, 11, 21 to 23, 31 to 34, 101, 202, 303, 404 were run.
* `engine.in-place.review.test.ts`: the sequences traced in the review, and the two found afterwards.
* `engine.in-place.owner.test.ts`: the same fuzz over folder of real scores named by `TP_OWNER_SCORES`, skipped when unset; its report
  holds counts and reasons only.
* `controller.test.ts`: in place edits, undo and redo each compared with a rebuild; native refusing; the idle check, a divergence repaired.

### The owner's scores

The five scores (89, 81, 141, 103 and 142 bars, six tracks each, drawn from real songs; only counts are kept here), 100 random edits
each (note, remove note, rest, duration, insert and delete beat, on every track, staff and voice), each compared with a full rebuild
with the final code:

* 500 edits: 430 applied in place and equal to a rebuild, 57 refused (by the full rebuild with the same message, and by the check on
  copies), 13 (2.9 % of the accepted ones) rebuilt instead of applied in place.
* The 13 were all "let ring or palm mute beside a rest" (an edit that turns a beat into a rest, or a rest into a beat, next to a
  palm-muted or let-ring beat); they were on 1 to 3 of the six tracks of each score (the guitar tracks that carry palm mutes). No other
  reason (pickup bars, fermatas, lyrics, pedals, timers, free time, reference timing) came up.
* An earlier run with the broader form of that rule (any edit but a duration change beside a mark) rebuilt 6.8 %; the first run, before
  that rule existed, found a real divergence on one score (a rest's palm mute mark), and the one before found the staff's voice set;
  both are in the review tests.
* The fallback rate decides how often an edit takes the old path: here about one in thirty edits, concentrated in palm-muted passages
  next to rests.


## Verification run

Final working tree after the second review, `develop` merged twice (1d00286, then d6aad14
with the tuning dialog; no conflicts). The primary-directory note of the environment changed twice (`stretch`, `sidebar`); every command
ran in the task's own worktree by explicit path.

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test -- --testTimeout=60000` | Node resource tests and the secret scan pass; Vitest 7300 passed, 8 skipped, 0 failed (the one failure of the first run, `gp-losses.test.ts`, put a score into the controller by hand and did not say it was the verified one; the test now does) |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | clean. Rust has not changed since the first round (status de-duplication in `device.rs`), when `cargo test --locked --workspace --no-fail-fast` passed: 2026 passed, 0 failed |
| owner-score fuzz (`TP_OWNER_SCORES`, 5 scores, 100 edits each, undo and redo in the other fuzzes) | passed: 500 edits over the 5 scores, 430 in place, 57 refused up front, 13 sent to the full rebuild (the let ring or palm mute beside a rest case) |
| `scripts/build-desktop-test.ps1` | built (merge and review fixes) |
| `node tests/desktop/edit-speed.mjs` | exit 0: digit edit median 197 ms drawn (worst 513), burst of 6 edits worst call 85 ms and 1 prepare, join 605 ms drawn once, undo 156 ms, cursor 12 ms, idle 0.6 %, real clicks on an inserted beat (bar 1, beat 5) and on the note typed on it (string 4) land on them, 3 edits compared with a rebuild with 0 mismatches |
| `editor`, `parity-entry`, `loop-through-edit`, `exports`, `parity-document-tabs`, `parity-mix-drag`, `parity-fret-typing`, `parity-track-click`, `parity-clipboard`, `parity-tuning-dialog`, `parity-workstation` | exit 0 each |
| M3 on the build from before the fix | the new click step fails there ("a real click on the inserted beat selects it"), as the unit test did |

`plan.performance.test.ts.snap` is rewritten by the run and was restored with `git checkout --`. macOS and Linux were not measured.

New Vitest files in the second round: `controller.faults.test.ts` (undo and redo faults, the id counters during the idle check, the long-history check),
additions to `controller.test.ts`, `follow.test.ts`, `apply-in-order.test.ts`.

## What remains slow, and the next step

1. **The draw is the floor, and it is much bigger on a real score.** On the 6 x 200 synthetic score it is about 100 ms of the 190 to 280;
   on the owner's largest score it is 400 to 650 ms (profile of one edit: `renderScore` about 390 ms, of which painting the systems about
   200 ms; about 130 ms of forced layout while placing overlays; about 170 ms of alphaTab inserting its own DOM, which is probably not shown
   in the page layouts, and was not tested). alphaTab 1.8.4 cannot lay out part of a score. Next steps in order of size: skip alphaTab's
   own DOM insertion where its output is not the one shown (about 170 of 450 ms on that profile); keep the laid-out systems of the
   bars an edit did not touch; then draw less than the whole score. On the owner's scores a single edit is therefore **not** at 200 ms:
   it is a little faster than before (the native call, the second copy of the score and the plan are gone), undo and redo are 2.5 to 3
   times faster, the cursor and the idle editor are fast.
2. A key typed while a draw runs waits for it (up to the draw's length): the draw cannot be interrupted.
3. Pitch-entry planning (`tryPreview`) still builds a whole document per key.
4. The plan's `scoreToJson` of the whole score runs on the main thread once per burst (70 to 140 ms).
5. Other edit types (selection edits, measures, tempo, redo of those) still rebuild; the list in `inPlaceTypes` grows by adding a type
   and its cases to the equivalence test.

## Limits

* Synthetic scores of identical bars and five real scores, one machine, Windows only; medians of a few repetitions.
* The draw yielding to waiting keys relies on `navigator.scheduling.isInputPending` (Chromium/WebView2).
* The equivalence checks are fuzzed comparisons over the edit types and features above, not a proof; the check in release builds is the
  idle comparison, which runs after the fact.

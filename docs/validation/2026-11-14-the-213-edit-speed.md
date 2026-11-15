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
   status bar until the next edit. **What "verified" means, and what is true about exports** (third review, N1): a document is *verified* only when it
   was compared with a rebuild made from the file and the whole edit log through the full edit path (or is that rebuild). There is no weaker
   notion: the shortcut of the second round (past 12 non-plain edits, compare each track with a round trip of itself) could not see a wrong
   fret or a beat inserted in the wrong place and is gone. The export dialog, GP export, other exports, Copy and Cut await a verified score
   (`controller.verified()`, `settled()`): a score object that a full build made or a check found equal returns at once, otherwise it is
   checked first, in slices that give way to input (in one piece when the window is hidden, where timers are throttled, and after three
   interrupted tries). A settings edit keeps the score object and so keeps the doubt. Save writes native's project, which never held the in-place score. The
   print preview and the playback plan still read the in-place score (the plan is built from it within a second of an edit, and a swap rebuilds it).
   See "Third review" below for how the real check is made affordable on a long history. Tests: the timer waits for the edits to stop,
   an injected divergence is repaired, a verified document is not checked twice.
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
* **The check's cost grows with the history.** Measured on the owner's largest score in node (cold), one slice per yield: after 200 edits
  (131 beat insertions and deletions) 30.6 s, longest slice 351 ms; after 500 edits 103 s. The second round answered that with a track-by-track
  self-consistency check past 12 non-plain edits; the third review (N1) found that this cannot call a document verified, and replaced it by a
  checkpoint (below).
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

## Third review (N1, N2 and the rest)

Each was reproduced as a failing test first.

* **N1, the long-history check was a self-consistency check.** Reproduced (`controller.faults.test.ts`): 14 `appendMeasure` edits, an
  in-place bug that writes fret 9 where the log says 5 (self-consistent, so a round trip of the same track agrees with itself), `verifyNow()`
  returned true and marked the score verified, and Copy, Cut and the export used it. (The reviewer's variant, a fret changed behind the
  score's back, is caught by the round trip too, because the derived pitch no longer matches; the reproduction therefore injects the wrong
  edit instead.) Fixed by removing the self-consistency path (`verifyTracksStepwise`, `replayIsHeavy`, `HEAVY_HISTORY` are gone) and making the
  real check cheaper:
  * The controller keeps a **checkpoint**: a detached copy of a document that was a real rebuild (or was compared with one and found
    equal), with the edit count it had. The first one is a copy of the document `buildDocument` made when the file was opened; it is made
    lazily, just before the first edit in place (or the first check) touches that document, and the same is done after every full
    build (a refused or non-note edit, a rebuilt undo). After every check that finds the document equal, the replayed document itself
    (detached from the open one) becomes the checkpoint.
  * A check replays only the edits after the checkpoint, through the full (non-in-place) path: `buildDocumentSteps(project, canRedo, from)` starts
    from `cloneDocument(from.built)` instead of the file and runs the same loop from `from.index`. It then compares the replay with the open
    document (`describeScoreSteps`, stepwise `firstDifference`, settings).
  * **Why checkpoint + replay is a rebuild.** The rebuild is a loop, `state = apply(state, edit)`, from the state the file gives, then a final
    `rebuild` of the score. The checkpoint is that state after `index` edits and the replay is the same loop continued from it: one replay
    split at a point it passed through. What is not true by construction is that the copy the replay starts from (the serialization round
    trip `rebuild` makes, the same one the loop makes after most non-note edits) changes nothing: finishing a track again is not always a
    no-op (the let ring and palm mute case that `inPlaceRefusal` knows). So it is tested, and a difference is never acted on from the
    replay alone: a replay that disagrees is decided by a rebuild from the file made in one piece (a false alarm only costs that rebuild; a
    real difference replaces the document with it).
  * **Tests of the equivalence** (`engine.checkpoint.test.ts`): random histories on a rich file score (ties, slides, bends, grace notes,
    two tracks) and on a blank score with added tracks and measures; edits in place and not (note, rest, duration, beats, sequences,
    `appendMeasure`, `removeMeasure`, `addTrack`), settings edits (`setTrackMix`), undo and redo; after every step the replay from the
    checkpoint is compared with a rebuild from scratch, a checkpoint above the length of the log (after an undo) or of another history is
    checked to be refused (`checkpointFits`) and discarded, and checkpoints are taken both from a real rebuild and from a replay result.
    Seeds 1 to 5 and 9 with 70 to 120 steps each passed. The owner-score fuzz also compares the replay from a checkpoint with the rebuild
    every tenth edit on each of the five scores. `controller.faults.test.ts` checks the controller side: the checkpoint advances with each
    equal check, an undo below it drops it, settings edits do not break it.
  * **Cost, owner's largest score.** In node (cold, one slice per yield; the typing mix is 75 % notes, a tenth beats inserted or deleted):
    opening takes 1.1 s, the checkpoint copy 122 ms (once). A check after 200 edits since the checkpoint: replay 3.4 s in 226 slices
    (longest 149 ms), comparison 1.1 s (longest 118 ms), 4.5 s in all, 15 slices over 100 ms (the whole-score round trip each beat edit makes;
    from the file instead of the checkpoint it is 5.1 s, longest 157 ms). After 500 edits since the checkpoint: 10.2 s, longest slice 157 ms,
    51 over 100 ms. Before the slices were split the longest were 278 ms (the replay) and 220 ms (the comparison): a rebuild's round trip now
    yields between writing the score out and reading it back (`rebuildSteps`), the description of a score walks one track per slice, and the
    difference of two descriptions is found stepwise (`firstDifferenceSteps`). Real window, same score, typed digits only (notes), a check
    two seconds after the last key: after 200 edits it ended 2.9 s after the last key with one long task of 126 ms; after 500 edits (300
    since the last check) 4.0 s, two long tasks, longest 102 ms, 174 ms in all. The shortcut it replaces showed 3 long tasks, longest 161 and 226
    ms. A check is made only when edits stopped for two seconds, so the replay is the edits since the last quiet moment, not the whole
    history. The slices that remain over 100 ms are beat edits, whose replay needs a whole-score round trip (the next step would be a
    per-track round trip, which the loop's links across tracks do not allow yet). In a long uninterrupted burst the check takes seconds, in slices.
  * **Found by the owner-score fuzz, after the first full run:** a replay from a checkpoint gave documents with repeated beat ids on four of the five
    scores. The copy keeps the ids of the document it was made from, and a counter that another import set back to zero hands them out again.
    The replay now raises the counters above the copy's ids before it creates anything (`raiseIdCounters`); `engine.checkpoint.test.ts` has the
    sequence (it fails without the line, with repeated beat ids), and it would have shown in the app after opening a second file.
  * **Copy and Cut** await a verified score, so a wrong in-place note cannot become a `pasteMusic` edit (test: an injected wrong fret, the clip
    holds the rebuilt one). `checkInPlace` (the sampled check) no longer marks the score verified before comparing, and a sampled check that throws
    leaves the document unchecked instead of failing the edit.
* **N2, memory grew without bound.** Reproduced (`engine.in-place.memory.test.ts`, WeakRef and forced collection): after 320 edits in place, all
  269 earlier scores and their rendered copies were alive. The lineage of a score named its predecessor, so the current score held every
  one since the last full build, each with its journal (the fret of every note of the track, the links, the voice snapshots) and its
  `followed` entry (a projection of four maps over the whole score and the copy's journal). Fixed: a lineage is cut after the eight steps
  `followProjection` can walk (`setLineage`), a score's journal entry is deleted once the next score holds it (the chain of `older`
  journals, 24 deep, is the only reference), and `followed` keeps the newest two projections. The test now finds none of the earlier scores or
  copies alive, and the chain of journals no deeper than 24. Heap in the real window on the owner's largest score, after a forced collection:
  the second round's build 51.7 MB at the start, 136.8 after 100 edits, 140.8 after 200, **200.5 after 300** (still growing); this build 51.8,
  126.3, 105.2, **90.9 after 300**, 90.9 after 400 and **91.2 after 500**. The extra heap over the start is the checkpoint copy, the journals
  and the projections, which no longer grow. The edit-speed driver checks the heap growth over 240 edits (budget 40 MB).
* **The queue.** `run()` cancelled a check when an action was merely queued, so an export's own check restarted for every action queued
  behind it. Now a check an action asked for (`owned`) is not cancelled by the queue; the idle check is (and runs only when the queue is empty: the
  queue re-arms it, `editNow`, `undo` and `redo` no longer arm it themselves, which let it run and swap in the middle of a queued job). Tests: one
  check for an export with three actions queued behind it (it ran twice before), and no check while a second edit waits (it ran once too early).
* **Close.** `DocumentController.dispose()` (called when the workspace drops a document) cancels the timer and any check and arms nothing
  more; a closed document is not checked.
* **`verified()` is bounded.** Three interrupted tries, then one rebuild from the file in one piece, compared and, on a difference, swapped in.
  When the window is hidden (timers throttled) the check is made without waiting on timers.
* **A rebuild that fails after native acted** (undo, redo or an edit healed by rebuilding) marks the document broken and the failure is thrown, instead of
  leaving the document silently behind native. (The first version still allowed saving; the fourth review replaced that, see below.)
* **`__tabplayerEditStats` and `__tabplayerCheckEdits`** exist only in development, in tests and in the desktop test build.
* **`gp-losses.test.ts`** no longer pokes a private field: `adoptVerifiedScoreForTest`.
* **Merge of `develop`** (click-to-seek and Space, 61ab5fb): conflicts in `App.tsx` (the `ScoreView` line: `holdDraw` and `onSelect={selectByClick}`
  both kept), `NativePlaybackController.ts` (`quietMs` and `sameTarget`) and its test (both sets of tests). A click-seek or Space that arrives while the plan of a
  just-edited score is not built is refused or kept waiting by their code (`ready`, five seconds); the plan is built after the edits stop (a frame
  and a task for the first edit, 300 ms for a burst) and native reports ready, which is the signal their code waits for. Test: seek refused while the
  plan of an edited score is not built, accepted once it is ready.

## Fourth review (the broken document, and three small items)

* **A document that cannot be rebuilt after native has acted.** The sequence the reviewer traced: the in-place check accepts an edit that the full
  replay refuses; the idle check's replay throws and so does the rebuild in one piece; the document was marked broken but Save was still
  allowed and wrote the edit to the file, which then no longer opened (`buildDocument` throws on every open); Save's `run` also cleared the
  alert. Reproduced as failing tests first (`controller.faults.test.ts`: an edit that `verifyEditStepwise` and `buildDocument` refuse, accepted
  in place). Now:
  * The message goes through `src/i18n` (`document.broken`, `document.broken_refused`, `document.taken_back_one`, `document.taken_back_other`
    in en, et and de). It says what to do: undo the last edit, or close without saving.
  * **Automatic take-back.** When the break is detected the newest edits are taken back at once: native undo, then a rebuild of what native
    holds, one edit at a time, up to the edits made since the last checkpoint (at most 16). When the rebuild succeeds the document is whole, verified,
    the checkpoint starts again from it, and a notice says "the last N edits could not be kept and were taken back" (the edits stay in native's redo
    stack). The check runs as an action in the queue, so it is serialized with everything else.
  * **If that does not make it whole** (native undo fails, or the bound is reached) the document stays broken. Then Undo is allowed and does the
    same one edit at a time (repeatable until a rebuild succeeds); Save, Save As, edits, redo, copy, cut, lock, protect and every export are refused
    with the translated reason; the alert stays (no action clears it, and an action queued before the break is refused when its turn comes);
    Close is allowed; the fifth review made it ask only whether to discard (it first closed silently).
  * **The recovery backup.** It is written by native from native's own live history, not by the window, and the window cannot hold it back. While a
    document is broken native still holds the bad edit, so a backup captured in that window has it. The automatic take-back removes the edit from
    native's history in the same task as the failed check, so in the normal case the next capture no longer has it as an applied edit; I did not
    check whether a backup keeps native's redo stack. A session restored from such a backup opens through the next item.
  * **Opening a saved history that does not replay**: a first version bisected the log and took the tail back at open; the fifth review removed it (below).
* **The idle check stops when playback or a count-in starts** (`holdVerification`, driven by the player's state instead of a gate read once at the start): a
  running check is cancelled and an armed one does not start; the check is armed again when playback ends. Checks an action asked for (export, copy) are not held.
* **`settled()` rejects when the document is closed while it waits** (`DocumentClosedError`) instead of returning an unchecked state; Copy, Cut and
  the exports ignore that error quietly.
* **`adoptVerifiedScoreForTest`** is a module-level seam that throws outside tests (`MODE==='test'`), no public method of the controller; the unused
  `skip` parameter of `describeScoreSteps` is gone.
* **The sampled check** (`editCheck`, every 25th edit in development) made the controller tests depend on how many edits earlier tests had made; the
  fault tests turn it off.

### Known limits, left for after the owner's test build

* A replay that disagrees with the open document is decided by a rebuild from the file in one piece (about 1.1 s on the owner's largest score, synchronous),
  not by a second replay from another checkpoint; a document that disagrees persistently would pay that once per idle check.
* After an undo below the checkpoint the check replays from the file (4 to 5 s in slices after 200 edits on the owner's largest score) instead of from an
  older checkpoint.
* The first checkpoint is copied on the first keystroke after opening (122 ms on the owner's largest score) instead of while the document is idle.
* Copy and Cut after a burst of edits wait for the check (in slices of at most 40 ms of work, 4.5 s after 200 edits since the last check and 10.2 s after
  500 in node on that score), during which the editor is busy and keys are refused.

## Fifth review (simplified: no open-time defence, saving and locking wait for the check)

* **The open-time defence is removed.** `DocumentController.create` is as it was before the fourth review: if the build fails at open, the original error is
  thrown. The defence counted in the wrong units (`projectCommands` includes the baseline edits and splits sequences, native undo takes back one
  history entry per call), changed the error for finalized and locked files, and was unbounded for an untrusted file (a crafted log makes about a
  million `bridge.undo` calls). It was not needed for the owner's build, because a bad edit can no longer be saved or locked in. A possible later feature,
  to be made natively with one "undo to index" call and bounds.
* **Save waits for the check.** Save, Save As and the "Save" answer at close all `await settled()` first (it costs nothing when the document is already
  verified). The idle check is held for the whole of playback, so before this a bad edit made during playback could be saved with Ctrl+S. If the
  check takes edits back, the save writes the healed history and the notice shows; at close the document stays open instead, so the notice is seen. Test:
  playback held, a bad edit accepted in place, then Save, Save As and the close-save: the file never holds the bad edit.
* **Locking waits for the check.** `setLock` and `protect` settle before they act, so a document is verified (and a bad edit taken back) before it is
  finalized or password-protected; native refuses to undo a finalized document, which is what left the document stuck. Unlocking (`setLock(null)`,
  `unlockEditing`) is allowed while broken, and the take-back is tried again after it. Tests: finalize with a bad edit pending (the undo comes before the lock);
  unlock while broken.
* **Loose ends of the broken state.**
  * `protect` no longer clears the alert after a refused password.
  * Closing a broken document (a tab, Close All, the window) asks only "Discard changes / Cancel" (`confirmDiscardBroken`, translated in en, et, de), never
    "Save": it names the unsaved work made before the break. A bridge without the question cancels.
  * The take-back bound counts history entries since the document was last known verified, not commands; when it stays broken the message says how many edits
    were already taken back.
  * A rebuild that fails with a `RangeError` or out of memory marks the document broken and shows the error without taking edits back.
  * A redo after a take-back goes through the full path (the document is built with the edit first), which fails before native acts, so the edit cannot be
    brought back, break the document and be taken back again in a loop; the redo is refused with the error.
  * The notice after a take-back says that Redo brings the edits back and that saving now drops them for good (en, et, de).
  * The broken message uses a stored reason and is rewritten as edits are taken back.

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

Final working tree after the fourth review: `develop` merged three times (1d00286, d6aad14 with the tuning dialog, 61ab5fb with click-to-seek and Space).
Every command ran in the task's own worktree by explicit path.

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test -- --testTimeout=60000` | Node resource tests and the secret scan pass; Vitest 7355 passed, 8 skipped, 0 failed (fourth review) |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | clean |
| `cargo test --locked --workspace --manifest-path src-tauri/Cargo.toml` | 2028 passed, 0 failed, 96 ignored (Rust is merged from two branches now; run on the tree before the last TypeScript-only commits) |
| owner-score fuzz (`TP_OWNER_SCORES`, 5 scores, 100 edits each, with the replay from a checkpoint compared with the rebuild every tenth edit) | passed on the final tree (5 of 5) |
| `scripts/build-desktop-test.ps1` | built three times this round; the last build is the tree reported here |
| `node tests/desktop/edit-speed.mjs` | exit 0 in every run. Digit edit median, key to drawn and free, on the 6 x 200 score, over five runs on a machine other work was using: 186, 228, 280, 237, 198 ms (the second round measured 197 and 230); an A/B of this build against the second round's on one score alternately showed no difference in the edit, undo (about 260 ms) or redo (about 270 ms) draw. Join 331 to 483 ms drawn once, undo 144 to 271 ms, cursor 11 ms, idle 0.1 to 0.3 % (it is measured after the idle check has ended), heap growth over 240 edits negative after a warm-up (budget 40 MB), real clicks on an inserted beat and on the typed note land on them, 3 edits compared with a rebuild, no mismatch |
| `editor`, `parity-entry`, `loop-through-edit`, `exports`, `parity-document-tabs`, `parity-mix-drag`, `parity-fret-typing`, `parity-track-click`, `parity-clipboard`, `parity-tuning-dialog`, `parity-workstation`, `parity-click-seek-space`, `parity-click-seek-repeat`, `parity-click-seek-backing`, `native-audio` | exit 0 each, on the final build |

`plan.performance.test.ts.snap` is rewritten by the run and was restored with `git checkout --`. macOS and Linux were not measured. The 200 ms median
is the hard requirement and is met in some runs and missed by up to 80 ms in others on a shared machine; the edit's own work (native call 13 to 17 ms, the
in-place edit and the draw) did not change in this round.

New Vitest files in the third round: `engine.checkpoint.test.ts`, `engine.in-place.memory.test.ts`, additions to `controller.faults.test.ts` and
`NativePlaybackController.test.ts`.

Fourth review, on its final build (rebuilt once, drivers `edit-speed`, `editor`, `parity-entry`, `exports`, `parity-document-tabs`, `parity-clipboard`,
`parity-fret-typing`, `parity-click-seek-space`: exit 0 each; the others of the third review's list were not rerun for this change, which touches the controller
and the translations only): `edit-speed` median 234 ms (worst 432), join 439 ms drawn once, undo 277 ms, cursor 11 ms, idle 0.3 %, heap growth over
240 edits negative; `npm run typecheck` clean, `cargo fmt --check` clean (Rust is unchanged since the third review, whose workspace run passed: 2028 passed, 0 failed).
The median is again above 200 ms on this shared machine in this run (earlier runs 186 to 280 ms; see the A/B above): the edit's own path was not touched.

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

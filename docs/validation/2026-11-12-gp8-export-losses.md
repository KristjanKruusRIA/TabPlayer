# GP8 parity F09: Guitar Pro export losses reported and pinned with authored fixtures (2026-11-12)

Linear THE-60, branch `agy/the-60-gp-losses`. The issue asks for authored independent fixtures for the known Guitar Pro 7/8 export losses, and for anything that stays lossy to appear in the export warning.

**This is partial.** No loss in the written file was closed except stale view entries on a partial export. The other families are now either reported in the warning or characterised by a test. Nothing here was opened in Guitar Pro 8.

## What "independent" means here

The tests assert on hand-authored GPIF fragments, on literal stylesheet bytes, or on the written archive decoded by a small decoder in the test. They do not export with TabPlayer and compare a re-read by the same library. The fixtures are written from the element names alphaTab's GPIF reader accepts, so they are independent of TabPlayer's writer but not of alphaTab, and they show nothing about what Guitar Pro itself does.

## By family

| Family | State | Evidence |
|---|---|---|
| Long links (ties, hammer-ons, pull-offs, slides) | **Reported.** The file holds only flags; on reopening the reader links by its own search. The warning counts every link that search would not restore to the same notes, lost or mislinked. | `gp-link-reach.test.ts`, `gp-link-search.test.ts` (reader rule on authored GPIF); `gp-losses.test.ts` (detector and written flags) |
| Slurs | **Reported.** Written only in the private `TabPlayerCurves` property. | `gp-losses.test.ts` |
| Curves | **Reported.** Bends and whammy bars over four points get no standard field; styles, sounding length and hidden notes are written only in `TabPlayerCurves`. A sounding length outside 0 to 16 is not read back at all and has its own line. | `gp-losses.test.ts` |
| Score and view relationships | **Fixed for track changes, reported.** A track-subset or reordered export no longer carries `PartConfiguration`, `LayoutConfiguration` and `ScoreViews/*` that described tracks by position; the warning says the views were rebuilt. | `gp-losses.test.ts` with a hand-authored three-track `PartConfiguration` and its own decoder |
| Empty chord-carrier timing | **Reported.** An empty beat carrying only a chord diagram is written as a quarter rest; a carrier the export cannot write is refused before the warning. | `gp-losses.test.ts`, existing `harmony-carrier.test.ts` |
| Mixed per-measure common and cut time | **Characterised; still refused.** GPIF has one global choice. The refusal is now shown before the warning is confirmed, not after. | `gp-common-cut-fixtures.test.ts` (literal `score.gpss` bytes) |
| Inherited defaults | **Characterised; still refused** when a bar next to inherited bars is changed. An unchanged file keeps both stylesheet members byte for byte. | `gp-common-cut-fixtures.test.ts` |
| Fermata units and holds | **Characterised.** The fermata is written exactly; playback ignores it, so the plan is identical with and without a Long fermata. The unit of Length is not established. | `gp-fermata-hold.test.ts`, `fixtures/fermata-long.gpif` |
| Gesture sound routes | **Characterised.** Slap, pop, tap and dead slap have their own routes; golpe plans as a plain picked note. | `gp-gesture-routes.test.ts`, `fixtures/gesture-routes.gpif` |

## The reader's link rules, as pinned

- **Tie:** the destination looks back at most three bars for the first note on its string, dead notes included, and ties to that note.
- **Hammer-on or pull-off:** the origin sees only the later beats of its own bar and the first beat of the next bar. A destination on a later beat of the next bar, or further, is not linked. A nearer note on the string is taken instead of the intended one.
- **Slide:** as the hammer-on search, for legato and shift slides only.

## Changes

- `src/interchange/gp-losses.ts`: `gpLosses(score)` is the one loss list for every Guitar Pro 7/8 export warning (document export, export dialog, batch conversion). `gpExportRefusal(score)` returns the message the export would throw for common/cut time or a chord carrier, and both app paths call it before asking.
- `src/export/selection.ts`: export selections keep note links through their clones, and drop the position-ordered view entries when tracks are left out or reordered.
- `src/interchange/gp.ts`: records when view entries were dropped; `harmonyCarrierRefusal` shares the carrier check with the export.
- `src/export/gp-warning.ts` and `batch.detail_losses` (`en`, `et`, `de`): the lead-in is "Differences in this file", because several lines describe data written differently, not left out.

## Found and left

- **MusicXML common time.** A MusicXML file with a common-time symbol on its first measure only loads as common on that bar and numeric on the rest, so Guitar Pro export and batch conversion refuse it as mixed. Pinned by `characterizes a MusicXML file with a common-time symbol on its first measure only`. The import is not changed.
- **View-style refusals.** A refusal that depends on imported view-style bytes can still come after the warning is confirmed.
- **View stylesheets and staff subsets.** `Content/Stylesheets/scoreviewN.gpss` is not pruned with the views, and a staff-subset selection does not prune views.
- **Loss lines are English.** They are literals like the existing curve lines; only the lead-in is translated.
- **Other export formats.** Because selections now keep note links, a hammer-on the reader could not rebuild is no longer dropped or re-pointed for MIDI, audio planning, ASCII tab and Guitar Pro 5 either; those exports now match what the app plays and shows. The Guitar Pro 5 warning does not mention such links. Bytes were not compared with the old behaviour, and rendered PDF output was not inspected.
- **Other refusals after the confirm.** A missing legacy stylesheet, a missing GPIF staff for curves and backing-audio errors can still throw after the warning.
- **Ties sharing one origin.** The tie detector examines each origin once, so a second destination on the same origin is not checked.
- **Buzz-roll wording** still says the roll "becomes ordinary tremolo picking", although the private property restores it in TabPlayer.

## Limits

- No Guitar Pro 8 run. Every statement about reopening is about alphaTab's reader, which TabPlayer uses.
- Synthetic and hand-authored scores only.
- A golpe sound, a played fermata hold, and per-bar common/cut export are not implemented.
- Cargo tests and the desktop drivers were not run; no Rust changed.

## Review

The slice was implemented by Sonnet subagents and reviewed by a Fable subagent. Its first review confirmed, by running code, that the export dialog path missed lost hammer-ons because the selection clones dropped links before the check, that a tie over a dead note was silent, and that a hammer-on on a staff without strings was silent. Those are fixed in the second commit, with the lead-in, wording and test-name findings. Its re-review of that commit found no confirmed defect: it cut a three-bar score with ties, hammer-ons, a slide, slurs and a continued bend at each bar and found no dangling link or half-set flag, and compared the tie detector's count with a real export and re-read for seven scores.

## Verification

Worktree `.worktrees/the-60`, 2026-11-12, after the second commit:

- `npm run typecheck`: no errors.
- `npm test`: Node resource tests 0 failures; Vitest 371 files passed, 3 skipped; 6394 tests passed, 7 skipped.
- The seven loss and fixture test files alone: 111 tests passed.

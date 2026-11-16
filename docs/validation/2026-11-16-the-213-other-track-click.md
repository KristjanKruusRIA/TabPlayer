# THE-213: a click on a note of a lower track (2026-11-16)

Branch `agy/the-213-other-track-click` (from `develop` bd1f4b9). Everything below ran on one Windows machine.

## Symptom

With several tracks shown in a continuous layout (parchment, vertical screen, horizontal screen), a click on a fret number of a lower track's staff did not select
that note or make its track active. With the top track active nothing changed; with a lower track active the cursor jumped to the top track. The page layouts were fine.

## Root cause (confirmed)

alphaTab 1.8.4 hit-tests a press itself (`_setupClickHandling`): `BoundsLookup.getBeatAtPos(x, y)` uses `y` only to find the **system**, then
`StaffSystemBounds.findBarAtPos(x)` and `MasterBarBounds.findBeatAtPos(x)` compare the bars of every staff by `x` alone, so the first (top) staff always wins. Its
`getNoteAtPos(beat, x, y)` then only looks inside that top beat. `ScoreView` took the resulting `beatMouseDown` beat as is (`downBeat` to App's `selectByClick`), so a
press on a lower track selected the top track's beat at the same x. The page layouts do not use alphaTab's press handling: `physicalDown` uses `hitTestScreenPages`,
which reads `y` against each bar's `realBounds`.

Evidence:

- Unit test over real bounds (`src/engraving/screen-pages.test.ts`, "hit test in the continuous layouts"): for a score whose beats line up in x across two tracks (one with two staves),
  `getBeatAtPos` answers with a beat of the first staff for a point on the noteheads of every staff.
- Real app, unfixed build: the new steps of `tests/desktop/parity-track-click.mjs` fail on the first click on track 2 in parchment at 100 %:
  `a click on track 2's fret number puts the cursor on that track (Editing Track 1, ...)`.

## What changed

- `src/engraving/screen-pages.ts`: the per-system part of `hitTestScreenPages` is now `hitTestSystem` (unchanged behaviour), and a new `hitTestBounds(bounds, point, lane?)` applies it
  to a point in the bounds lookup's own space (system chosen by `y`, then the beat or notehead of the staff whose bar contains the point, preferring the given lane among voices).
- `src/ScoreView.tsx`: the press position is recorded by the existing capture handler. For `beatMouseDown`, when `hitTestBounds` finds a beat in a **different bar** than the one alphaTab
  reported, that staff's beat (and the note under the point, if any) is passed to `downBeat`/`downNote` instead, and alphaTab's own `noteMouseDown` for that press is ignored. When the
  bar is the same, nothing changes at all (the same events, the same arguments), so the active-track behaviours (string from the click's y, shift-click, drag, double and triple click,
  click-to-seek and its coalescing, the count-in and loop refusals) run through the same code as before. A drag in the continuous layouts also reads its beat through
  `hitTestBounds` (preferring the drag's lane), falling back to alphaTab's lookup. The page layouts, `physicalDown` and everything under `src-tauri` are untouched; no edit type,
  schema or text changed. Systems painted lazily are not a factor: the lookup is layout geometry, not painted SVG.

## Tests

- `src/engraving/screen-pages.test.ts`: 4 new tests (root cause; the right beat and note for every staff of two tracks, including the second staff of one track; a point beside the
  notehead and a preferred lane never leaving the staff; null outside systems and for a non-finite point).
- `tests/desktop/parity-track-click.mjs` (new section): with all tracks shown, real mouse clicks on real fret numbers (the driver excludes bar numbers by size, rotated labels,
  and hidden staging copies, and checks each clicked number against the score's known content) down and up the tracks in parchment 100 % and 70 %, vertical screen, horizontal screen,
  vertical page 60 % and horizontal page 60 %. Each click asserts: the announced cursor is on that track and beat, the dock marks that track active, zero edits recorded, document not dirty.

Results are in the final section below.

## Limits

- The driver runs on the small generated score (three tab-only tracks); the large one was not re-run for this section. Standard-notation staves and the second staff of one track
  are covered by the unit test only, not by a real-app click. A click in the gap between two staves of different tracks keeps alphaTab's answer (the top staff's beat), as before.
- Drag selection across a lower track in the real app was not exercised; it is covered only by the unchanged `ScoreView.test.tsx` mocks and reasoning.
- The page layouts were driven at 60 % only for the new section (at 100 % the third track does not fit the pane).
- No ScoreView-level unit test of the redirect exists (the existing ScoreView tests use a mocked alphaTab); the driver is its proof.

## Results

- Unfixed build (the redirect disabled), final driver: `parity-track-click.mjs` fails at the first click on track 2 (parchment 100 %), as quoted above.
- Fixed build: `npm run typecheck` clean; `npm test -- --testTimeout=60000`: 430 files passed, 5 skipped; 7434 tests passed, 8 skipped (the performance snapshot was restored).
  An earlier run had 11 `ScoreView.test.tsx` failures because their mocked lookups have no `staffSystems`; `hitTestBounds` now treats that as no hit.
- Desktop rebuild, then drivers, all exit 0: `parity-track-click` (small), `parity-click-seek-space`, `parity-entry`, `parity-fret-typing`, `editor`, `playback-draw`.

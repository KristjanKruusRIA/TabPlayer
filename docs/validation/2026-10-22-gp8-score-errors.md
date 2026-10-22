# GP8 parity L05: score error display (2026-10-22)

GP8 marks measures whose rhythm does not fill the time signature. This slice adds the same check to TabPlayer: an inspector list, a score marker, and a viewer preference for the marker. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Inspector → Score errors (n):**
  - The list has one entry per voice whose written rhythm is shorter or longer than its measure, for example "Measure 2 · Guitar · Voice 1: 1 quarter note missing".
  - Each entry names the track, plus the staff when a track has several.
  - Entries for tracks hidden by the current track view are labelled "(track not shown)".
  - Clicking an entry selects the first sounding beat of that voice.
  - The section opens on its own only when a score starts with errors. After that, only the user opens or closes it.
  - A complete score shows "Every measure is complete."
- **What counts:**
  - Lengths are written lengths, added exactly, including dots, tuplets and fixed display durations. Septuplets and 9:8 groups therefore add up.
  - Grace notes take no time, and the time alphaTab lends them from a neighbouring beat is ignored.
  - An empty filler beat before a late-entering voice counts its length.
  - Not checked:
    - voices that hold only empty beats (unused voices);
    - free-time measures;
    - a pickup measure that is shorter than its time signature.
- **Score marker:**
  - Each error measure of a shown track is outlined once, across its notation and tab lines, with a dashed red border.
  - Several wrong voices in one measure share one marker, whose accessible label lists them all.
  - Markers follow re-renders, zoom, pagination, track changes and edits.
- **Preference:** the "Mark errors in the score" checkbox turns the marker on or off; the list stays either way. The choice is a viewer preference stored in WebView local storage (`tabplayer.scoreErrors.mark`), and it defaults to on when storage is unavailable.

## Evidence
- **Frontend:**
  - `src/editor/score-errors.test.ts`:
    - full bars and unused voices report nothing;
    - incomplete and overfull voices report their length in score order;
    - grace notes inside a bar, on the beat, or at the start of a bar never create an error, and an error voice starting with a grace selects the beat after it;
    - pickup measures are handled;
    - septuplet and 9:8 tuplets, free-time measures, and empty filler beats are handled;
    - errors on a second track and staff are named correctly;
    - the storage preference reads and writes safely.
  - `src/editor/ScoreErrorsPanel.test.tsx`:
    - entries select the error's first sounding beat;
    - hidden tracks are labelled;
    - the empty state and the marking toggle work;
    - the section does not reopen itself.
  - RED log: `.analysis/parity/score-errors-red.log`.
- **Desktop:** `tests/desktop/parity-score-errors.mjs` on a Windows desktop-test build, with a generated three-bar guitar score:
  - the score starts with no errors;
  - "Delete beat" on measure 2 lists "Measure 2 · Guitar · Voice 1: 1 quarter note missing" and draws one labelled marker over the measure;
  - the entry selects measure 2;
  - turning marking off removes the marker, stores `off`, and keeps the entry listed; turning it on brings the marker back;
  - Undo clears both the list and the marker;
  - playback is ready afterwards.
- **Verification:**
  - full `vitest`: 3357 tests. The load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files pass when run alone;
  - `tsc`.
- **Review:** an adversarial review found ten problems, all fixed and tested:
  - false errors from grace-note time borrowing;
  - false errors from tuplet rounding;
  - free-time measures were flagged;
  - empty filler beats were counted as zero length;
  - the marker covered only the notation line, and markers stacked when several voices were wrong;
  - the section opened and closed by itself;
  - selection could land on a filler beat, and errors on hidden tracks were not labelled;
  - a tooltip could never show;
  - labels could be measured in single ticks;
  - test gaps.

## Limits
- L05 is partial:
  - there are no GP8 error colour or style choices;
  - there are no playhead-colour or navigation preferences;
  - the marking preference lives in WebView storage, not native preferences;
  - there is no original-GP8 comparison.
- Reloading the desktop-test build ends its recovery session, so the desktop test checks the stored preference rather than reloading.

# GP8 parity L07: default view for opened and new scores (2026-10-22)

GP8's general preferences choose how scores first appear. This slice adds a saved default view. It applies to scores opened or created without a view of their own. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Inspector → Presentation → Default view:**
  - Settings: Default layout (the six display modes), Default zoom mode (Manual, Fit width, or Fit page for page layouts only), Default zoom (25–300%, decimals allowed), and Default tracks (Selected track or All tracks).
  - "Use current view" copies the open score's view. A custom track list belongs to one score, so it is saved as Selected track.
  - "Reset to standard view" restores Parchment, Manual, 100% and Selected track.
  - "Save default view" stores the choice, and is disabled while the zoom is out of range.
- **Panel behaviour:**
  - Typing a zoom makes the zoom mode manual, as the score display controls do.
  - Choosing a screen layout turns Fit page into Fit width, and the panel explains why Fit page is unavailable.
  - Saving never changes the open score.
  - If storage refuses the write, the default still applies until TabPlayer closes.
- **Where it applies:**
  - Scores created with New, scores opened from files or the library, the blank tab after closing the last score, and the blank score at a fresh launch all start in the default view.
  - Restored sessions, tabs already open, and re-activating an already-open file keep their own view.
  - The starting view is also sent to the native session, so it is restored later.
- **Storage:** WebView local storage (`tabplayer.viewDefaults`). Damaged entries are repaired field by field.

## Evidence
- **Frontend:**
  - `src/workspace/view-defaults.test.ts`:
    - the defaults round-trip;
    - damaged storage is repaired field by field, and Fit page becomes Fit width on screen layouts;
    - capturing a view saves a custom track list as Selected track;
    - the standard default equals the old fixed view;
    - the session fallback works and is reset between tests.
  - `src/workspace/ViewDefaultsPanel.test.tsx`:
    - editing and saving;
    - copying the current view;
    - Fit page is available only on page layouts;
    - out-of-range zoom is refused with a described error;
    - reset;
    - a typed zoom becomes manual and allows decimals;
    - a failed save is reported.
  - `src/workspace/WorkspaceController.test.ts`:
    - a new score starts in the default view and sends it to the native session;
    - the existing tab keeps its view.
  - `src/workspace/session-startup.test.tsx`: a fresh startup blank uses the default view even though native reports the standard one. The test fails without the fix.
  - RED log: `.analysis/parity/view-defaults-red.log`.
- **Desktop:** `tests/desktop/parity-view-defaults.mjs` on a Windows desktop-test build, with a two-track GP fixture:
  - the current view (130%, All tracks) is copied, switched to Vertical page and saved;
  - the stored value is checked, and the open score keeps Parchment;
  - New starts in Vertical page at 130% with All tracks;
  - re-opening the open file keeps its Parchment view.
- **Verification:**
  - full `vitest`: 3377 tests. The load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files pass when run alone;
  - `tsc`.
  - `parity-document-tabs.mjs` times out at its first startup wait on this machine, both with and without this slice's changes, so that failure predates L07.
- **Review:** an adversarial review found six problems, all fixed and tested:
  - the fresh-launch blank ignored the defaults;
  - default views never reached the native session;
  - typing a zoom kept a fit mode;
  - decimal zooms were flagged as invalid;
  - the zoom error and the unavailable Fit page were not announced;
  - the module session copy could leak between tests.

## Limits
- L07 is partial:
  - there are no startup "open" choices beyond the existing session-restore preference;
  - no default instrument view, style, notation profile or playback speed;
  - the defaults live in WebView storage, not native preferences;
  - unsaved panel edits reset when switching tabs;
  - no original-GP8 comparison.
- The desktop harness uses a fresh WebView profile per launch, so persistence across relaunch is covered by the stored-value check and the startup unit test, not by a relaunch.

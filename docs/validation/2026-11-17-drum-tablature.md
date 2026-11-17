# Drum tablature (THE-220) - validation, 2026-11-17

Branch `agy/the-220-drum-tab`, cut from `develop`. This note records what the owner reported, what was built, how each claim was checked in the
real desktop-test app (silent output; nobody listened to anything), what was found and fixed in that run, and what is not done. The earlier note
`2026-11-17-the-220-drum-tab.md` holds the three adversarial reviews and how each finding was settled.

## What the owner reported

On a drum track the "TAB" choice under Musical notation did nothing. He wants a tablature with numbers, as Guitar Pro shows.

## Cause

The inspector's TAB toggle recorded a `setStaffSettings` edit with `showTab`, but the score is rebuilt through a JSON round trip and alphaTab's
`Staff.finish` resets a percussion staff (`showTablature` off, no tunings), so nothing changed and each click added a no-op undo step. Separately
the score style "Standard + tablature" was enabled for percussion and silently drew standard notation only. alphaTab 1.8.4 cannot draw
percussion as tab at all (its tab renderer is hidden on percussion tracks and needs tunings).

## What was built

- `projectEngraving` (`src/engraving/projection.ts`) rewrites the display copy of the score JSON for a drum track whose engraving profile is
  `tablature` or `standardTab`: the percussion staff becomes, or is joined by, a six-line tab staff whose "fret" is the written standard
  articulation id (36 kick, 38 snare, 42 closed hi-hat, 91 rim shot, 92 half-open hi-hat, 49 crash ...). The converter is
  `src/engraving/drum-tab.ts`. The source score is never changed.
- Six lines, top to bottom: crashes, china, splash, reverse and clash cymbals; ride, bells and other metal; hi-hat family; toms; snare family;
  kicks. Hits that meet on one line at one moment move to the nearest free line (up first). More than six hits at one moment: the surplus is left
  off the tab and counted.
- The inspector's TAB and notation toggles on a drum track write the track's engraving profile with one `setEngraving` edit per gesture, nothing
  for the current value, and the notation that is the only one on stays focusable and inert. They no longer record `setStaffSettings` edits for
  percussion; old logs that hold such edits still replay.
- Found and fixed in this run: a pressed notation toggle turned dark under the pointer (below).

## How each claim was checked

### Build

- `node scripts/prepare-audio.mjs --offline` printed `Verified offline audio: 4865 regions, 4481 samples` (no download).
- The repository script `scripts/build-desktop-test.ps1` fails in this worktree because `prepare-library.mjs` refuses the junctioned library folder
  during `npm run build`'s `prebuild` step. A copy kept outside the repository, identical except that the frontend `beforeBuildCommand` ran only
  `copy-notices`, `tsc --noEmit` and `vite build`, built the test app (with `~/.cargo/bin` on PATH). The app was rebuilt after the CSS fix.
  Nothing in the junctioned `resources` folders was written to.

### Desktop drivers (silent output, port 9223)

| Driver | Result |
|---|---|
| `tests/desktop/parity-drum-tab.mjs` (first run, never run before) | exit 0: `drum-tab: 17 numbers drawn on the tab, ... all checks ran; PDF numbers read from the export hook` (the score fits the window, so centring was only checked as "in view") |
| `tests/desktop/parity-drum-tab.mjs` (after the fix to its multi-track step) | exit 0, same line |
| `tests/desktop/parity-drum-tab-views.mjs` (new, six tracks, 1920x1080 and 1366x768, en/et/de) | exit 0: 39 numbers drawn in each of the six runs; the seven-hit beat draws six |
| `tests/desktop/inspector-fixes.mjs` | `inspector fixes: 14 checks passed` (run twice, before and after the CSS fix) |
| `tests/desktop/parity-vst-instrument.mjs` | exit 0 |
| `tests/desktop/parity-drum-map.mjs` | exit 0 |
| `tests/desktop/parity-tuning-dialog.mjs` | exit 0 |
| `tests/desktop/parity-staff-groups.mjs` | failed at start (`driver - locator.waitFor ... .app-shell[aria-busy="false"]`) because the driver waits for the workspace to be idle before it closes the Library dialog, and the app is busy while that dialog is open; it is a stale driver, not a drum tab effect. With the two waits moved after `closeLibrary`: `staff-groups: 47 passed, 0 failed.` |

What `parity-drum-tab.mjs` covers: the starting state is standard only with the Tuning row unavailable; TAB adds exactly the written numbers (kick
36, snare 38, hi-hats 42/92/46, crash 49, ride 51, rim shot 91, toms); each toggle is one `setEngraving` edit and never a `setStaffSettings` edit;
the one notation that is on cannot be turned off (aria-disabled, focusable, no edit, explains why); three undos and three redos; a click on a tab
number names the same note the keyboard reaches; a kit hit added while tab is shown appears as a number and one undo removes it; the playback
cursor moves across the tab; the exported PDF pages carry the same numbers; the profile survives save, close and reopen; screenshots in en, et
and de.

### Driver defect fixed

The multi-track screenshot of `parity-drum-tab.mjs` set `tabplayer.viewDefaults` in localStorage; the screenshot showed one track (the saved
per-document view overrode it), so the "All tracks" shot was the same as "both". The driver now uses the toolbar's own track picker and asserts that
more text is drawn.

### App defect found by looking, fixed

In the Musical notation section, a pressed toggle under the pointer turned dark: `.track-settings button:hover:not(:disabled)` (a raised dark fill)
beat the pressed fill, leaving dark ink on a dark button ("TAB" unreadable right after clicking it). It affects the notation toggles of every track,
not only drums. Fix: one rule at the end of `src/workstation/track-panels.css` that keeps the accent fill under the pointer. Test:
`src/workstation/notation-toggle.css.test.ts` (reads the CSS text, since jsdom applies no stylesheet). Confirmed by section screenshots before and
after (`section-both-1920-en.png`).

### Screenshots and what they showed

Folder (git-ignored, never committed): `.analysis/desktop-smoke/drum-tab-views/` in the checkout that ran the drivers (48 files) and
`.analysis/desktop-smoke/drum-tab-*.png` (the driver's own). Names: `inspector-standard-`, `both-`, `tab-only-`, `both-all-tracks-`,
`tab-only-all-tracks-` and `section-standard-/both-/tab-only-`, each `<width>-<lang>.png`. The fixture is authored by the script: five guitar and
bass tracks and drums over four bars; one beat holds five hits at once (36, 49, 46, 51, 91), one holds seven (36, 38, 42, 49, 51, 45, 50).

Read by eye: all the English ones listed here, plus `both-1366-et.png`, `section-tab-only-1920-de.png` and the driver's `drum-tab-multi-track-en.png`.

- **Tab only (alone and in All tracks):** six lines with numbers on the lines the rule gives them (crash 49 on the top line, ride 51 on the second,
  hi-hat 42/92/46 on the third, toms 45/47/48/50 on the fourth, snare 38/91 on the fifth, kick 36 on the bottom). The digits are legible at 100 %
  zoom and at 1366x768. The seven-hit beat shows 49, 51, 42, 45, 38, 36 (the 50 is left off) and the inspector says "Hits left off the drum tab: 1".
  No tuning labels ("= C"), no string letters, no guitar furniture other than the "TAB" clef and the time signature, which alphaTab draws on every
  tab staff. The tab's rhythm stems hang below the staff and cross the bottom digits (36) as they do on a guitar tab.
- **Standard + tab (both):** the percussion staff, then the tab staff with its own time signature and the same numbers, with a comfortable gap and
  no collisions between the percussion stems and the tab. The accolade spans both, the track label ("Dr") sits between them, dynamics appear once,
  tempo once. In All tracks the staves of the guitar tracks above are unaffected and the drum pair has the accolade of the system.
- **Inspector:** standard only (TAB off, standard on), both, tab only: each readable in en, et and de; the explanatory note about left-off hits
  wraps in two or three lines and nothing clips sideways at 1366 wide (asserted: no horizontal overflow of the section). Estonian: "Noodikiri",
  "Trummitabulatuurist välja jäänud helisid: 1 ...". German: "Notation", "In der Schlagzeugtabulatur fehlende Anschläge: 1 ...".
- **Left, not drum tab:** in Estonian at 1366x768 the toolbar text "Tegelik suurus: 98.7%" overlaps the "Mahuta leht" button. Estonian wraps the toolbar
  to a second row there; the overlap is in the existing toolbar and is not touched by this work.

### Unit and project checks (final)

- `npm run typecheck`: clean.
- `npm test -- --testTimeout=60000`: `Test Files  453 passed | 5 skipped (458)` and `Tests  7665 passed | 8 skipped (7673)`.
- `node scripts/secret-scan.mjs`: `Scanned 1951 tracked files; 0 finding(s).`
- No Rust changed, so no `cargo fmt` or `cargo check` was run. The full test run rewrote `src/audio/__snapshots__/plan.performance.test.ts.snap`;
  it was restored with `git checkout --` and not committed.

## Limits

- The line is a fixed rule by kit piece, not Guitar Pro's per-note drum-tab line: the importers of alphaTab 1.8.4 drop that line. alphaTab 1.9
  draws drum tab natively; the upgrade is a separate project and would replace this work.
- At most six hits are shown for one moment (a beat across all voices, a grace beat counted on its own); the rest stay in the score, playback,
  MIDI and Guitar Pro export and are counted in the inspector.
- The numbers are the written sound numbers (the standard articulation id, or the output key when a hit has none). The track's drum map is
  ignored: it changes what is sent to a plug-in or MIDI port, not what is written.
- No digit entry on the tab staff: hits are entered from the drum kit, and a score click on the tab does not enter notes.
- The tab shows the number only. Dead notes, staccato, palm mute, accents, tremolo rolls and similar marks recorded on a drum hit are not drawn
  on it, and only ties between hits written alike (same number, same line) are kept.
- In standard + tablature the second staff is for alphaTab a tab-only staff, so it draws its own time signature, rests and rhythm stems.
- The tab or standard choice is stored in the track's engraving profile, which is TypeScript-only. A Guitar Pro export does not carry it; the
  exported score is the unchanged percussion staff.
- An older TabPlayer build refuses to open a project in which `tablature` was ever set on a drum track, because replay walks the whole log. Only
  internal `develop` builds have engraving profiles.
- A project that already held `standardTab` on a drum track now shows drum tab beside the percussion staff, on screen and in the PDF page
  profile "Document notation".
- Every drum edit while drum tab is shown re-projects the whole score (follow is off for such a track). It was not measured on a long score;
  the desktop run used four bars.
- Not checked: other layouts than Parchment, a score with several drum tracks, tuplets or grace notes on the tab in the real app, very dense
  100-bar drum scores, light theme, print preview, an actual printer, playback sound, High-DPI.
- Estonian and German strings were written without a native review. Nobody has judged the result by eye except from the screenshots above, by
  the person who wrote this note.
- Small review findings stay open and are listed in the earlier note: error shading on both staves, arrow keys by storage order, a print test that
  checks lines and the tuning header, a message when adding a staff to a tab-only drum track.

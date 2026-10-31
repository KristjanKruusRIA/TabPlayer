# GP8 parity U14: left-handed neck and neck with keyboard (2026-10-23)

GP8's instrument view can show a left-handed neck, and can show a neck and a keyboard at the same time. This slice adds both to TabPlayer's instrument view. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Left-handed:**
  - A "Left-handed" checkbox appears in the instrument view header whenever a neck is shown: Guitar, Bass, or Neck + keys.
  - Checking it mirrors the neck: the nut and open strings move to the right, higher frets run to the left, and the body is on the left. String order from top to bottom is unchanged.
  - Fret numbers are drawn outside the mirror. They sit over their mirrored frets and read normally.
  - Note marks keep their strings, frets and tooltips.
  - The image is named "Guitar fretboard, left-handed" (or Bass).
  - The choice is remembered for later views, through the browser's local storage. If storage is unavailable, it applies to the current view only.
- **Neck + keys:**
  - A new view mode, "Neck + keys", shows the neck above a keyboard.
  - Both instruments mark the same notes: those of the current staff, from the current Show focus (playing, selected beat, selected bar or next beat).
  - The keyboard range comes from that staff.
  - The neck is the one the user last chose (Guitar or Bass), otherwise the one the track's program suggests.
  - The header names the mode "Neck + keys". Left-handed applies to its neck.
- **Percussion:**
  - "Neck + keys" is disabled on percussion staves, and drums and keys never show the Left-handed checkbox.
  - Moving to a percussion track while Neck + keys is chosen shows the drum kit, and the mode list shows Auto.
- **The score is unchanged:** nothing in this view edits the score, its dirty state or its undo history.

## Evidence
- **Unit** (`src/instruments/handedness.test.tsx`):
  - the mirror transform, with fret numbers outside it and in mirrored order;
  - note marks inside the mirror keep their strings and frets;
  - the accessible image name, and the remembered choice;
  - both instruments in Neck + keys with the same pitches, and Left-handed in the combined view;
  - one staff on both instruments of a two-staff track;
  - the chosen bass neck on a non-bass program;
  - Auto shown after moving to drums;
  - the option disabled on percussion, and no checkbox for drums or keys.
- **Desktop:** `tests/desktop/parity-instrument-handedness.mjs` on a Windows desktop-test build:
  - **right-handed:** the nut is left of fret 12 on screen, and fret 0's mark is left of fret 3's;
  - **left-handed:** the nut moves right (x 314 → 795), fret 3's mark is left of fret 0's, and the fret number text has a positive horizontal scale, so it is not mirrored;
  - after Hide and Show the checkbox is still checked;
  - in Neck + keys, the fretboard marks and the active keyboard keys are the same E2–G2 pitches;
  - the document and its dirty state are unchanged, and there are no page errors.
  - `parity-instrument-focus.mjs` and `instruments.mjs` still pass on the same build.
- **Verification:**
  - full `vitest`: 3,430 tests. The load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files pass when run alone;
  - `tsc`.
- **Review:** an adversarial review found no mirrored or reversed text and no blocking defect. It reported five issues, all fixed:
  - on a multi-staff track, the keyboard marked notes from every staff while the neck showed one. Both now use the current staff;
  - after moving to a drum track, the mode list still showed the disabled Neck + keys;
  - the combined view ignored a Bass neck the user had chosen;
  - the mode list could clip "Neck + keys";
  - the new spacing also applied to the Keys-only view.

  It also noted that the two compact canvases may scroll in a short dock. The fixes were checked by the tests above, not by a second review.

## Limits
- U14 is partial:
  - the keyboard is shown under the neck, not in a separate panel or window;
  - the combined view has one neck, with no choice of a second instrument type;
  - the left-handed choice is stored per browser profile, not in the document or the app's settings;
  - in compact size the two instruments can need scrolling in a short dock;
  - no original-GP8 comparison.

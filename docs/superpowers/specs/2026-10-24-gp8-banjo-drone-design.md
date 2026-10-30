# S20: banjo short drone configuration

Date: 2026-10-24. Status: design. Row S20 ("Banjo short drone configuration") stays at its current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's track tuning offers a "banjo drone" for a 5-string banjo: the fifth string is short, its nut sits partway up the neck, and tab numbers its frets along the neck. TabPlayer treated the banjo as any 5-string staff, so a note on the drone string at neck fret 7 sounded seven semitones above open instead of two, and frets that the string does not have could be written. This slice adds the drone to a staff, makes every pitch derived from a string and fret honour it, and lets it be authored and shown. It adds no edit command and no dependency; a staff's settings carry it, as the partial capo does.

## What is known about GP files

- alphaTab 1.8 has banjo tunings (`Banjo Open G Tuning` and others, drone as the last entry) and writes `<Instrument>Banjo</Instrument>` on a banjo staff's tuning (MIDI program 105), but reads and writes **no drone, short-string or fret-offset property**. It names no such property anywhere in its GPIF reader or writer.
- The GP8 manual page for track tuning says only that the banjo drone is available for a 5-string banjo. It gives no fret offset, numbering or pitch rule.
- No GP8-written banjo file was available. **How GP8 stores the drone, and whether it numbers its frets as this slice does, is unconfirmed.** The slice therefore never reads a drone from a GP file and writes none: it keeps the sound correct on export instead (below).

## Behaviour

- **Meaning.** A drone is the neck fret its short string starts at (1-12; banjos use 5). It exists only on a staff of exactly 5 strings, and the drone string is string 1, the last tuning entry (alphaTab counts strings from the end of the tuning, so a banjo's `[62 59 55 50 67]` has the drone G4 as string 1).
  - Fret 0 is the open string. Frets 1 to the drone fret do not exist on it. Fret `f` above the drone fret sounds `f - drone` semitones above the open string, so with a drone at 5, fret 7 is two semitones up. Fret numbers on every other string are unchanged.
  - The capo acts on the drone string as on any string: key = tuning + capo on that string + fret - drone (for frets above the drone fret) - sounding transposition.
- **One place for pitch.** As for the partial capo, every pitch alphaTab derives from a string and fret goes through `Note.stringTuning`. `src/editor/banjo-drone.ts` wraps that getter once (on top of the partial capo's), adding `-drone` when the note is on string 1 with a fret above the drone fret. The playback plan, MIDI export, notation, harmony, clipboard and range edits follow with no per-feature copy of the rule. The few places that add a fret to `openStringKey` themselves use `fretKey`: the edit audition, `setNote`'s range check, the `setTuning` range check, staff-settings validation, and the instrument view's entry names and key-to-fret choice.
- **Storage.** A side table keyed by staff. The score-to-JSON conversion every clone goes through carries it in an extra field (`tabplayerbanjodrone`, only when a staff has one) and the JSON-to-score conversion attaches it before alphaTab finishes the score, so the pitch caches are right. A score without a drone serializes exactly as before.
- **Setting it.** `setStaffSettings` and `addStaff` take an optional `droneFret` in their settings: omitted keeps the staff's own, 0 clears it, 1-12 sets it, and any other value, or a non-zero value on a staff that is not 5-string, is refused. Rust and TypeScript apply the same rules.
  - Notes already on string 1 at frets 1 to the drone fret refuse the change; notes above keep their written frets and so change pitch, as a capo change does. A trill on the drone string keeps its fret interval.
  - A string count change is refused on a drone staff ("Remove the banjo drone in the staff settings first"); retuning at the same count is allowed.
- **Frets that do not exist.** `setNote` on a missing drone fret is refused. Because the range edits (transpose, move string, refinger, paste, theory chords) compute frets from pitch, every edit is checked afterwards: if any note sits on a missing drone fret the whole edit is refused with the bar and fret named. The range edits' own pitch checks use the same getter, so a transposed note is re-fingered when the arithmetic fret would not be real.
- **Controls.** The Staff panel gains "Banjo drone": a checkbox "Short drone string (string 1)" and a field "Drone string starts at fret" (default 5, enabled when checked). The fret commits on blur or Enter, the checkbox at once; "Apply staff settings" sends the command. An untouched staff sends no `droneFret`. An invalid fret keeps the last valid value, shows an alert and disables Apply staff settings and Add staff. The panel is disabled except on a 5-string stringed staff and resets when the selection moves; Apply is disabled when the document is finalized.
- **Readouts.** The instrument view's detail line adds "Banjo drone from fret 5 · string 1 fret numbers follow the neck". Its fretboard targets on missing frets are disabled and named "String 1, fret 3 does not exist on the banjo drone string"; targets on string 1 are named with the drone's sounding pitch, and clicking a key chooses the neck fret. The ASCII tab heading adds ", banjo drone from fret 5".
- **GP file.** Because no drone property is known, export writes the sound, not the drone: drone-string frets above the drone fret are written counted from the short string's own start (fret 7 is written as 2), the tuning is written unchanged, and the file reopens as a plain 5-string banjo with the same pitches. Reopening does not restore the drone, and the neck numbers are lost to GP. Repeated export and reopen is stable.
- **Saved logs.** Nothing is read from a base file and no existing command changes meaning, so an edit log written before this feature replays exactly as before: the field is absent from old logs, the pitch hook adds 0 without a drone, and the after-edit check does nothing without one. A log that uses `droneFret` is a new-feature log and is not readable on an older build (its strict command reader rejects the unknown key). A log written by the first commit of this slice (1336166, never released) that combined a drone with a tuning whose string 1 is not above string 2 no longer opens, because the drone now needs a high short string.

## Acceptance

- **Unit tests** (`banjo-drone.test.ts`, `banjo-drone-view.test.tsx`, `edit_types.rs`):
  - validation in TypeScript and Rust, including the same invalid cases and the 5-string rule;
  - drone 5 on open G: frets 0, 6, 7, 10 sound 67, 68, 69, 72 worked out by hand; drone 6 and capo 2 variants; other strings and a staff without a drone unchanged;
  - missing frets refused by `setNote`, by the settings, and after a range edit; the pitch-range check of the drone string;
  - keep, change, clear through `setStaffSettings`; the string-count refusal; trill interval;
  - the same pitches after a JSON clone, a library conversion, a full replay, and in the pitch caches of a clone;
  - the same pitches in the playback plan, the edit audition and a MIDI export read by an independent decoder; the GP export sounds the same, reopens as a plain banjo, and is stable on a second trip, with the model untouched afterwards;
  - an old log replays with the same pitches and no extension field;
  - the Staff panel's initial state, commit rules, omission when untouched, lock and 5-string rule; the instrument view's readout, names and disabled targets.
- **Desktop** (`tests/desktop/parity-banjo-drone.mjs`, one run by the controller): open an open-G banjo GP, set the drone from the Staff panel as one edit, check missing frets are unavailable, enter neck fret 7 on the drone string as one edit and see the native plan sound A4, undo and redo restore the project and the sound, and the exported GP read by an independent reader sounds the same pitches.

## Scope

- No new edit command: `tests/protocol.json` is not changed (a drone needs a 5-string settings example; the Rust and TypeScript unit tests cover the envelope).
- One drone per staff, always on string 1. Banjos with the short string elsewhere, or other short-string instruments, are not covered.
- Not carried: reading a drone from a GP file, and any GP-side drone flag (unknown); chord-diagram paste and the harmony library's saved-chord context compare only the capo; natural harmonics on the drone string are not specially treated.
- Range edits that would put a note on a missing drone fret are refused as a whole rather than steered around, except where they re-finger by pitch.

## Review round 1: changes

- **Missing frets are never candidates.** `planFingering` (refinger, transpose re-fingering, paste conversion), the transpose and pitch-target arithmetic checks, `moveSelectionStrings`, chord shape search and harmony-transposed diagrams all test `fretExists`. An open drone string can move up by any interval, and a move across the drone string converts fret and pitch both ways (`plainFret`/`neckFret`). The after-edit check remains as a backstop.
- **MusicXML** export of a drone staff writes the same plain frets as GP (counted from the short string's own start) with the same pitches, and nothing internal.
- **Tuning.** The drone needs string 1 (the last tuning entry) tuned above string 2, in TypeScript (settings, `setTuning`, JSON reload) and Rust; otherwise it is refused with a clear message.
- **Dead notes** on a missing fret do not block setting the drone. A drone change that would move a trill outside 0-127 is refused. The instrument view shows a trill alternation on the drone string at its neck fret.

## Limits to record

- A natural harmonic at neck fret 12 on the drone string sounds 74 in the app and 79 after a GP reopen, because GP gets the shortened fret.
- Chord diagrams are not converted on GP export.
- ASCII tab re-import reads fret 7 on the drone string as 74, since it knows no drone.
- The tab still draws a trill alternation on the drone string with the plain fret alphaTab computes from the stored pitch (an open-string trill to A4 shows (2), not 7); the instrument view shows the neck fret. alphaTab owns that drawing and it is not patched here.

## Review round 2: changes

- The trill range check runs only when the drone changes that trill's pitch, so a stored trill above 127 on a staff without a drone still replays.
- Dead notes are exempt from the missing-fret rules in fingering, the transpose and move checks, and the instrument view.
- A transposed chord diagram converts the drone string through the neck mapping before any search fallback.
- A harmony diagram on a missing drone fret is refused when it is set (`previewEdit`), never on replay.

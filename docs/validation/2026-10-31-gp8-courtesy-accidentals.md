# GP8 parity: cautionary (courtesy) accidentals, row N22

Written 2026-10-31 on branch `feat/slice-n22`. This replaces the first write-up, which claimed more than its tests showed.

## What the feature is

A checkbox "Cautionary accidental" beside the enharmonic spelling select marks one note. A marked note shows the accidental sign for its own spelling even when the key signature or an earlier note in the bar already supplies it.

- The mark is only a flag. It never changes the note's pitch or its accidental mode. Clearing it leaves the spelling exactly as it was (ForceFlat, mark, unmark is still ForceFlat; a Guitar Pro note with Default is still Default).
- The sign is worked out each time the note is drawn, from the note's current pitch, key and accidental mode. Because nothing is stored, a re-fret or transposition cannot leave a stale forced accidental (the earlier design stored one).
- Edits: `setNoteCautionary` and its alias `setNoteCourtesy`. One click is one edit. Choosing the current value sends nothing. While busy the box stays focusable (`aria-disabled`, via `busyGuard`) and refuses the click and Space. It is `disabled` only when there is no such note or the staff is percussion.
- The enharmonic select no longer takes `disabled` for busy either; it uses `busySelect`.

## How the sign is drawn, and the limit

alphaTab 1.8.4 draws an accidental only when the spelling differs from the key signature or from what the bar has already shown (`ModelUtils.computeAccidentalForSpelling`). It has no option to draw one anyway, and no field on `Note` for a cautionary sign. No setting of `accidentalMode` produces a sign for an in-key note (read from the alphaTab source, not rendered: a forced mode equal to the key's own spelling returns no sign).

So `src/editor/cautionary.ts` hooks alphaTab's `AccidentalHelper.applyAccidental`. That class is not exported, so the hook reaches it through one throw-away render of a one-note score and patches its prototype. For a marked note whose result would be "no sign", the hook asks alphaTab again with the bar's remembered accidental for that staff position set to a value no spelling can equal, which returns the sign for the note's own spelling.

Limits, stated plainly:

- This depends on alphaTab 1.8.4 internals (`_registeredAccidentals`, `_appliedScoreSteps`, the layout's `getRendererForBar` and the staff id). The engine is pinned at 1.8.4. If the hook cannot be installed, the mark is kept and saved but nothing extra is drawn; `cautionaryAccidentalsDrawn()` reports this. No UI shows that state.
- It assumes the renderer runs in the same JavaScript realm as the editor (`useWorkers: false`, which the app and the PDF path both set). A worker renderer would not see the hook.
- The sign is not parenthesised. alphaTab has no parenthesised accidental glyph here, and none was added.
- A note with accidental mode Force none, a tie continuation at the start of a bar, and a quarter-tone note are left as alphaTab decides.
- Percussion staves are refused (see below).

## What is proved, and by which test

Rendering (`src/editor/cautionary.test.ts`, SVG from `rendering.ScoreRenderer`, counting the SMuFL accidental code points U+E260 to U+E264 in the output):
- an in-key natural: no sign unmarked; exactly one natural sign when the second note is marked;
- a repeated F sharp in one bar: one sign unmarked, two when the third note is marked;
- a flat the key already has: one more flat sign when marked;
- Force none: still no sign;
- unmarking removes the sign; a save and reopen (native JSON) keeps mark and sign;
- re-fret from F to F sharp: the sign becomes a sharp, the accidental mode stays Default;
- for all seven accidental modes, mark and unmark leave the mode and sounding pitch unchanged; B flat with ForceFlat keeps drawing a flat.

Editing (`src/editor/pitch.test.ts`, `parity-replay.test.ts`, `SpellingControl.test.tsx`):
- the mark survives native JSON round trip; neither pitch nor mode changes;
- percussion staves are refused, and invalid targets and non-boolean flags are rejected without change;
- replay through `previewEdit` and `buildScore`: mark, re-fret, undo and redo; spelling kept through mark and unmark; percussion note refused;
- the checkbox is exercised with real `userEvent` clicks and Space, not `fireEvent.change`.

Guitar Pro 7/8 round trip (`pitch.test.ts`, `Gp7Exporter` then `ScoreLoader`): a marked note exports without error; pitch and whatever spelling Guitar Pro stores come back the same as for an unmarked note; the mark itself is not stored, so it is lost on re-import. The Guitar Pro writer has no cautionary field.

MusicXML (`src/export/musicxml.test.ts`): a score with cautionary notes exports (the first attempt refused the whole export). The marked notes get `<accidental cautionary="yes">` with the sign for their spelling (flat, natural), written even when the key supplies it; other notes are unchanged. Re-importing with alphaTab's reader keeps the pitches and loses the mark.

Wire format: `tests/protocol.json` gets the new example appended at the end, so existing positional slices in other tests are unchanged; the example count is 78.

## Not done, and not proved

- Rust cannot refuse percussion. `EditCommand::validate` checks the shape of one command with no score, so it cannot know a track's kind; the refusal is in the TypeScript engine, which replays every project (a log carrying such an edit fails to open). Rust accepts and round-trips the two commands (`cautionary_accidentals_roundtrip_and_validate`).
- Rust holds no note state, so there is no Rust copy of the stale-accidental logic to fix. The mark stores nothing but a flag.
- Not checked in the desktop app, by ear or by eye on a real window. Only SVG from the headless renderer was inspected.
- The sign is not parenthesised, and Guitar Pro and MusicXML re-import lose the mark.
- No review has been done on this version.

## Commands run

- `npx tsc --noEmit -p .`: no errors.
- `npx vitest run src/editor src/export --testTimeout=40000 --maxWorkers=2`: 82 files passed, 1 skipped; 1342 tests passed, 1 skipped.
- `npx vitest run src/App.test.tsx --testTimeout=40000 --maxWorkers=2`: 147 passed (an earlier run under cargo load lost a worker and was repeated alone).
- `cargo test --locked --no-fail-fast --manifest-path src-tauri/Cargo.toml`: 987 passed, 1 failed. The failure is `a_page_search_over_fifty_thousand_rows_stays_fast`, a timing test that fails under load; it was not touched and is unrelated to this slice.
- `src/harmony-commands.test.ts` now expects 78 wire examples (it expected 77).

## Behavior

A note can be marked to show a courtesy accidental. The sign draws in notation only on marked notes, and spelling is unchanged when the mark comes off. MusicXML writes `cautionary="yes"`.

## Evidence

See "What is proved, and by which test". After merging into feat/gp8-parity, `tsc` is clean, the full Vitest run had one failure, the MIDI guard rule for the new probe, fixed in the same change and rerun. `parity-harmony` and `parity-instrument-entry` pass on a Windows build.

## Review

A fresh Opus reviewer rejected the first version and approved 1b6dd57 with no fault of Medium or higher.

## Limits

The sign depends on alphaTab 1.8.4 private fields, so an alphaTab upgrade must recheck it. The mark is lost on GP and MusicXML re-import. Numbered and slash views show no sign, by code reading. MusicXML writes a sign on tie continuations where notation does not. Rust cannot refuse percussion targets. Not checked by eye in the desktop app. CI cannot run.

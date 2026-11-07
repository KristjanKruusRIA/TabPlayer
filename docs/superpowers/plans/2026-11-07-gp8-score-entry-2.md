# GP8 score entry, slice 2 (E05 / W19, THE-65)

Spec: `docs/superpowers/specs/2026-11-06-gp8-score-entry-design.md` (slice 1). This plan closes three of the limits listed in `docs/validation/2026-11-06-gp8-score-entry.md`: no double accidentals, an off-key note needs two gestures, and fast typing drops keys. It also adds GP8's everyday edit and cursor keys.

Research behind it: GP8's shortcut table (guitar-pro.com/docs/gp8/appendix/shortcuts) lists Ctrl+7 flat, Ctrl+8 natural, Ctrl+9 sharp, Ctrl+Alt+7 double flat, Ctrl+Alt+9 double sharp and Ctrl+Alt+8 Change Accidental. Shortcuts cannot be customised in GP8. The only documented note-entry preference is "Plus/Minus Keys Behavior", which swaps the + and - keys.

## Global constraints

- One gesture is one undoable edit. Choosing the current value records nothing.
- New UI text goes through `src/i18n` with `en`, `et` and `de` entries.
- A control holding focus never gets `disabled` for busy (`src/ui/useBusyGuard.ts`).
- No change to edit types, the `.tabplayer` schema or the edit log. `setNoteSpelling` already takes accidental modes 0 to 6 and is already an allowed `sequence` step.
- Key handlers ignore events from text fields, as the existing ones do.
- Match the accidental chords on `event.code` (`Digit7`, `Digit8`, `Digit9`), not `event.key`: on German and Estonian layouts Ctrl+Alt is AltGr and `event.key` becomes `{`, `[` or `]`.
- Tests: Vitest beside the code (`src/editor/score-entry.test.ts`, `src/editor/notation-entry.test.ts`, `src/App.test.tsx` or the existing App entry test file). Run `npm run typecheck` and the touched test files. Do not run cargo; nothing native changes.
- Help: update the in-app shortcut list (`App.tsx` near 637-643, keys in `src/i18n/en.ts` near 129) for each key added.

## Task 1: Double accidentals in entry, and Ctrl/Alt digits stop typing frets

Pure logic plus one guard.

1. `src/editor/notation-entry.ts`:
   - `EntryAccidental` (line 7-9) gains `'doubleSharp'` and `'doubleFlat'`.
   - `accidentalLabels` are English literals shown without `t()` in `NotationEntryPanel.tsx:83`. Move them to i18n. Reuse `palette.double_flat` and `palette.double_sharp` for the new two; add keys for the others if none exist.
   - `entryPitch` (57-63) maps accidentals to alteration -2, -1, 0, +1, +2. The pitch must stay 0-127, else the function returns null (or the existing refusal). The name writes `##` / `bb`.
   - `spellingFor` (122-126) returns `ForceDoubleSharp` (4) / `ForceDoubleFlat` (6) for alteration +2 / -2. A double never equals the automatic spelling.
   - alphaTab 1.8.4 has a double spelling for every pitch class except G#/Ab. Every natural letter with ## or bb lands on a class that has one (C##=D … B##=C#, Cbb=Bb … Bbb=A), so letter entry cannot hit the gap. Still guard it: if `spellingOf` (84-87) returns null for the requested spelling, refuse with an i18n message instead of letting alphaTab fall back silently. Task 2's re-spell uses the same guard.
2. `src/App.tsx:512`: the digit branch types a fret for Ctrl+digit and Alt+digit. Only plain digits (no Ctrl, Meta or Alt; Shift is not used there either) type a fret.
3. Inspector staff (`NotationEntryPanel.tsx`): the accidental choice offers the two doubles.
4. Tests: alteration, name and spelling for every accidental on all seven letters, the 0-127 bound, the guard (a spelling alphaTab lacks is refused), and an App test that Ctrl+5 and Alt+5 on the score do not set a fret while plain 5 still does.

Done when: entering a note with doubleSharp/doubleFlat from the inspector writes one `sequence` with `setNoteSpelling` mode 4/6, and the tests pass.

## Task 2: GP8 accidental keys, as a pending accidental and on the selected note

Depends on Task 1.

1. `scoreEntryKey` (`src/editor/score-entry.ts:25-43`) returns `{kind:'accidental', value}` for Ctrl+7 flat, Ctrl+8 natural, Ctrl+9 sharp, Ctrl+Alt+7 doubleFlat, Ctrl+Alt+9 doubleSharp, read from `event.code`. Ctrl+Alt+8 returns `{kind:'respell'}`. Meta counts as Ctrl on macOS.
2. Pending accidental, with note entry on: viewer state `pendingAccidental: EntryAccidental|null` next to `noteEntryOn` (`App.tsx:134`).
   - The chord sets it; the same chord again clears it.
   - The next letter (`App.tsx:475`) or score click (`scoreNoteEntry.onHit`, near `App.tsx:463`) passes it through `letterPitch` / `stepEntryPitch` (`score-entry.ts:70-83`, which hard-code `'key'` today) to `entryPitch`, so `planScoreEntry` builds the note and its spelling in the same one `sequence`. One gesture, one undo.
   - It clears after use, and on Escape, entry off, a selection change by mouse or arrows, and a document switch.
   - The hover ghost (`describe`, `App.tsx:464-468`) and the entry hint (`App.tsx:671`) show it. i18n x3.
3. Post-hoc, when a note is selected and no letter follows (entry mode on or off): if entry mode is off, or entry is on but the cursor is on an existing note, the chord re-spells the selected note with `setNoteSpelling` like the palette (`palette-actions.ts:159-161, 185-190`), one edit. Spelling only, the sounding pitch is unchanged. If the note cannot take that spelling (no candidate), refuse with a message and record nothing; choosing the spelling it already has records nothing.
   - Ruling for entry mode on: the chord sets the pending accidental when the cursor beat has no note on the active string/line; otherwise it re-spells the note there. Document the rule in the hint text.
4. Ctrl+Alt+8 (Change Accidental): re-spell the selected note to its other enharmonic candidate (cycle through alphaTab's candidates for that pitch class in a fixed order, skipping the current one). One edit; refuse when there is only one spelling.
5. Tests: key mapping (including an AltGr-style event where `key` is `{` and `code` is `Digit7`), the one-`sequence` plan with a pending accidental, clearing rules, post-hoc respell edit, nothing recorded for the current spelling, App-level one-undo.

## Task 3: Plus/Minus Keys Behavior preference and GP8 key aliases

Independent of 1-2 in code but touches `scoreEntryKey`; run after Task 2.

1. `src/editor/input-preferences.tsx`: add `swapPlusMinus: boolean`, default `false` (GP8 default: `+` shorter, `-` longer). Stored with the other preferences; old stored objects without it read as false. A checkbox in the preferences panel (94-103) with i18n x3.
2. `scoreEntryKey`: accept `=` as `+` and `_` as `-` (GP8 lists both), `Shift+.` as `.`, and `Shift+/` as `/`. With `swapPlusMinus` on, the two directions swap (aliases follow their key).
3. Tests for every alias, the swap, and reading an old stored preference object.

## Task 4: Entry key queue (keys typed while the previous note is still being recorded)

Run after Tasks 1-3. This changes the busy guard around entry: the controller gets a fresh adversarial review on the most capable model.

Today `entryBlocked` (`App.tsx:451-455`) refuses keyboard entry while `editBusy`, and shows `editor.entry_busy`. Keypad durations (`App.tsx:498`) and `Enter` (`App.tsx:515`) drop silently.

1. A bounded FIFO (a ref) of keyboard entry keys: letters, rest, durations, note moves, accidental chords, plain digits and Enter. Score clicks keep the busy notice.
2. Queue only while the busy state is this controller's own edit job (`state.busy` with no workspace transition and no lock). Lock and workspace transitions still refuse.
3. At most 8 keys, each at most 2 s old when it runs; on overflow keep the oldest and show `editor.entry_busy`; drop stale keys with a notice.
4. Drain one key at a time, each planned against the state its predecessor left (cursor and score). Do not drain from an effect keyed on `state.busy` alone: `controller.update({busy:false})` can render before the edit continuation sets the new selection (`App.tsx:242-253`, 448). Drain after the continuation has set the selection (for example a `settled` counter bumped after `setSelection`, or a cursor ref written synchronously).
5. Each key stays its own gesture and its own undo entry.
6. If a queued key is refused or does not land, clear the rest and say how many keys were discarded (i18n x3, with plural forms as the i18n module does them).
7. Clear the queue on mouse selection, arrows, Escape, entry toggle, view change, document switch, undo, redo, lock, and the score pane losing focus.
8. Tests with a deferred `applyEdit`: three fast letters land as three notes on three successive beats with three undo entries; a refusal mid-queue discards the rest with the notice; a selection change clears the queue; queued keys never land on another document.

## Task 5: GP8 edit and cursor keys

Run after Task 4 (shares the key handler). Wire keys to edits that already exist; no new edit types.

| Key | Action | Existing edit or logic |
|---|---|---|
| Backspace | Delete the note under the cursor | `removeNote` / `removeNoteByIndex` (`edit-types.ts:120,150`) |
| Shift+Delete | Delete the beat(s) in the selection, or the cursor beat | `deleteBeat` (`edit-types.ts:124`, command palette `command-palette.ts:59`) |
| Ctrl+Insert | Insert a beat before the cursor | `insertBeat` (`command-palette.ts:56-58`) |
| Ctrl+Shift+Delete | Clear the selection's notes | `eraseSelection` (used by cut, `controller.ts:145`) |
| Home / End | First / last beat of the cursor's bar | selection logic |
| Ctrl+Home / Ctrl+End | First beat of the first bar / last bar | selection logic |
| Shift+Home / Shift+End | Extend the selection to the bar's first / last beat | `rangeFromBeats` (`App.tsx:525-528`) |

- Only on the score pane, never in text fields, never while locked; busy follows Task 4's rule or the existing busy notice.
- Nothing to delete records nothing. Several beats deleted by one key are one edit (use the existing multi-beat path if `deleteBeat` takes one beat only: a `sequence` of at most 8 steps, else refuse with a message rather than splitting the gesture).
- The Del key alone keeps whatever it does today (check; do not take it over).
- Tests per key, including the no-op and lock cases.

## Task 6: Evidence and tracker

Controller does this, not an implementer.

- `docs/validation/2026-11-07-gp8-score-entry-2.md`: what was verified (tests, desktop driver run), and plain limits (AltGr layouts not tested on real hardware; GP7 writer Step/Accidental mismatch for forced spellings is a library baseline issue, not checked in GP8; voices, techniques and transport keys remain).
- Update E05 / W19 rows in `docs/validation/2026-10-15-gp8-parity-progress.md` and its JSON.
- Extend `tests/desktop/parity-score-entry.mjs` with a pending-accidental note, a double sharp, a fast three-letter burst and Backspace.

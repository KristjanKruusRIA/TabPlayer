# GP8 parity E05 and W19: GP8 entry keys, double accidentals and a key queue (2026-11-07)

This is the second score-entry slice (Linear THE-65), following [2026-11-06-gp8-score-entry.md](2026-11-06-gp8-score-entry.md). It closes three of that slice's limits:
- no double accidentals;
- an off-key note needs a letter plus a semitone move;
- fast typing drops keys while an entry records.

It also adds Guitar Pro 8's accidental, Plus/Minus, edit and cursor keys. The plan is `docs/superpowers/plans/2026-11-07-gp8-score-entry-2.md`. E05 and W19 stay partial (see Limits). No edit type, project schema or edit log changed.

## Behavior
- **Double accidentals in entry.**
  - The inspector staff offers double sharp and double flat. The score's accidental keys can make them too.
  - The note and its spelling (mode 4 or 6) are one `sequence`, so one undo.
  - An octave move keeps a double spelling.
  - A spelling alphaTab cannot draw for that pitch class is refused with a message instead of silently falling back.
- **GP8 accidental keys.** These are matched on the physical key (`event.code`), so AltGr on German and Estonian layouts still works. Meta counts as Ctrl on macOS.
  - Ctrl+7 is flat, Ctrl+8 natural, Ctrl+9 sharp, Ctrl+Alt+7 double flat and Ctrl+Alt+9 double sharp.
  - **With note entry on and no note at the cursor string or line,** the key sets a pending accidental for the next letter or click. The hint shows it, and the same key clears it. So an off-key note is one gesture and one undo.
  - The pending accidental clears on use, Escape, entry off, a selection change, a note move and a document switch.
  - **Over an existing note, or with entry off,** the key re-spells the selected note. It changes the spelling only, never the sounding pitch, and is one edit. Choosing the spelling a note already has records nothing.
  - Ctrl+Alt+8 cycles the note through its spellings.
  - Percussion staves get their own message.
- **Ctrl and Alt with a digit** no longer type a fret. Only plain digits do.
- **Plus/Minus Keys Behavior.** This is GP8's one documented entry preference, under Score input.
  - It swaps what `+` and `-` do. The default is GP8's, where `+` shortens and `-` lengthens. The entry hint follows the setting.
  - `=` and `_` work as `+` and `-`, and Shift+`.` and Shift+`/` as `.` and `/`.
  - A recognised typed character wins over the physical key, so `_` on German and Estonian keyboards lengthens rather than making a triplet.
  - Old stored preferences read as off.
- **Keys typed while the previous note records.**
  - Letters, rest, durations, note moves, accidental keys, plain digits, Enter and keypad durations wait in an ordered queue instead of being refused. The queue holds up to 8 keys, and a key older than 2 s is dropped.
  - Each key runs on its own, planned against the cursor and score its predecessor left. Each is its own undo entry.
  - A key runs only after the render carrying the previous key's new cursor has committed.
  - If a key is refused or fails, the rest are discarded and the notice says how many. After a refusal, further keys are refused until the queue is empty, so no note is skipped silently.
  - The queue clears on a pointer press in the score, arrows, Escape, the entry toggle, a view change, a document switch, undo, redo, a lock and the score losing focus.
  - Lock, workspace and save states still refuse keys, with a notice when waiting keys are dropped.
  - A cursor move made while a note records is kept: the note's own advance does not undo it.
- **GP8 edit and cursor keys** on the score pane. None of them work in text fields.
  - **Backspace** deletes the note under the cursor. With fret digits typed but not yet entered, it clears the digits first.
  - **Shift+Delete** deletes the cursor beat or a one-beat selection. Several beats are refused (see Limits).
  - **Ctrl+Insert** inserts a beat before the cursor.
  - **Ctrl+Shift+Delete** clears the selection's notes, as cut does.
  - **Home and End** go to the bar's first and last beat. **Ctrl+Home** goes to the first bar, and **Ctrl+End** to the last bar's first beat.
  - **Shift+Home and Shift+End** extend the selection to the bar's ends.
  - The edit keys are refused while locked or while keys wait. If one is refused, the keys typed after it are refused too. The cursor keys work like the arrows.
- **Help.** The in-app shortcut list covers every new key. All new text has en, et and de entries.

## Evidence
- **Frontend tests:**
  - `npm run typecheck` is clean.
  - `npx vitest run src/editor src/i18n src/controller`: 1176 passed, 1 skipped.
  - `npx vitest run src/App.test.tsx`: 212 passed.
  - In full combined runs under load, one existing App test ("passes canonical paper targets") can hit its 5 s timeout. It passes on its own.
- **Regression tests that fail without their fix** (checked by reverting each fix):
  - the queue's ordering against the naive drain (6 tests);
  - the render-commit wait;
  - the pointer clear;
  - the overflow and save refusal latch, and its release;
  - a thrown key being counted;
  - the latch after a refused edit key;
  - a cursor moved during an entry, including a move away and back;
  - the in-pane text-field guards;
  - the document-epoch clear of the queue and the pending accidental.
- **Desktop:** `tests/desktop/parity-score-entry.mjs` passed on a desktop-test build of `a757b5d`, three runs by the implementer and one by the controller. On top of the slice-1 checks, it checks:
  - Ctrl+9 then E writes one `sequence` with `setNoteSpelling` mode 3, and one undo removes it;
  - Ctrl+Alt+9 then F writes mode 4, sounding G;
  - `page.keyboard.type('CDE')` with no waits writes three edits on three successive beats;
  - Backspace removes a note as one edit;
  - `=` and `_` change the rhythm.

  WebView2 did not swallow the Ctrl+Alt keys. Screenshot: `.analysis/desktop-smoke/score-entry-gp8-keys.png` (not committed).
- **Review:** each task got a spec and quality review. The key queue had an adversarial review on the most capable model, approved after two fix rounds. The whole branch had a final review, approved after one fix round.

## Limits
- **AltGr chords** on real German and Estonian keyboards were tested only with simulated key events in tests and Playwright, not by hand.
- **Shift+Delete on several beats is refused.** `deleteBeat` is not a `sequence` step, and no single edit deletes a beat range. Closing this needs an edit-type change.
- **Not compared with GP8:**
  - Ctrl+End goes to the last bar's first beat;
  - Ctrl+Insert uses the cursor beat's duration, as the palette command does, not the entry duration;
  - the edit keys ignore key repeat, so holding Backspace deletes one note;
  - whether GP8's accidental keys change the pitch or only the spelling (TabPlayer re-spells only).
- **Queue notices:**
  - A refused key's busy notice can be cleared when the next queued key runs. The missing keys are visible in the score, but no message stays on screen.
  - When a palette, inspector or symbol edit fails, the waiting keys are discarded with a notice that gives no reason.
  - The busy notice for a score click shows only when the click is on the cursor (from slice 1).
- **Respell fallback:** the rare respell fallback names the note by its MIDI number.
- **Unchecked visually:** the longer entry hint was not checked at narrow widths in any language.
- **GP 7/8 export:** for forced spellings, flat and sharp as well as doubles, alphaTab 1.8.4's writer often stores Step and Accidental values that do not match the sounding pitch. TabPlayer reads its own exports back correctly. No exported file was opened in GP8.
- **Still open for W19:** voices (Ctrl+1..4, Alt+1..4, Ctrl+M), the technique and annotation letters, transport keys (Ctrl+Left/Right, Ctrl+Space, Alt+Left/Right), Ctrl+Up/Down track and Ctrl+G. Tab staff switching is deliberately not taken, because Tab moves focus.
- **Still open for E05:** MIDI input, nested tuplets, and a hit test that reads alphaTab internals.
- **Follow-up:** the queue logic is inline in `App.tsx`, which grew by about 180 lines. Moving it into its own hook is a follow-up.

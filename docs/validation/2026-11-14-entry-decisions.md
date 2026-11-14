# Entry decisions: lyric gap on cut, key age, writing while the score plays

2026-11-14. Branch `agy/entry-lyric-gap-key-age-play-toggle`. Three owner decisions. TypeScript only; no Rust or dependency change.

## 1. Cut through a held note on a track with lyrics: allowed

Decision: allow the cut and keep every later syllable on its note by writing a gap into the lyric text.

Design. The lyric format already has a token for "this beat takes no syllable": an empty chunk (`editor.lyrics_syntax_hint`: "Extra spaces leave blank beats"). `tokenizeLyrics` (`src/editor/lyrics.ts`) turns `one  two` into `one`, an empty token and `two`, and `placement` gives every note-bearing beat of the line, from its start bar, one token in turn, an empty token included. `_` is a literal syllable in this editor, so it was not used.

The form written. Checked against both parsers (this editor's `tokenizeLyrics` and alphaTab's `Lyrics`, which Guitar Pro 5 files go through; `src/editor/lyric-gap.test.ts`): a single space is one blank between words and at the start of a line in both. Directly after a hyphen alphaTab skips spaces (`ri- e` reads `ri-`, `e`), so there the blank is an empty comment and a space, `ri-[] e`, which both read as `ri-`, one empty syllable, `e`. An empty comment at the start of a line does not work in this editor (it drops leading comments together with the space after them, so `[] one` loses the blank) while alphaTab reads it as a blank, so no single form serves every position; the rule is the space everywhere except directly after a hyphen. MusicXML export ignores empty comments when it refuses lyric comments (`[]` is removed before the check), so the blank survives that writer too. Round trips through Guitar Pro 5, GPIF and MusicXML are tested for a gap after a hyphen, between words and at the start.

What the cut does (`perform`, `lyricGapPositions` in `src/editor/range-cut.ts`, `insertLyricGap` in `lyrics.ts`):

- For each lyric line with text (hidden lines too), the beats that take a syllable (anchor voice, first staff, from the line's start bar) are listed before and after the cut with their bar and tick span.
- A note's syllable stays on the piece that keeps its attack (the original beat) or, when the attack was cut, on the first piece left of it. Every other tied piece of any note, the later pieces of a head written as several tied beats as well as the extra pieces of a tail, gets a blank token at its place in the new beat order. A piece belongs to the beat before the cut whose time it lies in.
- Pieces are counted per note (`lyricPieceCounts`). A note with no piece left is a note cut away whole: its token is taken out of the line (`deleteLyricTokens`), so no later syllable moves; its syllable is lost from the text. That differs from a plain erase of a whole beat, which keeps the text and moves every later syllable one note earlier; inside a cut the later notes keeping their syllables was chosen over keeping the removed note's word. Every extra piece gets a blank. Example (note 0 head in two pieces, note 1 cut away, note 2 tail in three pieces, note 3 untouched, text `t0 t1 t2 t3`): `t0, blank, t2, blank, blank, t3` (tested token by token, plus a seeded property test of the rule over random layouts and ranges).
- `insertLyricGap` is linear: one pass over the line finds the token's offsets, tries the places a left-to-right search would try (at most a few, never a rescan per place), and writes exactly what the first, quadratic version wrote, except for the hyphen form above. A 100,000-character line takes a few milliseconds; the first version took minutes (it ran twice per cut and on every replay). The differential test runs the old version against the new one on 4,000 random lines. A blank before token 0 behind a leading comment still returns null and refuses cleanly (pinned); a cut cannot ask for it, because the first piece of the first note always carries token 0.
- It is part of the one `cutSelection`: one undo restores notes and text exactly; apply is a function of the document and the selection (replay equals the gesture, tested). `eraseSelection` and every other command are unchanged; an old-style log with `eraseSelection` and lyrics is tested to leave the text alone.
- Refusal: only if no place gives exactly the wanted token list (`editor.cut_refusal_lyrics`, en, et, de). No cut reaches it.

Limit: Guitar Pro 8 itself was not opened. The Guitar Pro 5 and GPIF round trips run through alphaTab's reader.

Tests (`src/editor/cut-sustained.test.ts`, `src/editor/lyric-gap.test.ts`): the three refusal tests were replaced; seen failing first (9 failed on the refusal), then passing: middle cut; first three eighths; startBar 1 line across the barline; two lines with different startBar; line after the cut region and empty-text line; `ky-ri-e`, `a-b-c`, `one _ three`, an existing blank; undo, redo and replay through the controller; hidden track (syllables on the same notes when shown again); no gap when nothing is added; purity; old-style erase log; Guitar Pro round trip (`exportGpInterchange` then `loadInterchangeScore`) with the syllables on the same notes, including a hyphenated line; `insertLyricGap` with comments, CR LF and line breaks.

Docs: the lyric row of the refusal table in `2026-11-14-gp8-clipboard-cut-sustained.md` was rewritten; the E08 remaining text in the tracker (md and json) no longer lists the lyric refusal. E02 does not mention it. No help text mentioned the lyric refusal.

## 2. Queued typed keys are judged each by its own age

`drainEntry` in `src/App.tsx` judges each waiting item by its own age: a chord or key that waited too long is dropped (chords are counted, keys named), and a fresh key behind it is kept and written at the cursor as it stands, in order. A key that only means something with the key before it is dropped with a stale one: the second digit of a fret and Enter after digits (so 12 never becomes 2), and a letter after a stale accidental chord or keypad duration (so a sharp does not become a natural, and the length is not wrong). The dropped keys are counted in the notice.

The notice is its own line (`droppedNotice`), apart from the input notice, so a written note, a cursor move, another notice or a refusal reason does not hide it; it shows together with a refusal reason. It is cleared by the next edit that lands more than 1.5 s after the last key was dropped (a fast typist keeps seeing it; one who paused does not), and with the document. Keys that a later discard throws away are counted in that discard's own notice. No explicit dismissal was added. The plural text no longer says "the first waited too long".

Tests (`src/App.test.tsx`, controlled clock): fresh key behind a dropped one; two stale and one fresh; digit pair; accidental and letter; keypad duration and letter (the last three failed with the dependent-key rule disabled); the notice staying through kept keys and cursor moves and leaving after a pause; notice together with a refusal reason; the MIDI capture case.

## 3. Write notes while the score plays

One per-user setting `writeWhilePlaying` (default on) in `InputPreferences` (`src/editor/input-preferences.tsx`, same storage key and per-field repair as the others), shown once in the View menu's Score input panel. The MIDI capture panel shows it read-only: a line when it is off, and a reason line while chords are being turned away (`midi_in.write_while_playing_off`, `midi_in.paused_playing`), not live. Text in en, et, de; no `disabled`; the checkbox sits in the View menu and does not close it.

Behaviour with the setting off and the transport running (`playing` or a count-in): the setting pauses NOTE ENTRY, meaning typed letters, Enter (it commits the typed fret as a note, in note entry or not; a paused Enter also drops the typed digits so the notice is seen) and captured chords. Nothing is queued. Durations (keypad, `+`, `-`, dots, triplets), accidentals, respelling, rests, and digits typed alone (they only build the fret) are not paused, nor is any other edit (Backspace, paste, palette); the setting's hint says so. An ignored typed key says `editor.entry_paused_playing` whenever that notice is not on screen (it is tied to the cursor, so after a move the next ignored key says it again). A chord is counted in the existing "did not reach the score" count with a reason line that follows the setting (it goes when the setting is switched on during playback). When playback stops entry works at once. Gates: `dispatchEntryItem`, `performItem` (a queued key), `dispatchChord`, `writeCapture` (a queued chord).

Tests: preferences (default, corrupt value repaired to on, panel control and hint), `src/App.test.tsx` (chord not written, counted, reason line, written after stop, nothing kept; typed key not written, the notice present, hidden by a cursor move and shown again by the next ignored key, navigation still works; a key and a chord queued behind an edit when playback began; durations not paused, digits and Enter outside note entry paused only at Enter; the chord line following the setting; off and stopped writes both; on keeps today's behaviour; count-in counts as playing). The earlier "appears once" assertions could not fail and were replaced.

Help: note-entry paragraph 4 and MIDI-input paragraph 3 (en, et, de).

Driver: `tests/desktop/parity-midi-in-entry.mjs` was extended: switch the setting off in the View menu (menu stays open), play, inject a chord and press keys, nothing written, one notice, chord counted with the reason, stop, a key and a chord are written, setting back on writes while playing.

## Verification

See the final report of the session for totals. Desktop test build made and drivers run on 2026-11-14: `parity-cut-sustained.mjs` passed, `parity-midi-in-entry.mjs` (extended) passed, `parity-midi-in.mjs` passed.

## Limits

- A cut that removes the last syllable of a hyphenated word leaves a trailing `ri-` in the text. This editor reads it as the end of the line, but alphaTab's raw-text reader drops it on Guitar Pro 5 re-import only (the per-beat syllables of the other formats are exact).
- A cut that takes whole notes out of a track with lyrics takes their words out of the lyrics; the clip carries no syllables (`clipboard-paste.ts` sets `beat.lyrics` to null), so Cut then Paste does not bring them back, while Undo does. The same range on note boundaries (`eraseSelection`) keeps the text. A notice after the gesture (never in replay) names how many words were removed and that Undo brings them back; the help (Selection, Copy, cut and paste) says so.
- `editor.cut_refusal_lyrics` is reached when removing a word would leave the line unreadable as it was: a word followed by a bracketed comment (the comment would swallow the space after it), or a word alone on a line that ends in a space. The message tells the player to remove the comment or tidy that lyric line, then cut again; tested with the score unchanged.
- No desktop driver covers the lyric gap; it is covered by unit tests and the Guitar Pro round trip. Guitar Pro 8 was not opened.
- The notice for dropped keys is shown only after the kept keys have landed, and is hidden once the cursor moves again, like the other input notices.
- The desktop driver does not cover a count-in; the unit tests do.
- The tie rule for dependent keys covers digits, Enter, accidental chords and keypad durations; other multi-key forms, if any are added, need the same treatment.

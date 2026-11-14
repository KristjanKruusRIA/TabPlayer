# THE-66: Cut through a sustained beat, and ranges that end inside one (E02, E08)

2026-11-14. Branch `agy/the-66-cut-sustained`. Both rows stay partial; see Limits.

## Why a new edit

`eraseSelection` removes the notes of every beat whose attack lies in the range. It never splits a beat, so a beat attacked inside the range but sounding past its end lost all its notes, and the part before a start edge was untouched. A recorded log may already hold such an erase (reachable through the API), so its meaning cannot change. Cut therefore records a new command, `cutSelection {selection}`, and only when it has to:

- A range whose edge is strictly inside a beat that holds notes **in its anchor lane**: `cutSelection`. The anchor lane is the lane the player shaped the range on, the cursor's lane (`controller.cutMusic(selection,mode,anchor)`, `eraseCommandFor`); the API default is the range's first lane. It is carried in the gesture and written first in the recorded selection, so replay needs nothing else.
- Every other single-track cut or erase (edges on attack boundaries of the anchor lane, edges inside rests only, note and bar selections), whatever the other lanes hold: `eraseSelection`, exactly as before, so these projects stay readable by older builds. A range over beats 2 to 3 of a guitar voice, broadened to a bass track that holds a whole note, still erases the guitar notes and leaves the bass note whole.
- Cut (not Erase) of a range whose edge is inside a note of a lane other than the anchor is refused as it always was ("Cut needs the range edges on note starts in the other voices and tracks"), because the clipboard would hold a piece of that note that the document keeps whole.
- Multi-track cuts: `removeMeasures`, unchanged.

Rust and TypeScript agree: `EditCommand::CutSelection` (strict fields, same validation as `EraseSelection`) in `src-tauri/src/edit_types.rs`, the shape in `src/parity-commands.ts`, the shared fixture in `tests/protocol.json` (count 84 to 85). A project whose log holds `cutSelection` cannot be opened by an older build: the older Rust rejects an unknown edit type. The project schema version is not bumped; the previous edit types (for example `tieSelectionToEarlierPitch`) were added the same way.

## What a cut does

1. Each lane's beat that an edge falls inside, if it holds notes, is split at the edge into tied pieces of plain or single-dotted written length (the same splitting Copy uses, `splitRangeEdges` in `clipboard-subdivide.ts`). The first piece is the original beat and keeps every beat property.
2. The notes of every beat attacked inside the range are removed as an erase removes them (`range-cut.ts`): links are severed with `detachNote`, the beats stay as rests of their written length.
3. Only the anchor lane's beats are split. Other lanes are erased by attack, as an erase always did. The part outside the range stays as a shorter beat with its notes. A tail after the end edge carries what sounds (pitch, dynamics, let ring, palm mute, vibrato, ghost, duration percent, beat dynamics, ottava, hairpin and so on) and starts as a plain attack, with no accent, fingering, text, lyric, chord or stroke: those were attack marks of the removed part.
4. The clipboard content is the same clip Copy gives for the range.

One gesture is one edit: `DocumentController.cutMusic` records one `cutSelection`; undo rebuilds the document from the log without it, so everything returns exactly (test compares the whole score JSON).

## What is kept, severed or refused

| Case | Result |
| --- | --- |
| Tie, slur, slide or hammer/pull between a kept note and a removed one | Severed, as an erase severs it. The note outside the range keeps its length; a note after the range that was tied from the removed part starts as an attack. |
| Tied chain across a barline, cut inside the second bar | The tie into the kept head stays. |
| Tuplet beat | Pieces keep the tuplet ratio and the group keeps its total. |
| Dotted and irregular lengths | Fewest plain or single-dotted values, longest first, at most four per side. |
| Cut with no exact written length (for example 640 ticks into a dotted half), more than four pieces, a cut on a triplet position inside a plain note | Refused before anything is recorded, with the reason. |
| Bent or continued-bend note, trill, dead note, whammy beat, overridden written length, free-time bar | Refused with the reason. |
| Grace notes of a removed attack | Removed with it. |
| Several voices | Each addressed voice is cut; others are untouched. |
| Fermata, beat text, lyric, chord diagram, dynamic on the removed part | Stay where they are on the rests, as after an erase. Nothing is deleted except notes. |
| A selection that is not a range | Refused by `cutSelection` in TypeScript and in Rust validation (the notes and bars kinds are the plain erase). |
| Track lyrics (any line with text, hidden lines too), and the cut adds note-bearing beats after the lines' start bars | Allowed (owner decision, 2026-11-14). Managed lyrics give one syllable to every beat with notes, tied or not, so a surviving head plus a tail, or a tail written as several tied beats (a whole note with its first three eighths cut leaves a half and an eighth), would push every later syllable of a line onto the next note. The cut therefore also writes one **blank token** into each such line's text, in the same edit: a blank token is an empty chunk (a double space), which the lyric format already has ("extra spaces leave blank beats", `tokenizeLyrics`/`placement` in `lyrics.ts`) and which Guitar Pro reads the same way. For each line with text, the beats of the anchor voice from the line's start bar on are listed before and after (`syllableBeats`). A note's syllable stays on the piece that keeps its attack, or on the first piece left of it when the attack was cut; every other tied piece of any note (a head written as several tied beats as well as the extra pieces of a tail) gets one blank token at its place in the new beat order, counted against notes that left no piece (`lyricGapPositions`, `insertLyricGap`). A note cut away whole (no piece left) has its token taken out of the line so later syllables keep their notes (the earlier wording, that a falling count moves later syllables, no longer applies to `cutSelection`; `eraseSelection` is unchanged). A middle cut gives the new attack after the cut a blank beat; the first three eighths of a whole note give the second tail beat one. The blank is one space, except directly after a hyphen where it is an empty comment and a space (`ri-[] e`), because Guitar Pro's and alphaTab's readers skip spaces after a hyphen; the choice and its tests are in `2026-11-14-entry-decisions.md`. The token is placed so the line's tokens are exactly the old ones with an empty one added, in one linear pass, so comments, line breaks, hyphens and underscore tokens stay as written. A line that starts after the cut region, a line without text, and a line whose range holds no new beat are not touched; a line that has too few syllables to reach the new beat needs nothing. Hidden lyrics get the same text change, so their syllables land on the same notes when shown again. Everything is part of the one `cutSelection` (one undo restores notes and text; replay is a function of the document and the selection); `eraseSelection` never touches lyric text. The only refusal left is for a line where no single space gives exactly that token list (not reached by any tested text; message `editor.cut_refusal_lyrics`, en, et, de). |
| A refused cut | Nothing is changed: the cut is first tried on a detached copy. |

After a cut the rebuild that follows an `insertBeat` or `deleteBeat` also follows a `cutSelection` (`engine.ts`), so later edits in a log see the same beats a rebuild gives. A hostile `cutSelection` in a log (wrong selection kind, ticks out of range, an undecomposable cut) fails the replay through the existing invalid-edit handling.

Refusal texts are in the interface language (`editor.cut_refusal_*`, en, et, de) and reach the player through the controller error, as the engine's own refusals do. Because the refusals are in the edit, a log can never replay into a half-applied cut.

## Round trip

Cut then paste of the clip at the cut start restores what sounds: per voice, the same notes at the same ticks and lengths. It does not restore the tie at an edge: a note cut in two pieces is struck again at the join (the pasted tail is a plain attack, as Copy documents), so a sustained note becomes two touching notes of the same pitch. The help says so (Selection, Copy, cut and paste). The test compares touching same-pitch notes as one.

## Replay

- An old-style log holding `eraseSelection` over a range that cuts a beat builds to exactly what it always did (the beat keeps or loses its notes whole): `cut-sustained.test.ts`.
- A log holding `cutSelection` replays to the same document the gesture produced (ids aside).
- Ordinary cuts keep recording `eraseSelection`.

## E02: a range that ends inside a note

The editor still starts a range on an attack, but its end can now move by the entry duration.

- Keys: `Alt+Shift+.` moves the range end later, `Alt+Shift+,` earlier (physical period and comma keys). The step is the entry duration, or the cursor beat's duration when none was entered. The end stops at the score end, and a move that would reach the start is not made. Plain `Shift+Left/Right` is unchanged.
- Why not `Alt+Shift+Left/Right`: it already extends the selection by measures (`gp8-keys.ts`), as `Ctrl+Left/Right` does, and `Alt+Shift+Up/Down` moves a note while note entry is on. The brackets step the speed and `Shift+L` loops. `Alt+Shift+period/comma` was free in every key table, does not meet the Windows layout switch (`Alt+Shift` alone) and is no WebView shortcut. Not verified on other layouts beyond the physical-key rule used for the brackets.
- Band: the selection band stops part of the way through the last beat's drawn span, by tick (`toFraction` in `passage-bands.ts`, `rangeEndFraction` in `range-selection.ts`), and the end handle follows. It is linear in the drawn beat span, which is how the renderer places a beat's content approximately, not an exact timeline.
- Status: when an edge is inside a beat the selection summary reads "from measure M, beat B to measure M, beat B" with fractions (`editor.range_extent`); otherwise the old summary is unchanged.
- Page layouts (vertical page, horizontal page, grid) cannot draw it, so the gesture is refused there with a message; it works in the screen layouts. A range made in a screen layout and then shown in a page layout keeps its summary text (the measure and beat where it really ends) and is drawn as whole beats: the band for several beats, a marker for one; nothing is hidden.
- The Delete-notes key and the Erase selected notes button use `cutSelection` for such a range, so the part of the note after the end edge is not erased.
- Edits that act on every note that starts in a range (transpose, move string, refinger, sustain, strokes, tie) are refused as a gesture when the range ends inside a note of its anchor lane: "applies to whole notes that start in the range". Recorded logs are not touched.
- Help: Selection topic, new paragraph, the keyboard list, and the shortcut catalog (`keys.chord_range_edge`, `help.shortcut_range_edge`).

## Tests

Rust: fixture round trip and unknown-field rejection (`tests/protocol.rs`), accept, round trip, missing field, exact envelope and invalid selection for `cutSelection` (`edit_types.rs`). TypeScript: `cut-sustained.test.ts` (36), `range-edge.test.ts`, the Alt+Shift+period/comma test in `App.test.tsx`, a band-fraction case in `passage-bands.render.test.ts`, and the changed Cut expectation in `clipboard-subdivide.test.ts`. The Rust fixture was seen failing first (unknown variant). The TypeScript tests of the first round were written before the code but first run after it, and the review-round tests (anchor lane, hostile logs, lyrics, rebuild) were written alongside their fixes, not run before them. Rust validation also rejects `cutSelection` over a notes or bars selection (reject test in `edit_types.rs`).

`tests/desktop/parity-cut-sustained.mjs` was run against the desktop test build on 2026-11-14 and passed: on a blank score with bar 1 made `[half note, quarter, quarter]`, Shift+Right selects two beats, `Alt+Shift+,` twice puts the range end 960 ticks into the half note (summary "from measure 1, beat 1 to measure 1, beat 2"), moving the end and Copy record nothing, Cut records one `cutSelection` (range end `{bar 0, tick 960}`), the exported MIDI then holds one note from tick 960 to 1920, Undo gives the whole half note back (0 to 1920), Redo, Save, Paste records a `pasteMusic`, and after a restart the saved log replays to the same note (start, end and key compared). A screenshot of the band stopping part-way through the half note was taken. The keys only make ranges whose end is inside a note, so the driver covers that case; a start edge inside a note, a middle cut, tuplets, ties, grace notes, several voices and the refusals are covered by unit tests only. The Delete key, the page-layout refusal and the whole-beats-only refusal were not driven in the real app.

## Limits

- A range that starts inside a beat, which only the API can make, still draws its band from the first attacked beat. The editor never makes one.
- Only the anchor lane's beats are split. A range edge inside a note of another voice or track is refused for Cut and is left whole by Erase.
- The band inside a beat is a linear interpolation of the drawn span.
- The round trip does not restore ties at the cut edges (see above).
- Page layouts refuse the end-moving gesture.

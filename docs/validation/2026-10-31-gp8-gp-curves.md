# GP8 parity: bend and whammy curves, quarter tones and explicit slurs through the GP writer (T07, T09, T10)

Branch `feat/slice-gpcurves`. The parity progress files are untouched; the status changes below are proposals only.

## Behavior

Before this change the GP writer and reader (alphaTab 1.8.4 underneath) lost these on a round trip:

- **Bends and whammy bars with more than four points.** The writer omits the bend or whammy node entirely.
- **Interior points of a four-point or shorter curve.** GPIF has an origin, one middle value with two offsets, and a destination. A three-point curve gains or loses a point, and the reader rebuilds a two-point whammy as four.
- **Fractional values (quarter tones).** The reader truncates each value to a whole unit, so `1.5` becomes `1` and `-5.5` becomes `-3` after the middle value is shared.
- **Curve style** (`Fast`, `Gradual`). GPIF has no style field, so it reverts to default.
- **Curve type.** The reader re-derives it from the points and can pick a different one.
- **Explicit note-to-note slurs.** GPIF only has beat `Legato`, over adjacent beats. alphaTab never writes or reads a note slur, so a slur that skips a beat or changes string is dropped.

The writer still writes the ordinary GPIF fields exactly as alphaTab does, so other readers see the file as before. It now also writes one staff property, `TabPlayerCurves`, in the same way scale diagrams are carried (`src/interchange/scale-diagram.ts`). The property holds each bend, whammy and slur exactly: type, style, every point as written by `String(number)` (negative zero kept), and the position of the note or beat (bar, voice, beat, note).

The reader (`loadInterchangeScore`) restores from the property when the file contains it. The file is untrusted, so an item is applied only when every one of these holds; otherwise it is skipped with a `console.warn`, never refusing the file, and the other items still apply:

- **Well formed, and obeying the rules native edits obey.** A curve needs a type other than none, a known style, at least 2 and at most 1024 points, offsets sorted strictly ascending inside 0 to 60 with the first at 0 and the last at 60 (`validateCurve`, Rust `PitchCurve::validate`), and no negative bend value. A `BendRelease` needs 4 points because the renderer reads its fourth. A slur follows `applyNoteLink`: one staff and one voice, strictly forward by bar and then beat, and never onto itself, so a backward, cross-voice or cyclic slur cannot enter the score. The writer applies the same rules and does not write an item the reader would refuse.
- **Bounded values.** No existing validator bounds a value beyond "finite" (and "not negative" for a bend). Playback needs a bound: alphaTab sets the pitch wheel to plus or minus 16 semitones and maps a value `v` to `v/2` semitones, so the legal range here is plus or minus 32 (`maxCurveValue`; a bend also not below 0). I derived 32 from that wheel range, not from a validator. A value of one million produced millions of MIDI events and 1e300 stalled the synth, so values outside the range are refused.
- **The recorded ids match the file.** Each item records the id of its note or beat. The reader walks the file's own MasterBars, Bars, Voices, Beats and Notes lists and requires that id to sit at the recorded staff, bar, voice, beat and note. An inserted or reordered bar, a swapped beat or a reused id fails this. A slur records both end ids.
- **The notes are the same.** A bend records its note's string and fret; a whammy records the strings and frets of its beat's notes; a slur records both ends'. They must match the note the item lands on.
- **Ordinary fields unchanged (curves).** The writer records a fingerprint of the ordinary GPIF fields (`Bend*` note properties, or the `Whammy` attributes). If another editor changed them and kept the unknown property, the file's own fields win. A curve of more than four points has no ordinary fields, so the id and note checks above are what protect it.
- **Derived state is refreshed** after a curve is replaced: `maxBendPoint`, whammy max/min, `bendOrigin` and `isContinuedBend` on a tied destination, and `isContinuedWhammy` on neighbouring beats.

Native data is unchanged: no edit type, project schema or model field was added or altered. `src/interchange/gp.ts` gained three call sites. A score with no bend, whammy or slur writes exactly the bytes it wrote before: the property is not written and the XML pass is not taken (a test rebuilds the earlier code path and compares bytes). A score with them is re-serialized by the XML pass, which differs from the plain alphaTab file only by the property, by an empty `<Automations/>` added to each `ChannelStrip`, and by empty elements written as `<X/>` instead of `<X></X>` (for example `<SystemsLayout/>`); a test removes the property and the empty `Automations` and compares the rest as parsed documents. Files with no property, including every file from Guitar Pro, load exactly as before, so old projects and edit logs replay unchanged.

Code: `src/interchange/curves.ts` (new), `src/interchange/gp.ts` (wiring), `src/interchange/curves.test.ts` (new).

## Evidence

All commands were run in this worktree.

- `npx tsc --noEmit -p .` printed nothing and exited 0.
- `npx vitest run src/export src/interchange --testTimeout=60000`: 1143 passed, 9 skipped, 12 failed. All 12 failures are `ENOENT` opening `.analysis/compatibility/*`, which a worktree does not have (8 in `src/export/musicxml.test.ts`/`midi.test.ts`, 4 in `src/interchange/gp.test.ts`). Nothing else failed.
- `src/interchange/curves.test.ts`, 38 tests, all passing. Round trip: one authored score with a six-point `Custom`/`Fast` bend holding a `1.5` quarter tone, a three-point `PrebendRelease`/`Gradual` bend, a five-point `Custom`/`Gradual` whammy with `-5.5` and `1.5`, a two-point `Hold` whammy, a four-point `Dip` whammy with a `0` middle value and a slur that skips a beat and changes string, twice in a row; correct track, second voice beside an empty first voice, tied continuation, and the extremes of the value range, each followed by a clone and `buildPlaybackPlan`.
  - Hostile slurs (backward, across voices, onto itself, same beat of another voice, back into an earlier bar, and a backward slur closing a cycle) are forged in the file with matching ids and frets so only the rule can refuse them. Each load keeps only the genuine slur, warns, and the score clones with `scoreFromJson` and builds a playback plan.
  - Stale items: a changed fret on a six-point bend, two swapped beats, a bar inserted before the music, and an id that belongs to another note. None is applied.
  - Curve shape and range: a single point, unsorted offsets, an end past 60, a start after 0, a three-point `BendRelease`, a negative bend value, 1000000, 1e300, 32.5, a non-number, type none and an unknown style are each refused; whammy -33, 33 and -1e300 are refused; plus or minus 32 is accepted. Every refused load still clones and builds a plan.
  - A curve the reader would refuse is not written. Edited ordinary fields still win over the property. A score without these features writes the same bytes as before (rebuilt from `Gp7Exporter` and `writeStylesheetTimeSignatures`), and one with them differs from the plain alphaTab GPIF only by the property and the known XML pass differences.
  - One test pins what alphaTab's own `Gp7Exporter` and `ScoreLoader` lose, so a future alphaTab that fixes this shows up as a failing test.
- Fails without the fix (each rule reverted in turn): the old bar-only slur rule failed 5 tests; removing the id and note checks failed the fret, swapped-beat and inserted-bar tests; the old shape check failed 13; removing the value bound failed 4. Forcing the XML pass for every score failed the byte-identical test. The first version, with the `gp.ts` wiring removed, failed 9 of its 10 tests.
- The byte-identical and the "only known differences" tests are regression guards: they pass on the first version too, and fail only when the no-curve path is changed.


This code reads untrusted files. The first version had only the author's review. An independent review then found these problems, fixed in a follow-up commit: a hostile backward, cross-voice or cyclic slur loaded without warning and then made `scoreFromJson` throw in the engine's `rebuild` and in `buildPlaybackPlan`; a long curve's fingerprint was empty, so it always passed, and the fingerprint was looked up by id while the curve landed by address; curve points were not checked against the native rules; and a value of one million or 1e300 produced millions of MIDI events or stalled the synth.

What the code now relies on, and what is still not checked:

- Every item is validated against native rules, the value range, the file's own id placement and the recorded notes before it touches the model. Point count is capped at 1024. Nothing is written to a path, and the extra full-document parse happens only when the property is present. Archive expansion is still bounded by `assertArchiveAccepted` and the entry-size filter before this runs.
- Voice numbers hold because the writer lists an empty voice as `-1` and the reader puts an empty voice back (checked in alphaTab's reader).
- A slur has no ordinary field to fingerprint. It is protected by the id placement and by the recorded strings and frets of both ends. A tool that rewrote the file, kept the property and kept every id, address, string and fret would still have its slur honoured, which is the intent.
- `loadInterchangeScore` mutates the model after `finish`. The derived fields I know of are refreshed. I did not audit every consumer of a bend, and I did not run the Rust synth against restored curves; the bound on values comes from alphaTab's pitch wheel range and the Rust side (`voices.rs`, not edited) does not clamp, so the bound here is what keeps it safe.
- The final review of this follow-up was my own re-run of the tests, with each rule reverted to see its tests fail. It was not a second independent review.


## Limits

- **Other Guitar Pro readers.** The property is unknown to Guitar Pro 8 and other readers, which I could not run here. They see only the ordinary fields: no bend or whammy at all for a curve of more than four points, a four-point reduction otherwise, no style, and no slur. Whether Guitar Pro 8 keeps or drops an unknown staff property on save is unverified. If it drops it, a file resaved there loses the exact data, by design rather than by corruption.
- **GPIF itself.** The format as alphaTab documents it holds four points, no style, no fractional values and no note slur. I did not change what is written there and did not patch alphaTab. Guitar Pro 8's own file may carry more than alphaTab reads or writes; I had no Guitar Pro 8 file with a long curve to check.
- **Not verified in the Guitar Pro 8 application.** The acceptance wording for T07, T09 and T10 compares playback or display in the target runtime. This work proves lossless round trip through TabPlayer's own writer and reader only.
- **Slurs** are carried only within one staff and one voice, strictly forward, which is all native editing allows. A slur that breaks this (for example one that arrived from MusicXML across voices) is not written and falls back to what the ordinary fields hold, which is nothing.
- **Curve values** beyond plus or minus 32 (a bend also below 0) are not carried and fall back to the ordinary fields, because playback cannot use them. The native editor accepts larger numbers; those would no longer round trip through GP.
- **GP5 export** (`src/export/gp5.ts`) is a different writer and is not changed here.
- No UI, rendering or playback code was touched. Restored curves reach playback and notation as the same model values the native score already had.

Proposed status (not applied to the progress files):

| Row | Was | Proposed | Why |
|---|---|---|---|
| T07 | partial | partial, narrowed | TabPlayer GP round trip keeps every explicit slur. Guitar Pro 8 display of it is unverified and the standard fields still carry no slur. |
| T09 | partial | partial, narrowed | TabPlayer GP round trip keeps bend points, types, styles and quarter tones exactly. Other readers see at most four points. |
| T10 | partial | partial, narrowed | Same for whammy curves and quarter tones. |

None of the three should become done until a Guitar Pro 8 file with these features is opened in the application and compared.

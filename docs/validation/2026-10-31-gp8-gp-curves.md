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

The reader (`loadInterchangeScore`) restores from the property when the file contains it:

- A curve replaces the one alphaTab read only while the ordinary GPIF fields still read as they were written. The writer records a fingerprint of those fields (`Bend*` note properties, or the `Whammy` attributes). If another editor changed them and kept the unknown property, the file's own fields win.
- A slur is restored only if both end notes still have the string and fret they had when it was written.
- A malformed or dangling item is skipped with a `console.warn`. It never refuses the file, and the other items still apply.
- Derived state is refreshed after a curve is replaced: `maxBendPoint`, whammy max/min, `bendOrigin` and `isContinuedBend` on a tied destination, and `isContinuedWhammy` on neighbouring beats.

Native data is unchanged: no edit type, project schema or model field was added or altered. `src/interchange/gp.ts` gained three call sites; scores with no bend, whammy or slur write byte-identical output (the property is not written and the XML pass is not taken). Files with no property, including every file from Guitar Pro, load exactly as before, so old projects and edit logs replay unchanged.

Code: `src/interchange/curves.ts` (new), `src/interchange/gp.ts` (wiring), `src/interchange/curves.test.ts` (new).

## Evidence

All commands were run in this worktree.

- `npx tsc --noEmit -p .` printed nothing and exited 0.
- `npx vitest run src/export src/interchange --testTimeout=60000`: 1116 passed, 9 skipped, 12 failed. All 12 failures are `ENOENT` opening `.analysis/compatibility/*`, which a worktree does not have (8 in `src/export/musicxml.test.ts`/`midi.test.ts`, 4 in `src/interchange/gp.test.ts`). Nothing else failed.
- `src/interchange/curves.test.ts`, 11 tests, all passing:
  - One authored score round trips with no loss, twice in a row: a six-point `Custom`/`Fast` bend with a `1.5` quarter tone, a three-point `PrebendRelease`/`Gradual` bend, a five-point `Custom`/`Gradual` whammy with `-5.5` and `1.5`, a two-point `Hold` whammy, a four-point `Dip` whammy whose middle value is `0`, and a slur from beat 0 on string 6 to beat 2 on string 4 that skips a beat and changes string.
  - Maxima, minima and `isContinuedWhammy` agree with the restored points.
  - Curves land on the right track in a two-track score.
  - Music in a second voice beside an empty first voice restores to the right place.
  - A tied continuation of a bend alphaTab cannot write is re-derived (`bendOrigin`).
  - Fields edited after the property was written win over the property. Slur ends whose fret changed drop the slur. A corrupted point, and an item that points past the end of the score, are each skipped with a warning while the other items still restore.
  - A score without these features writes no `TabPlayerCurves`.
  - One test pins what alphaTab's own `Gp7Exporter` and `ScoreLoader` lose (bend omitted, slur absent, whammy points and style changed), so a future alphaTab that fixes this shows up as a failing test rather than silent dead code.
- Fails without the fix: with the `gp.ts` wiring stashed, 9 of the 10 tests that depend on it failed (the tenth, "writes no property", passes either way). With the wiring restored, all pass.

## Review

I reviewed this myself. I did not use an independent reviewer. This is not hot-path code under the project rules (no auth, guard, crypto, migration or CI change). What I checked and what I did not:

- Imported files are untrusted: point count is capped at 1024 per curve, every number and enum is validated before use, item positions are bounds-checked, nothing is written to a path, and the extra full-document parse happens only when the property is present. It does not enlarge archive expansion, which `assertArchiveAccepted` and the entry-size filter still bound before it.
- Position keys are bar, voice, beat, note as the reader numbers them. I confirmed against alphaTab's reader that an empty voice is written as `-1` and read back as an empty voice, so voice numbers hold.
- A hand-edited or externally resaved file cannot silently pick up a stale curve, because of the field fingerprint and the slur end-note check. A slur has no standard field to fingerprint, so a file edited by an unknown tool that moved notes but kept the property and kept the same string and fret on the old positions would still get the slur. I judged that acceptable and recorded it under Limits.
- `loadInterchangeScore` mutates the model after `finish`. The derived fields I know of are refreshed. Others that depend on a bend (for example playback pitch tables) are computed on demand from the points in alphaTab 1.8.4, but I did not audit every consumer.

## Limits

- **Other Guitar Pro readers.** The property is unknown to Guitar Pro 8 and other readers, which I could not run here. They see only the ordinary fields: no bend or whammy at all for a curve of more than four points, a four-point reduction otherwise, no style, and no slur. Whether Guitar Pro 8 keeps or drops an unknown staff property on save is unverified. If it drops it, a file resaved there loses the exact data, by design rather than by corruption.
- **GPIF itself.** The format as alphaTab documents it holds four points, no style, no fractional values and no note slur. I did not change what is written there and did not patch alphaTab. Guitar Pro 8's own file may carry more than alphaTab reads or writes; I had no Guitar Pro 8 file with a long curve to check.
- **Not verified in the Guitar Pro 8 application.** The acceptance wording for T07, T09 and T10 compares playback or display in the target runtime. This work proves lossless round trip through TabPlayer's own writer and reader only.
- **Slurs across staves** cannot occur natively and are not written. Slurs across voices of one staff are written and restored.
- **GP5 export** (`src/export/gp5.ts`) is a different writer and is not changed here.
- No UI, rendering or playback code was touched. Restored curves reach playback and notation as the same model values the native score already had.

Proposed status (not applied to the progress files):

| Row | Was | Proposed | Why |
|---|---|---|---|
| T07 | partial | partial, narrowed | TabPlayer GP round trip keeps every explicit slur. Guitar Pro 8 display of it is unverified and the standard fields still carry no slur. |
| T09 | partial | partial, narrowed | TabPlayer GP round trip keeps bend points, types, styles and quarter tones exactly. Other readers see at most four points. |
| T10 | partial | partial, narrowed | Same for whammy curves and quarter tones. |

None of the three should become done until a Guitar Pro 8 file with these features is opened in the application and compared.

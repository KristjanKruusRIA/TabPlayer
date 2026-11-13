# THE-76 translation review kit (2026-11-13)

Ticket THE-76, tracker row W20. This note describes the tooling that lets a native speaker review the Estonian (`et`) and German (`de`) text. **No native speaker has reviewed anything yet.** Every earlier W20 note says the same (`2026-10-31-gp8-localization.md`, `2026-10-31-gp8-localization-complete.md`, `2026-11-13-the-203-command-palette-i18n.md`). The kit only makes the review possible; it does not judge translation quality.

## Files

- `scripts/i18n-review-table.mjs`: builds the review files and checks a filled-in CSV.
- `scripts/i18n-review-table.d.mts`: type declarations for the test.
- `src/i18n/review-table.test.ts`: Vitest test of the builder (17 tests).

## Run it

```powershell
node scripts/i18n-review-table.mjs                  # both languages into .analysis/i18n-review/ (git-ignored)
node scripts/i18n-review-table.mjs --lang de --out C:\temp\review
node scripts/i18n-review-table.mjs --apply C:\temp\review\review-et.csv    # prints replacements, writes nothing
```

Needs Node 22.18 or newer. The script imports `src/i18n/*.ts` through Node's built-in type stripping, so it reads the real values. It stops with an error if a catalog will not import, if a key line is duplicated or is not a key of the imported object, or if a value is not a string.

It writes, per language, `review-<lang>.csv` (UTF-8 with a byte order mark so Excel reads it as UTF-8; RFC 4180 quoting; CRLF) and `review-<lang>.md` (same rows for reading). Rows are grouped by area, the key prefix before the first dot (61 areas).

Columns: `key`, `English`, `current translation`, `placeholders in English`, `placeholders in translation`, `flags`, `details`, `correction`. `details` is an addition to the requested columns: it says why a flag was raised and lists the other keys for `inconsistent`.

## Flags

All are computed from the catalogs.

| flag | meaning |
|---|---|
| `missing` | key absent from the translation, or empty or blank |
| `identical` | translation equals the English text exactly (often fine, for example "MIDI") |
| `placeholders` | the set of `{name}` tokens differs from English |
| `edges` | the run of whitespace, punctuation and symbols at the start or end differs from English (for example `…` against `...`) |
| `inconsistent` | the same English text is translated differently under another key in this language; `details` lists those keys |
| `term:<id>` | the text matches a term that a validation note asks a reviewer to check or records as chosen |
| `forbidden-term:<id>` | the text contains a wording a note says must not appear |

The term table is `REVIEW_TERMS` in the script. Each entry names the note that raised it:

- `2026-10-31-gp8-localization.md`: Estonian note values (matched on the English side), German "Fertigstellung aufheben", German `Strg`, and no `Ctrl` in German.
- `2026-10-31-gp8-localization-complete.md`: Estonian Flazolett, Kolmekümnekahend-, Jäta alles, and the forbidden patterns medikaator, flazool, Balkeni, fermat, kolmekümnekahjandik, puhver; German Haltebogen (not Bindung), "Tapping mit der linken Hand", "Explizites Bogenziel".
- `2026-11-13-the-203-command-palette-i18n.md`: every `palette.command_*`, `palette.hint_*`, `palette.aliases_*` and `palette.error_*` key; Estonian `krihv` and `astmetraat`; German "Beat".

`2026-11-13-the-203` says "Estonian fret is `krihv`, not astmetraat" for the palette. The catalog still uses "Astmetraat" in 14 rows, so that entry is a `check` flag, not `forbidden`. The reviewer should choose one term.

## What the reviewer does

1. Open `review-et.csv` (or `de`) in Excel or LibreOffice. Use `review-<lang>.md` to read.
2. Read the `English` and `current translation` columns. Pay most attention to rows with flags.
3. Where the text is wrong or unnatural, type the full replacement into `correction`. Leave it empty to keep the current text.
4. Keep every `{name}` token exactly as in English. The token is code; it is filled in at run time. Word order around it may change.
5. Do not edit any other column. Save as CSV (UTF-8). Do not rename the file; the language is read from `review-et` or `review-de` in the name.

No English or current-translation cell begins with `=`, `+`, `-` or `@` (checked on the current catalogs: 0 rows), so Excel will not read any as a formula. A correction that starts with one of those characters could be read as one; the reviewer should avoid starting a correction that way.

## How corrections come back

`node scripts/i18n-review-table.mjs --apply <filled csv>` prints, per correction, the file and line, the old text and the new text. It refuses a row, and says why, when:

- the `{name}` tokens in the correction differ from English;
- the English or current translation in the CSV is not what the catalog holds now (the catalog changed after export);
- the key is unknown, is repeated, or the row has no key.

It exits with code 2 when any row was refused and 0 otherwise. It writes nothing. A developer then makes the printed edits to `src/i18n/<lang>.ts`, runs `npx vitest run src/i18n`, and records the review in a new `docs/validation/YYYY-MM-DD-*.md` note naming the reviewer, the date and the counts of corrections. Only then can the "no native-speaker review" limit be lifted from the earlier notes, and only for the keys that reviewer covered.

## Counts from a real run (2026-11-13, develop plus this branch)

Both catalogs hold 2433 keys, the same as English (the English file has 2509 lines including comments and blank lines).

| flag (rows) | et | de |
|---|---|---|
| keys | 2433 | 2433 |
| rows with any flag | 408 | 445 |
| missing | 0 | 0 |
| identical to English | 107 | 167 |
| placeholders differ | 0 | 0 |
| edges differ | 71 | 67 |
| inconsistent | 167 | 105 |
| term | 113 | 146 |
| forbidden-term | 0 | 1 |

The one German `forbidden-term` is `help.topic.shortcuts.tie`, which ends "löst die Bindungen". The notes say German tie is "Haltebogen", never "Bindung". This looks like a leftover; it was not changed.

No placeholder mismatch exists in either catalog, so the test's list of known mismatches is empty and a new one fails the test.

## Limits

- Flags are prompts for a human, not verdicts. `identical`, `edges` and `inconsistent` all have legitimate cases.
- The term table covers only what the three notes name. It is not a glossary and does not find other wrong terms.
- Placeholders are `{name}` tokens only. Other markup (none was found in the catalogs) would not be checked.
- `--apply` does not edit the catalogs and has not been run against a real reviewer's file; it was tried on a small synthetic CSV only.
- Review fatigue: 2433 rows per language is a long job. Flagged rows (408 and 445) are a sensible first pass.

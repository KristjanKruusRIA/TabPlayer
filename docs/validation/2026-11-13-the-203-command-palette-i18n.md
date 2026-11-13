# Validation Report: THE-203 Command Palette Titles, Hints and Errors Through i18n

**Ticket:** THE-203
**Worktree:** `the-203`
**Branch:** `agy/the-203-palette-i18n`
**Base:** `develop` (`7f298b8`), review fixes on top of `5dab5f5`

## 1. Scope

Left over from THE-202 (`docs/validation/2026-11-09-the-202-i18n-sweep-4.md`, Limits): the command palette dialog was translated, but its commands were not.

- `src/editor/command-palette.ts`: the 24 command titles (the ticket says 21), the 5 hints (measure, track, fret, duration, tempo) and the 12 error messages now come from the catalog: `palette.command_<id>`, `palette.hint_<id>`, `palette.error_*`, in `en`, `et` and `de`.
- `src/editor/CommandPalette.tsx` passes its `t` to `searchCommands(query, context, t)`. The default translator is English, so callers that pass none behave as before.
- Native search words are catalog keys too: `palette.aliases_<id>` (empty in English, filled in `et` and `de`). Nothing language-specific is hard-coded in `command-palette.ts`.

## 2. Decided search behaviour

- A command is found by the words of its title in the current language, by its native alias words, and by its English title and English alias words. English can always be typed (muscle memory, desktop drivers, the help text that still shows `measure 12`).
- Ranking: hits on the current-language title or native aliases first, then command order. An English-only match never outranks an equally good current-language match. In English the order is unchanged.
- The palette shows the current-language title, also when only the English word matched.
- Title words split on hyphens, so `Tabulatur` finds "ASCII-Tabulatur importieren". Native alias words cover inflected forms and compounds (et `takti`, `raja`, `krihvi`, `teemad`; de `Themen`, `Hilfe`).
- Expressions (ff, Am7, 3/4, [Verse], G major, bass, D.S. al Coda) are placed by one rule in every language: a command goes ahead of a typed expression only when its **English** title holds every typed word. So `C`, `Am7`, `ff`, `3/4` put the expression in the same position relative to commands in en, et and de. Which commands precede it is identical across languages; their order among themselves follows the current-language titles.
- Accent folding: typed text and title words are compared without accents, so `ruckgangig`, `uber` and `maara` work on a keyboard without those letters. **This is the one difference in English**: accented English input now matches (`undó` finds Undo). All unaccented English queries are unchanged.

## 3. Terms (checked against the existing catalog)

| id | et | de |
|---|---|---|
| measure | Mine takti juurde | Gehe zu Takt |
| track | Mine raja juurde | Gehe zu Spur |
| fret | Määra krihv | Bund setzen |
| duration | Määra kestus | Notenwert setzen |
| tempo | Määra algne tempo | Anfangstempo setzen |
| insertBeat | Lisa löök | Beat einfügen |
| deleteBeat | Kustuta löök | Beat löschen |
| rest | Muuda pausiks | Zur Pause machen |
| appendMeasure | Lisa takt lõppu | Takt anhängen |
| removeMeasure | Eemalda takt | Takt entfernen |
| undo | Võta tagasi | Rückgängig |
| redo | Tee uuesti | Wiederholen |
| play | Esita või pane pausile | Abspielen oder anhalten |
| loop | Kordus | Schleife |
| slower | Aeglasemalt | Langsamer |
| faster | Kiiremini | Schneller |
| new | Uus pala | Neue Partitur |
| open | Ava pala | Partitur öffnen |
| importAscii | Impordi ASCII tabulatuur | ASCII-Tabulatur importieren |
| save | Salvesta | Speichern |
| saveAs | Salvesta nimega | Speichern unter |
| help | Abiteemad | Hilfethemen |
| about | Teave ja uuendused | Über & Updates |
| export | Ekspordi partituur | Partitur exportieren |

Hints: et `takt 12`, `rada 2`, `krihv 5`, `kestus 8 või 1/8`, `tempo 96`; de `Takt 12`, `Spur 2`, `Bund 5`, `Notenwert 8 oder 1/8`, `Anfangstempo 96`.

Review fixes: Estonian fret is `krihv` (as in `help.shortcut_fret`), not "astmetraat"; Estonian go-to titles reuse `transport.go_to_bar` ("Mine takti juurde"); the German missing-beat error reuses `engine.select_existing_beat` ("Wählen Sie eine vorhandene Zählzeit aus."). The titles "Beat einfügen" and "Beat löschen" match the editor buttons and were kept.

## 4. Evidence

- `src/editor/command-palette-order.test.ts`: 91 queries pin the English order, recorded before any code change (`7f298b8`) and not edited since.
- `src/editor/command-palette-i18n.test.ts`: titles and hints per language; et and de search; hyphen, inflected and alias search; English alias in et and de; alias-never-outranks; expression position per language; errors per language; accent folding in English; and a direct test that reads `command-palette.ts` and fails on any string literal equal to an English `palette.command_*`, `palette.hint_*` or `palette.error_*` value. It was shown red with `title:'Undo'` put back, then restored.
- `src/editor/CommandPalette.test.tsx`: German and Estonian dialogs.
- `src/i18n/source-literals.test.ts`: `command-palette.ts` is in `sweepFiles`. The generic guard misses one-word titles and lower-case hints, hence the direct test above.

## 5. Desktop drivers

Five drivers type palette commands and still work through the English alias: `parity-command-palette.mjs` (`fret 7`, `duration 8`, `go to measure 3`, `tempo 90`, `measure 9`, `undo`), `parity-expressions.mjs` (`save`, `3/4`, `ff`, `[Verse]`, `D.S. al Coda`, `bass`, `G major`, `Am`), and `parity-ascii-import.mjs`, `parity-help.mjs`, `parity-midi-import.mjs` (`fret 2`, `fret 7`). Confirmed by reading them and by tests; **the drivers were not run** (they need the desktop build and port 9223). They already assert English UI text, so they assume an English system locale.

## 6. Limits

- **The et and de texts have not been reviewed by a native speaker.** The alias words are a first choice and may miss or add forms a speaker would expect.
- **Known conflict between two ordering rules.** Expressions are placed the same way in every language (the English-title rule), and that wins over "a current-language match ranks first". The only input found where they differ is `Ab` (the chord A flat, and the start of the English word About and of the native titles Abiteemad and Abspielen): in et the order is About ("Teave ja uuendused"), the chord, then "Abiteemad"; in de it is About ("Über & Updates"), the chord, then "Abspielen oder anhalten". The English-title match precedes the native-title match here. `C`, `Am7`, `ff` and `3/4` behave identically to English in et and de; a broader scan of single letters and the chord, key and dynamic queries in the test shows no other such input, but that scan is a list, not a proof.
- Expression titles and errors in `src/editor/expressions.ts` (about 30 strings, e.g. "Dynamic ff on the note") are still English in every language and are pinned as such. A separate ticket is needed.
- `palette.placeholder`, `palette.no_matches` and the help text `help.shortcut_palette` still show English example commands in et and de. They work through the alias.
- Hints appear only after a valid value is typed, as before; a bare `takt` shows the error instead.
- Typed hyphenated text such as `ascii-tabulatur` is not split; type the words separately.
- Shortcut keycaps (Ctrl+Z and so on) are unchanged.

# GP8 Parity S13: Full Tuning Library Across String Instruments

Tracker row S13: Full tuning library across string instruments. Adds tuning presets for banjo, ukulele, mandolin, bowed strings (violin, viola, cello, double bass) and shamisen to the existing guitar and bass catalog in `src/tuning-presets.ts`.

## Behavior

- **Catalog**: `src/tuning-presets.ts` grows from 25 guitar/bass presets to 46 presets across 7 instrument families. The 25 guitar and bass ids, notes and order are unchanged.
- Preset notes are listed high string to low string (the app's order). Octaves are as written in the cited pages' scientific pitch notation; where a page gave letters only, the octave comes from the other page.
- **Added presets** (21), with the pages opened on 2026-10-31 that confirm the pitches:
  - `banjo-5-open-g` D4 B3 G3 D3 G4: Wikipedia Banjo; creekdontrise Five-string banjo tunings; Goldtone banjo tunings; Wikipedia Standard tuning.
  - `banjo-5-double-c` D4 C4 G3 C3 G4: Wikipedia Banjo; Goldtone.
  - `banjo-5-drop-c` D4 B3 G3 C3 G4: creekdontrise ("Dropped C"); Goldtone. Wikipedia Banjo gives the same pitches as an older tuning without a name.
  - `banjo-5-open-d` D4 A3 F#3 D3 A4: creekdontrise (a d f# a d); Goldtone lists it as a variant. The more common Open D has F# on the fifth string (Wikipedia Banjo, Goldtone); this preset is the A-drone variant.
  - `banjo-5-g-modal` D4 C4 G3 D3 G4: Wikipedia Banjo ("Sawmill"); Goldtone ("Sawmill / G Modal").
  - `banjo-4-tenor-standard` A4 D4 G3 C3: Wikipedia Banjo; Goldtone.
  - `banjo-4-tenor-irish` E4 A3 D3 G2: Wikipedia Banjo (Irish tuning G2 D3 A3 E4, "like an octave mandolin"); Wikipedia Mandolin lists octave mandolin as G2 D3 A3 E4. Both pages are Wikipedia, so this is the weakest-sourced preset.
  - `banjo-4-plectrum` D4 B3 G3 C3: Wikipedia Banjo; Goldtone.
  - `ukulele-4-standard-c` A4 E4 C4 G4: Wikipedia Ukulele; Wikipedia Standard tuning; musicmaster.in.
  - `ukulele-4-low-g` A4 E4 C4 G3: Wikipedia Ukulele; musicmaster.in.
  - `ukulele-4-d-tuning` B4 F#4 D4 A4: Wikipedia Ukulele (A4 D4 F#4 B4); Wikipedia Standard tuning.
  - `ukulele-4-baritone` E4 B3 G3 D3: Wikipedia Ukulele (D3 G3 B3 E4); musicmaster.in (D G B E).
  - `mandolin-4-standard` E5 A4 D4 G3: Wikipedia Mandolin; Goldtone mandolin tuning; Wikipedia Standard tuning.
  - `mandolin-4-cross-a` E5 A4 E4 A3: Goldtone (AEAE, "Cross Tuning"); Wikipedia Cross tuning (AEAE). Both give letters only, so the octaves follow the standard tuning.
  - `bowed-4-violin` E5 A4 D4 G3: Wikipedia Violin; Wikipedia Standard tuning.
  - `bowed-4-viola` A4 D4 G3 C3: Wikipedia Viola; Wikipedia Standard tuning.
  - `bowed-4-cello` A3 D3 G2 C2: Wikipedia Cello; Wikipedia Standard tuning.
  - `bowed-4-double-bass` G2 D2 A1 E1: Wikipedia Double bass; Wikipedia Standard tuning. Sounding pitch, not the written octave.
  - `shamisen-3-honchoshi` D4 G3 D3: Wikipedia Shamisen (outer strings an octave apart, middle a fourth above the lowest); Bachido community "Honchoushi tuning reference pitches" (middle a perfect fourth above the first, third the same note as the first).
  - `shamisen-3-niagari` D4 A3 D3: Wikipedia Shamisen (second string raised, C-G-C); Bachido community "Let's talk tuning" (DAD).
  - `shamisen-3-sansagari` C4 G3 D3: Wikipedia Shamisen (third string lowered a whole step, C-F-Bb); Bachido community "Let's talk tuning" (DGC).
- **Removed** (not confirmed): `mandolin-4-open-g` (D5 B4 D4 G3). Goldtone lists mandolin Open G as GDGB (low to high), and GDGD as the separate Sawmill / Cross G. No page opened gave D B D G (GDBD).
- **Instrument title**: `instrumentTitle()` heads the `<optgroup>` blocks and the `SavedTuningsDialog` sections.
- **Shared pitches**: mandolin standard equals violin, tenor banjo standard equals viola, and the bowed double bass equals `bass-4-standard-e`. `findTuningPreset` used to return the first match, so a violin track read as "Mandolin" in the preset select. Now:
  - A tie that includes a guitar or bass preset still resolves to it (`bass-4-standard-e` is unchanged).
  - Any other tie returns no preset, so the select reads Custom instead of naming the wrong instrument.
  - `TuningInput` remembers the preset the user picked while the notes still equal it, so choosing Violin standard keeps showing Violin standard. `presetWithPitches(id, notes)` supports this.
  - No ids, notes or catalog order changed for the remaining presets, and no edit types or project schema changed.
- **Integration**: both lists render all presets under 13 instrument/string groups, and applying one uses the existing undoable `setTuning` / `setStringCount` edits.

## Evidence

- **Sources checked by web on 2026-10-31.** Each page above was opened with a page fetch that day; search-result snippets alone were not counted. No book, author or page-number citations are claimed; the earlier ones could not be verified and were removed from this report and from code comments.
- **Typecheck**: `npx tsc --noEmit` exited 0 with no errors.
- **Affected tests**: `npx vitest run src/tuning-presets.test.ts src/tuning/tuning-library-s13.test.ts src/TuningInput.test.tsx src/tuning/SavedTuningsDialog.test.tsx src/workstation/TrackSettingsPanel.test.tsx src/library/content.test.ts --testTimeout=60000` passed: 6 files, 77 tests.
- **Wider run**: `npx vitest run src/tuning src/workstation src/editor/saved-tunings.test.ts --testTimeout=60000` passed: 13 files, 138 tests.
- **Shared-pitch test**: the new `TuningInput` test (violin tuning reads Custom, `G2 D2 A1 E1` still reads `bass-4-standard-e`, picking Violin then Viola keeps each choice) and the new `findTuningPreset` assertions failed when `src/tuning-presets.ts` and `src/TuningInput.tsx` were reverted to the previous commit, and pass with the change.
- Pinned by tests: each preset's string count, pitches and order; unique ids; MIDI range; the 25 original ids; one undoable edit per applied preset; the 5-string banjo short-string rule.

## Review

- **Accessibility & UI**: group and option names keep the existing `${instrumentTitle} · ${strings} strings` pattern.
- **Replay safety**: no new edit types or project format changes; saved projects store pitches and names, not preset ids.
- **Dependencies**: none added.

## Limits

- **Source quality**: the sources are web reference pages (Wikipedia, retailer and community pages), not primary books or standards. Most presets have two independent pages; the exceptions are the Irish tenor banjo (two Wikipedia pages) and the shamisen (Wikipedia plus community forum threads, whose sansagari example is one whole step down on the third string). No published method book was opened.
- **Not confirmed and not in the catalog**: mandolin Open G as D5 B4 D4 G3. A sourced `GDGB` or `GDGD` mandolin preset was not added.
- **Open D (banjo)**: the preset uses the A fifth string; the F# variant is more common and is not in the catalog.
- **Octaves** for the mandolin cross tuning come from the standard tuning, since the pages give letters only. Banjo octaves come from Wikipedia and creekdontrise; Goldtone gives letters only.
- **Double courses**: instruments with doubled courses (mandolin) are single strings, G3 D4 A4 E5, as in Guitar Pro and alphaTab.
- **Shamisen pitch**: shamisen tuning is relative. Honchoshi, niagari and sansagari are string intervals, and players set the pitch to the singer or taste (the pages show C, and also D, B to D as examples). The presets use D as a reference lowest string so that they have concrete pitches; this is a choice of this app, not a standard pitch, and pitch centers other than D are left to custom note entry.
- **Shared pitches**: a saved track with violin pitches and no remembered choice reads as Custom, not Violin. The choice is kept only while the control stays mounted.

## Sources opened on 2026-10-31

- Wikipedia, Banjo: https://en.wikipedia.org/wiki/Banjo
- Wikipedia, Ukulele: https://en.wikipedia.org/wiki/Ukulele
- Wikipedia, Mandolin: https://en.wikipedia.org/wiki/Mandolin
- Wikipedia, Cross tuning: https://en.wikipedia.org/wiki/Cross_tuning
- Wikipedia, Standard tuning: https://en.wikipedia.org/wiki/Standard_tuning
- Wikipedia, Violin: https://en.wikipedia.org/wiki/Violin
- Wikipedia, Viola: https://en.wikipedia.org/wiki/Viola
- Wikipedia, Cello: https://en.wikipedia.org/wiki/Cello
- Wikipedia, Double bass: https://en.wikipedia.org/wiki/Double_bass
- Wikipedia, Shamisen: https://en.wikipedia.org/wiki/Shamisen
- Five-string banjo tunings (creekdontrise.com): https://creekdontrise.com/acoustic/irish_banjo/instruments/five-string-banjo/tunings.html
- Goldtone Music Group, banjo tunings article: https://goldtonemusicgroup.com/articles/?p=89
- Goldtone Music Group, Standard & Alternate Mandolin Tuning: https://goldtonemusicgroup.com/articles/2023/07/07/standard-alternate-mandolin-tuning/
- musicmaster.in, Ukulele Strings And Tuning: https://musicmaster.in/blog/ukulele-strings-explained/
- Bachido community, Honchoushi Tuning Reference Pitches: https://community.bachido.com/t/honchoushi-tuning-reference-pitches/8923
- Bachido community, Let's talk tuning: https://community.bachido.com/t/lets-talk-tuning/4652
- Bachido community, How to Tune the Shamisen: https://community.bachido.com/t/how-to-tune-the-shamisen/2561 (relative pitch only; no absolute pitch)

Pages that returned errors (HTTP 403, 429 or a refused connection) and were not used: Deering banjo tuning pages, Britannica, ukutabs, kalabrand, fretexpert, masterclass, bachido.com FAQ, banjostudio.

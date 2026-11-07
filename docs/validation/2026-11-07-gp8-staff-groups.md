# GP8 D11: staff groups, braces and per-staff spacing (THE-180)

## Behavior

- The Presentation tools have a "Design: staff groups" panel with three parts.
- Groups: tick "Include <track>" for two or more neighbouring tracks, choose "Group mark" (Bracket or Brace) and press "Group chosen tracks". Each group row shows its state ("Drawn.", "Not drawn: its tracks are no longer next to each other.", and so on), its own mark choice and "Remove group". "Remove all groups" clears them. A group draws on screen (the vertical page, horizontal page and grid views) and in every export page (PDF, SVG, PNG, print). One mark spans the group's tracks in every system. A group bracket sits left of the tracks' own braces; a group brace replaces them.
- Space below a track: choose a track under "Space below" and enter "Staff gap (%)" from 25 to 400. 100% is the standard space. The space between that track and the next one shown opens or closes by `(percent - 100)%` of the measured space (never below touching). "Reset" and "Reset all staff gaps" remove the entries. The last shown track has no space below it. Staff gaps show in the physical page layouts and in export; the panel says so in other layouts.
- Names: "Long names first, short after" shows the full track names on the first system and the short names on every later system. It is one edit and is unavailable once it applies.
- Data: `EngravingOverrides.staffGroups` (`kind` and `trackIds`) and `EngravingOverrides.staffGaps` (`trackId` and `scale`), both on the existing `setEngraving` edit and omitted when empty. Each action is one undoable edit. Choosing the current value records nothing. Groups and gaps are keyed by track identity, so they follow tracks through duplicate and move. A group whose tracks stop being neighbours, or fall below two, stays in the document and is not drawn.
- Groups and gaps never change timing, notes or native playback. A staff-gap-only edit repaginates from the held chunks without another alphaTab render.
- Also fixed on the way, in commit 9897369 (D08 follow-up): a pre-existing `develop` bug where a multi-bar rest closing a system made the paginated screen throw "Missing, duplicate or ambiguous screen system chunk association". Systems are now matched to their chunks by first bar.

## Evidence

- Build: the Windows desktop test build of 80a84b0 (`scripts/build-desktop-test.ps1`, Rust 1.90.0, default `src-tauri/target`). No app code changed after the build.
- `npx vitest run src/engraving`: 31 files, 458 tests passed. `npm run typecheck` is clean. `npx vitest run src/engraving src/export` also ran 8 failures in `src/export/musicxml.test.ts` (7) and `src/export/midi.test.ts` (1); all open Guitar Pro files from `.analysis/compatibility`, which a worktree does not have, and none touches this work.
- Rust: `cargo test --locked --test engraving_protocol` 26 passed; `--lib style_library` 9 passed; `--lib export::pdf` 9 passed, including `converts_composed_systems_with_defs_use_and_clip_paths` (the composed SVG with `<defs>`, `<use>` and clip paths through the PDF writer); `cargo fmt --check` clean.
- Byte identity: apart from alphaTab's per-beat class ids (`class="b<digits>"`, a process-wide counter that was already nondeterministic), the export pages for a document with no groups and no gaps are byte-identical to before this work. `pagesHash` normalises those ids and `exports the recorded no-groups pages byte for byte` compares the hash recorded at a04f3c3, before any export code changed. The desktop run below also shows no `data-tp-accolade` in the baseline pages.
- Windows desktop test, `tests/desktop/parity-staff-groups.mjs`, on the engraving fixture (Guitar6, Grand Piano with two staves, Drums; systems of bars 1-2, 3-4, 5-8, 9-10, 11-12) at A4 in the vertical page view with all tracks shown:
  - Guitar6 and Grand Piano grouped as a bracket: one `setEngraving` edit; one `group-bracket` and one `track-brace` per system on screen and in the export pages handed to the PDF writer (`window.__tabplayerTestExportPages`); the group bracket starts where alphaTab's own bracket started in the baseline (measured from the guitar's first staff line).
  - Changed to a brace: one edit; one `group-brace` per system. On screen the brace spans the same extent as the bracket (bottom within 1 px; top within 1 px plus 0.5% of its height, against Bravura's ink bounds, worst 1.57 px). The export pages carry the same mark (position, size percentage, compression). Choosing the current kind records nothing.
  - Long names first, short after: one edit; system 1 of the export pages has Guitar6, Grand Piano and Drums, later systems Gtr., Pno. and Dr. and no Guitar6. Every vertical name ends 6 px left of the leftmost mark, on screen and in the export pages. The button again records nothing.
  - 200% below Guitar6: one edit; the piano and drums names move down by the same 39 px on screen and in the export pages while the guitar's name does not move, no staff line moves up, and the brace bottom follows the piano. Systems stacked below grow by the space opened above them. 300% opens exactly twice that (78 px). Setting the current value records nothing.
  - A click on a piano notehead after the move selects the Grand Piano's note; a click inside the opened 39 px gap changes no selection and records no edit.
  - Playback highlight on a composed system: after Seek to bar 1 and Play, alphaTab adds `at-highlight` to glyphs that sit in `<defs>` and are shown through `<use>`. A screenshot of a 24 x 26 px region over one lit note holds 46 pixels in the highlight colour (#6b8a2c) while it is highlighted and none after Stop, so the restyle does reach the `<use>` instance in WebView2.
  - A 200% system gap (D08) on the third system on top of the 200% staff gap: one edit; the third system moves down by exactly the D08 offset (20 px) on screen and in the export pages, every system stays on its page, and each system's staff gap is unchanged.
  - Exporting only Guitar6 to PDF: no `data-tp-accolade` in the export pages.
  - Moving Drums between the members: the panel reads "Not drawn: its tracks are no longer next to each other.", no mark is drawn on screen or in the export pages, and the group stays in the document. Undo draws it again identically; redo and undo again repeat that.
  - All seven settings edits undone and redone with the screen compared at each step (the export pages at the ends); save and reopen keep the group, gaps and names, on screen and in the export pages; the panel lists the reopened group and removes it.
  - The native audio generation is read before and after all settings edits and stays at 6; their undo and redo leave it where the track move left it. The track move, its undo and redo advance it (to 14), as any playback-plan edit does. Playback was started and stopped once, for the highlight check.
- Driver output, run 4 of the last series, verbatim:

```text
PASS baseline: no accolade drawn by TabPlayer on screen or in the export pages, and the piano keeps its native brace - native braces per export page [0,1,2,1,1]
PASS baseline: the first system shows only short names, later systems none - first system ["Dr.","Gtr.","Pno."], later [[],[],[],[]]
PASS group Guitar6 and Grand Piano: one setEngraving edit carrying the group
PASS bracket group: one group-bracket and one track-brace per system, on screen and in the export pages - 5 systems, 5 brace and 5 bracket glyph pairs in the pages
PASS bracket group: the group bracket starts where the native bracket started in the baseline - top spike above the guitar's first line: [-1.08,-1.08,-1.08,-1.08,-1.08] (baseline [-1.08,-1.08,-1.08,-1.08,-1.08])
PASS change the group to a brace: one edit, the kind is brace
PASS brace group: one group-brace per system spanning the guitar top to the piano bottom within 1 px (the top within 1 px + 0.5% of its height, Bravura ink bounds), on screen - screen brace spans 163.39..700, 46.06..361, 23.25..274, 46.23..303, 147.87..525; worst top difference 1.57 px
PASS brace group: the export pages carry the same brace as the screen (position, size percentage and compression), one per system
NOTE music font size: screen 36px, export page 34px; the same group brace is 29.81 px shorter in the export pages (506.8 of 536.61 px). Pre-existing: the export page style .at{font-size:34px} is not what alphaTab sets on screen.
PASS choosing the current group kind records nothing
PASS long names first, short after: one edit
PASS names: system 1 of the export pages shows Guitar6, Grand Piano and Drums, later systems Gtr., Pno. and Dr. and not Guitar6 - system 1 ["Guitar6","Grand Piano","Drums"], system 2 ["Gtr.","Pno.","Dr."]
PASS names: every name ends left of the leftmost mark, on screen and in the export pages - smallest clearance 6 px, largest 6 px
PASS pressing the names button again records nothing
PASS 200% below Guitar6: one edit carrying one gap
PASS 200% below Guitar6: piano and drums move down by the same space on screen and in the export pages, the guitar does not - piano moved 39 (screen) and 39 (export), drums 39 and 39, guitar 0 and 0
PASS 200% below Guitar6: the brace follows the moved staves and later systems on the page move down by the space opened above them
PASS 300% below Guitar6 opens twice the space of 200%, on screen and in the export pages - 78 = 2 x 39
PASS choosing the current staff gap records nothing
PASS a click on a piano notehead after the 200% gap selects that note and a click inside the opened gap selects nothing - guitar "Guitar6 · Measure 1 · Beat 4St", piano "Grand Piano · Measure 1 · Beat", gap 508.5..547.5 (39 px) left the selection at "Guitar6 · Measure 1 · Beat 4St"
PASS the playback highlight restyles a note inside a composed system (content in defs, shown through use) - 46 highlight-coloured pixels on the note at (140.54, 263.52) while highlighted (24 lit glyphs in the composed system), 0 after Stop
PASS a 200% system gap on the third system composes with the staff gap: one edit, and the D08 offset is added over the composed heights - third system moved 20 px (screen, expected 20), 20 (export, expected 20)
PASS exporting the guitar alone to PDF draws no group - 5 systems, no accolades; alphaTab's own bracket glyphs: 5
PASS move Drums above Grand Piano: the group is no longer drawn and the panel says why - no data-tp-accolade on screen or in the export pages; the status line is shown
PASS undo of the track move draws the group again, identically
PASS a Redo of the track move leaves the group undrawn again, then Undo restores it
PASS undo 1/7 restores the state before "system gap"
PASS undo 2/7 restores the state before "staff gap 200 again"
PASS undo 3/7 restores the state before "staff gap 300"
PASS undo 4/7 restores the state before "staff gap 200"
PASS undo 5/7 restores the state before "names"
PASS undo 6/7 restores the state before "brace"
PASS undo 7/7 restores the state before "bracket"
PASS redo 1/7 replays "bracket"
PASS redo 2/7 replays "brace"
PASS redo 3/7 replays "names"
PASS redo 4/7 replays "staff gap 200"
PASS redo 5/7 replays "staff gap 300"
PASS redo 6/7 replays "staff gap 200 again"
PASS redo 7/7 replays "system gap"
PASS save leaves the document clean with the group, the gap and the names in it
PASS native playback generation is unchanged across every settings edit (group, kind, names, staff gap, system gap) and across their undo and redo - generation 6 through the edits; the track move, its undo and redo advanced it to 14 (expected: it is a different kind of edit), then 14 through the undo and redo chain (idle; playback was started and stopped once, for the highlight check, and did not change it)
PASS no page errors
PASS reopen: the project (history, group, gaps and names) is identical
PASS reopen: the saved group, gap and names are on screen and in the export pages
PASS reopen: the saved group and gap show in the panel and can be removed
staff-groups: 45 passed, 0 failed.
```

- Run on 2026-11-08 against the build of 80a84b0. Evidence: `.analysis/parity/staff-groups-result.json` (not committed). Of four runs of the final driver, three passed 45 of 45 and one failed before any check, at the first wait for the app to become idle (30 s timeout, no check ran, no cause found; background test jobs from this session may still have been loading the machine). That is recorded as a start-up flake. Three runs of a slightly earlier version of the driver also passed 45 of 45.

## Limits

- D11 stays partial.
- Staff gaps show only in the vertical page, horizontal page and grid views and in export, not in parchment, vertical screen or horizontal screen. The desktop run checked the vertical page view only.
- No gaps between a track's own staves. Extended bar lines stay whole-system, and a gap breaks the bar lines that cross it.
- No room is reserved for the bracket spikes at a group's edges.
- alphaTab's similar-instrument brackets are not reproduced while a group draws (it switches its own brackets off).
- A blank reserve is left to the left of the names so that groups fit. Only vertical (rotated) names were measured.
- The cut for a staff gap is at the midpoint of the space between two tracks, so an element that hangs into that space can move with the other track.
- Grouped exports paginate about 10.6 px differently because of the room left for the bracket spikes: in the first export system the piano's bar lines start 10.62 px higher with a group than without.
- Older builds refuse a log or project that carries the new fields.
- Groups, gaps and names are not written to Guitar Pro, MusicXML, MIDI or ASCII files and are not part of saved styles.
- Exporting a track alone, or one file per track, renders that track alone and draws no group.
- The 64-member cap can stop a copy of a grouped track from joining its group.
- There is no original-GP8 comparison in the repository.
- Two tracks with the same name give identical "Include <name>" checkbox labels and identical "Space below" options (parked).
- The panel's "too many" message also shows for a group of more than 64 tracks, not only for a 65th group (parked).
- Pre-existing and found here: the export page style sets the music font to 34 px (`.at{font-size:34px}` in `src/engraving/page.ts` and `src/export/pdf.ts`), while alphaTab sets it on screen from `engravingSettings.musicFontSize`, which is 36 px. The same size percentage therefore draws every music glyph, including these marks, about 5.6% smaller in the export pages. The group brace is 29.8 px shorter than its staves in the first system (506.8 of 536.6 px). The driver measures the brace's extent on screen only, checks that the export pages carry the same mark, and prints this as a NOTE. It is not fixed here.
- What the driver did not cover: SVG, PNG and print export were not checked on the desktop; only the export pages handed to the PDF writer are measured, and the written PDF is checked by its `%PDF-` header only. The per-track check selects only Guitar6 in the export dialog; "One file per track" output is not inspected. Clicks were made on the first system only, and "selects nothing" was tried once, in one gap. The click checks read the track and position the editing location shows, not the selected note's id. The highlight proof is one note in one run, found by colour. Only the right edge of vertical names is measured. Windows only.

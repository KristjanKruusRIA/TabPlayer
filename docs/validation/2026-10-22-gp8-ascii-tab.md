# GP8 parity F14: ASCII tablature export (2026-10-22)

GP8 can export a track as ASCII tablature: plain text that tab sites and forums can show. This slice adds the format **ASCII tablature** to Export score. It saves a `.txt` file and was implemented on branch `feat/gp8-parity`.

## Behavior
- **Generator (`src/export/ascii-tab.ts`):**
  - The selection is honored as in other exports: tracks, the measure range, and partial staves.
  - **Header:** the first line is the title and artist. Each stringed staff gets a heading with its track name, its original staff number for multi-staff tracks, its tuning from low to high, and its capo.
  - **String names:** a six-string guitar uses `e` over `E`. Tunings where names repeat, such as 7–9 string guitars, use octave names like `E4` and `B1`.
  - **Rows:** frets sit on string rows, with the top string first. Columns are the union of onsets across voices. Each column is spaced by its duration, from one dash for an eighth up to eight for a whole note. When voices share a string at the same moment, the first voice is kept, even when its note is a tied continuation.
  - **Marks:**
    - `x` dead, `(n)` ghost, `<n>` natural harmonic, `[n]` other harmonics;
    - `g` grace, `t` tap;
    - `h` and `p` for hammer-ons and pull-offs, `/` and `\` for slides in, out and between notes;
    - `b` bend and `r` release, also on tied continuations, where a held bend adds no new mark, and `pb` prebend written before the fret (`pb7`);
    - `~` vibrato.
  - **Legend:** at the end, listing only the marks that were used.
  - **Bar labels:**
    - Repeats print `|:` and `:|`, and repeat counts above 2 print as `xN` at the bar's right end.
    - Alternate endings (`1.2.`), section names and directions (D.C., D.S., Coda, Fine and so on) print above their bar.
    - A label may run on into following bars. A label that would collide with one already placed goes on another header line above the tab, so labels and repeat counts are never cut.
  - **Simile bars** are written out as the bar they repeat.
  - **Line width:** systems wrap before 80 columns. Free text is flattened onto one line, and long labels are cut only at whole characters, never inside an emoji.
  - **Refusals:** percussion and staves without strings are left out. A selection with no stringed staff, or a note without a valid string, is refused with a message.
- **Wiring:**
  - The Export dialog option explains what the format keeps and leaves out, and previews the `.txt` name.
  - The coordinator builds the text before the native save dialog, so refusals open no dialog and leave the export idle.
  - The `exportAsciiTab` bridge calls the Rust `export_ascii_tab` command. Like MusicXML export, it saves through the document's export path with the `.txt` extension, and it refuses bytes that are not UTF-8.

## Evidence
- **Frontend:**
  - `ascii-tab.test.ts`, 14 tests, comparing exact text:
    - the title and tuning header;
    - marks for every technique, and the legend;
    - repeats, counts, endings, directions and similes;
    - header label overlap, with a second header line, and a long direction on a system's last bar;
    - held bends and prebends;
    - a tied first-voice note against a later voice;
    - double similes, also when a measure range cuts their source;
    - spacing across voices, and the measure range;
    - wrapping;
    - extended-range octave names and capo;
    - original staff labels on a partial selection;
    - the first voice kept on a shared string;
    - percussion skipping and both refusals.
  - `ExportDialog.test.tsx`: the option, the note and the `.txt` preview.
  - `useExportCoordinator.test.ts`:
    - the frozen source and revision;
    - measure-range output;
    - refusal before the save dialog.
  - `workspace/bridge.test.ts`: the `export_ascii_tab` payload.
  - RED log: `.analysis/parity/ascii-tab-red.log`.
  - **Mutation checks:** showing `x2`, letting a later voice overwrite an earlier one, ignoring similes, using post-selection staff numbers, and keeping raw newlines each fail a test.
- **Native:** `cargo test --lib` passes (269). The command is registered in both handler lists.
- **Desktop (Windows desktop-test build):** `tests/desktop/parity-ascii-tab.mjs` opens the four-track fixture and exports ASCII tablature through Export score to a test folder. It asserts:
  - the file is saved as `tab.txt`;
  - the title line and the Guitar9 and Bass6 headings with their tunings;
  - Drums and Keys are left out;
  - every line is at most 80 columns;
  - each string line, joined across systems, holds exactly that string's fixture frets in time order;
  - there are no page errors.
- **Review:** an Opus adversarial review found these issues, all fixed with tests:
  - dropped endings, directions and simile bars;
  - repeat counts hidden by long labels;
  - later voices overwriting earlier ones;
  - post-selection staff numbers;
  - multi-line text;
  - silently dropped notes;
  - missing marks.
- **Second review:** it found these issues, also fixed with exact-text tests:
  - labels cut at the end of a system;
  - held bends marked as new bends, and prebends lost;
  - a tied first-voice note losing its string to a later voice;
  - text cut inside a character.

## Limits
- F14 is partial:
  - Percussion tracks are not exported. GP8 writes drum tab.
  - Rhythm is shown only by spacing, with no rhythm line or duration letters.
- The desktop test checks the fret order on each string, not column alignment across strings. Alignment is covered by the exact-text unit tests.
- Voices that share a string at the same moment keep only the first voice's note.
- Grace notes take a column of their own before the beat.
- Bend amounts, let ring, palm mute, staccato, dynamics and lyrics are not written.
- There is no original-GP8 comparison.

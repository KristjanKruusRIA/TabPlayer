# GP8 parity: MusicXML import repairs and export (2026-10-19 to 2026-10-21)

Branch `feat/gp8-parity`, commits `d792568` to `088b973`. Each slice followed the same steps: a failing test first, then the fix, then an Opus adversarial review repeated until approved, then a local validation note in `.analysis/parity/2026-10-1[9]-…`/`2026-10-2[01]-gp8-musicxml-*-validation.md`.

## Import repairs (F03, F04)
Each repair is a pass in `loadInterchangeScore`. If its source checks find anything doubtful, it keeps alphaTab's stock import.
- **Tempo:**
  - Tempo directions with an offset are placed in loader ticks, honouring the playback flag across voices and parts.
  - Tempo words come back as tempo text.
- **Volume and pan:** measure-level and direction-level volume and pan come back, including directions that carry an offset.
- **Techniques:** TAB natural harmonics, hammer-ons and pull-offs, and pedal markers (placed by their offset in ticks) are restored.
- **Staves and ties:** alternate notation+TAB staves fold back into one staff, including third-party files with extra layout detail. Ties in transposing parts pair correctly.
- **Bends:** a tied bend keeps the pitch its tie carries. A continued bend starts at the carried pitch.
- **Lyrics:** lyric syllables come back with their hyphenation.
- **MXL:** compressed MusicXML (`.mxl`) goes through the same passes. It uses the first root file in the container, and edited XML is repacked into the archive.
- Every repair applies only to UTF-8 sources; other encodings keep the stock import.

## Export (F13)
`src/export/musicxml.ts` writes MusicXML 4.0 `score-partwise` from the selected tracks, staves and measures. A notation + TAB guitar becomes one part with two staves.
- **What it writes:**
  - pitches, rhythms and ties, including tuplets;
  - clefs, keys, time signatures and repeats;
  - tempo, dynamics, and volume and pan mix;
  - lyrics and grace notes;
  - bends, including bends continued over ties;
  - articulations, ornaments and vibrato;
  - hammer-ons and pull-offs, shift slides, tremolo picking, pick strokes and tapping;
  - the title and credits, and `<transpose>` for display-transposed instruments;
  - fermatas (type only; the stored length is dropped on purpose).
- **What it drops:** embedded backing audio, track mute, solo and MIDI port, TabPlayer mixer settings, and layout and styling.
- **What it refuses:** anything else it cannot represent, including these:
  - tracks with more than one staff, such as a piano grand staff;
  - percussion staves;
  - stringed staves shown only as standard notation;
  - sounding transposition;
  - more than four voices on a notation+TAB staff;
  - wide vibrato;
  - alternate endings, other slide types, instrument changes and gradual mix changes.

  The export fails closed: every model field outside an allowlist of written fields must equal a pristine default. Otherwise the export throws "MusicXML export does not support X yet."
- **Export dialog:** MusicXML is an option, with the usual track, staff and measure selection. Refusals appear in the dialog before the native save dialog opens. The native `export_musicxml` command uses the same origin, revision and destination protections as MIDI.

## Evidence
- **Round trips:** each exported feature is re-imported through `loadInterchangeScore`. The test compares the model and the `buildPlaybackPlan` notes (start, end, key, velocity, articulation, pitch curve) with the source.
- **Refusals:** each refusal has a test.
- **Desktop:** the Windows desktop-test build passes `tests/desktop/exports.mjs` for all seven cases (midi, musicxml, pdf, wav, stems, and wav/stems at 50%). The `.musicxml` file is written through the native save path, starts with `<?xml` and contains `score-partwise`. The document record stays unchanged. The file was not validated against the MusicXML schema.
- **Gates at `7746f4b`** (`088b973` only changes the desktop test, which Vitest does not run):
  - full Vitest suite: 3201 pass; the 7 failures are only in the known load-flaky files, which pass on their own;
  - `tsc` and the build are clean;
  - `cargo test --lib`: 253 pass.

## Limits
- Export covers single-staff tracks and notation+TAB guitars only; multi-staff tracks, percussion and the other refusals above are open. No schema validation has been run.
- Export is only decoded by alphaTab's importer. No independent third-party reader (MuseScore, Finale, GP8) has decoded it yet.
- Unsupported notation is refused rather than written, and the refusal messages use internal model names.
- Import still lacks a complete notation, instrument and voice matrix against public files. Original-GP8 MusicXML import and export have not been compared.
- Known accepted gaps from review:
  - a grace note's fermata display order;
  - fermatas between beats are refused (including GP's own `fermata.gp` fixture);
  - MuseScore files without TAB frets;
  - tie chains that cross voices;
  - uneven timing from a released bend origin.

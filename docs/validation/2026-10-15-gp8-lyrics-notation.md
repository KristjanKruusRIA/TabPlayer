# Lyrics and beat/bar notation verification

Date: 2026-10-15. Branch: `feat/gp8-parity`, following entry/interchange delivery `e4d1e4e` and subsystem plans `e14d986`. This is another bounded delivery toward the active full Guitar Pro parity goal. The historical 258-requirement baseline remains unchanged; this report does not establish full parity.

## Delivered behavior

- Per-track lyrics retain zero to five raw verses, independent start measures, comments, whitespace and visibility through history, structural rebuilding, native save/reopen and standard GP export. Placement uses the first staff/voice, clears stale assignments and retains blank slots. Excerpts retain selected syllables and relative offsets; omitted staves and reordered tracks retain their own source identity.
- Beat controls cover tap/slap/pop/dead slap/golpe, all 18 rasgueados, fades, vibrato, slash/barre/timer, stem/beam choices and octave regions. Targeted hairpins change note dynamics across actual dynamic-controlled attacks; tied/legato continuations, retrigger effects and fixed-velocity dead slaps have literal MIDI regressions.
- Bar controls cover octave clefs, common/cut display in native notation, double bars, rhythmic feels, custom beaming and single/double similes. Range export materializes simile music whose context is cut while retaining destination mix and valid links.
- Fermatas retain authoritative global offsets/type/length and clear derived references, including first-grace fallback references. Standard GP stem inversion and exact fractional fermata offsets are repaired.
- Timer labels use the existing generated playback ticks and tempo events. Tests exposed and corrected the public timer counter's repeated/multiple-staff overcounting.
- The export dialog now freezes lyrics provenance, independent note dynamics, links, archive siblings and backing bytes before awaiting confirmation. Literal `]]>` and CRLF lyrics remain valid and exact through the GP wrapper. Ordinary exports retain their zero-DOM fast path; notation projections exclude the root note payload.

## Fresh gates

| Gate | Result |
| --- | --- |
| `npm test -- --maxWorkers=2 --reporter=dot` | 691 Vitest tests passed across 65 files; one explicit benchmark skipped; 10 Node resource/package tests passed |
| TypeScript | `npm run typecheck` passed |
| Rust 1.88.0 | 119 tests passed; six explicit device/bank-dependent ignores; formatting passed |
| Shared protocol | All 51 command examples roundtrip through Rust; four protocol integration tests passed |
| Authorized private corpus | Included in the full suite; source hashes, musical identities and unrelated percussion retained |
| Windows release desktop-test build | Passed; diagnostic executable remains local and is not a shipping package |
| Actual Windows UI | `tests/desktop/parity-notation.mjs` passed: 13 commands, lyrics, octave/stem/hairpin/fermata/bar/simile authoring, undo/redo, direct GP export, export-dialog hidden GP export, native save, full process restart and hidden raw-source reopen |

The first full frontend run under concurrent native compilation timed out in two UI tests and produced one subsequent UI assertion failure. Both affected files passed all 31 tests in isolation. The final complete run with two workers passed without increasing test timeouts or changing product behavior. Initial desktop failures were locator mismatches for implicit select/textarea labels; the corrected test uses their accessible roles. The complete final desktop workflow passes.

Local receipts are ignored under `.analysis/parity`: `notation-frontend-accepted.log`, `notation-native.log`, `notation-desktop-build-accepted.log`, `notation-desktop-accepted.log`, `native-notation-result.json` and `native-notation.png`. Earlier failing receipts are retained.

## Independent review

Three fresh reviews covered schemas, notation/timers, and lyrics/shared integration. Reported findings were reproduced and fixed: shared protocol cardinality, hairpins counting inaudible tied continuations, excluding actual effect retriggers, and export-dialog loss of raw/hidden lyrics. Final scoped rereviews are clean. The integration reviewer additionally compared 60 simile/link excerpt combinations against independently decoded full-score ranged MIDI with no note-event mismatch. Review evidence is distinct from the root's full-suite/native checks.

## Original-target file evidence

The supplied GPIO.dll was analyzed without execution or modification, SHA256 `3a225b022a507d20ab2b9fa2530b5ac5deed9d11445588e37e9227cce398d816`.

- GPIF reader `0x1800f0d60`, writer `0x180115580` and notation gate `0x1802129f0` establish that `Track/Lyrics dispatched="false"` gates lyrics while raw Text/Offset slots remain stored. Our importer handles alphaTab's failure to honor that standard flag. This supersedes the initial design's unresolved visibility boundary.
- Native common/cut display uses stylesheet `Staff/drawTimeSignatureC` / `BarStyle::setShowTimeSignatureAsSymbol`; numeric GPIF Time remains unchanged. The native loader prefers `Content/Stylesheets/score.gpss` over BinaryStylesheet. A global stylesheet switch cannot faithfully encode arbitrary per-bar choices, so no guessed GPIF field was introduced.
- Fermata Type/rational Offset/numeric Length read/write are established. Audio units and timing behavior remain unresolved.

Detailed addresses, 49 retained evidence records, hashes and the independently patched candidate fixture remain in ignored `native-gpif-semantics.*`. The candidate is not represented as a file authored or accepted by the original GP8 runtime. No vendor code, binary or asset is included in this implementation.

## Remaining boundaries

Fermata playback holds/Length units, dedicated native slap/pop/golpe sounds, common/cut GP stylesheet fidelity, nested tuplets and original GP8 runtime acceptance remain open. Mixed/embedded lyric syntax is not claimed equivalent to GP8. The combined clef/region/timer/fermata screenshot also shows crowded upper glyphs; this remains an engraving comparison/fix requirement. New PDF glyph-layout acceptance and physical macOS/Linux verification are not established by this Windows smoke test. No new shipping installers or full-parity release are claimed.

Next delivery: exact editable selections, note-range operations/fingering and global measure transforms, followed by the musical clipboard. The complete inventory remains the goal.

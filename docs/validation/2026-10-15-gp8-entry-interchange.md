# GP8 parity: entry and interchange delivery

Validated 2026-10-15 on the implementation worktree. This is the first bounded delivery toward the full [258-requirement baseline](2026-10-15-gp8-parity-baseline.md). It does not establish complete Guitar Pro parity. The baseline remains pinned to released `7fc41c7`; its statuses are historical, not overwritten by this report.

## Delivered behavior

- Create pitched and percussion tracks; add/edit/remove individual chord notes; reuse indexed techniques, ties and slurs. Piano entry uses note names. Drum choices cover 94 standard IDs plus custom track articulations, respecting custom-index precedence. Pitched tracks use distinct logical MIDI channels without imposing the SMF export limit on the editor.
- Edit eight additional song metadata fields, all 19 direction symbols and all seven public accidental modes. Note clicks select the actual chord member. Native history, undo/redo and save/reopen retain these edits.
- Correct per-note dynamics loss during score rebuilding, worker playback-plan conversion, copied voices and MIDI export. Native dynamics 3 remains 3 and produces velocity 63 alongside an unchanged chord note at velocity 95.
- Read/write standard GPIF channel-strip pan/volume points, including fractional positions, flags, text, static values and native track ordering. Playback and SMF place exact breakpoints on performed bars, preserve fades, and restore inherited state on repeat jumps.
- Keep immutable source archive siblings through engine rebuild and GP selections. Staff-only exports retain track-wide mix points; excerpts inherit mix state by the actual bar position.
- Correct standard/custom drum references to the GPIF articulation table. Normalize non-tab pitched sounding transposition in a detached GP export model while preserving sounding/displayed pitches, links and source data. Read native track display transposition onto every staff.
- Expose XML/MusicXML/MXL in the desktop picker. Authored piano XML and compressed MXL import, edit and reopen with immutable source bytes.
- Keep the approved three-column layout and physical instrument artwork. The existing Superdesign draft was refined to version 5; actual desktop screenshots were inspected separately.

## Evidence

Fresh complete frontend run: **544 passed, one explicit benchmark skipped**, across 53 files, plus **10 resource/package tests passed**. TypeScript passed. After correcting Rust formatting, `cargo fmt --check` passed; the locked native suite on actual Rust 1.88.0 had **107 passed and six explicit hardware/bank-dependent ignores**. The native desktop test build compiled successfully.

Meaningful regressions were observed failing before implementation for new command envelopes, note dynamics, integrated entry, GP archive/controller preservation, drum mapping, piano staff controls, drum clefs, lower-staff controller export, excerpt ordering, and pitched GP transposition. Focused checks passed after each correction.

The unchanged-source authorized corpus passed independently in **10.03 seconds**. Full GPIF DOM construction had first caused a corpus timeout; the adapter now parses only track metadata, avoids DOM for ordinary exports, and patches percussion references using XML token offsets. Synthetic 12,000-note fixtures assert bounded DOM input, including comments, CDATA and quoted `>` cases. Unsupported lexical forms use the full XML parser fallback.

Actual Windows smoke (`tests/desktop/parity-entry.mjs`) verified piano chords and selected-note updates, undo/redo, sounding transposition, indexed dynamics, drum entry, album and directions, appended percussion clef, native output, native save, GP export and a full app process restart/reopen. The GP output independently reopened in the WebView with piano MIDI **48/53**, drums **38/46**, retained album and neutral drum clef. Output peak was **0.216396**, with **15,360 rendered frames** at the captured check. This proves nonzero native output, not a new human listening acceptance.

Local ignored receipts are `.analysis/parity/entry-frontend-accepted.log`, `entry-native.log`, `entry-corpus.log`, `entry-desktop-build-accepted.log`, `entry-desktop-accepted.log`, `native-entry-result.json`, `native-piano.png` and `native-drums.png`. Test projects/exports are authored local fixtures under `.analysis/desktop-smoke`; private source songs remain excluded from Git.

Independent editor/protocol review found piano staff-form, appended drum-clef and malformed indexed technique issues; all were fixed with regressions and reviewed again. Interchange review found incorrect excerpt inheritance and lower-staff controller loss; both were fixed, and scoped re-review independently decoded CC7 tick **2880**, value **32**, on channels 0/1. A separate pitched-normalization review found binary backing bytes lost during model cloning. The fix preserves detached bytes and coherent GPIF references through normalization, history and selections; scoped re-review passed 57 focused checks with no remaining material findings. An additional Windows flow decoded a real 96,044-byte, one-second authored WAV, edited/exported the containing GP, reopened identical backing bytes and verified the source file hash.

## Remaining parity requirements

This delivery advances S01/S06/S07/N17/N21/N23/F03/F04 and related interchange rows; it does not close their unverified reference-runtime or broader fidelity conditions merely because controls exist.

- Continuous linear volume/pan ramps and master automation remain open; only exact breakpoints and flags are currently retained.
- Pickup behavior after D.C. still differs from GP8. GP roundtrip can normalize accidental Default/ForceNone modes, although sounding pitch stays unchanged.
- MusicXML tempo-offset, natural-harmonic and volume/pan-direction defects remain open. MusicXML export and the other missing format families remain open.
- GP stringed/percussion sounding-transposition normalization remains open. A transposed pitched trill currently preserves the existing public/native output `[48,62]`; the alternate-pitch transposition defect still needs correction.
- Per-note relative velocity in dB, arbitrary bend detail and other GP writer losses remain separate requirements. The dynamics repair does not claim those capabilities.
- Lyrics, remaining notation, range clipboard, theory/refingering, practice, MIDI/input/tuner, sound breadth, engraving, workspace and external integrations remain on the complete inventory.
- This batch has no new signed installers, cross-platform package run or physical macOS/Linux checks. Original Guitar Pro runtime acceptance remains unverified.

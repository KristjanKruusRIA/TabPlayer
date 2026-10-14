# Tuning presets and instrument views

The October 15 additions retain the approved workspace layout and the native Rust playback engine. The user requested 25 presets plus Custom, covering 4–6 string basses and 6–9 string guitars, and a toggleable selected-track viewer for guitar, bass, drums and keys. Supplied guitar and acoustic-kit images guided the original instrument artwork.

## Implemented behavior

- Exactly 25 presets are grouped into guitar 6/7/8/9 and bass 4/5/6 string categories. Track, new-track and staff controls share the note-name input and preset selector. Presets fill drafts; existing Apply/Add actions commit ordinary undoable edits. Custom notes, equivalent flats, history readback, invalid-input protection and percussion disabling remain supported. Existing staves retain their string count.
- Show instrument toggles the viewer without editing the project. Auto follows the selected instrument family; Guitar, Bass, Drums and Keys can also be selected manually. Guitar/bass use actual staff strings, capo and source fret positions. Drum hits map to physical kit pieces or labeled additional percussion; the keyboard includes sounding pitches across the selected track's staves.
- The original SVG artwork includes a wooden neck, steel strings/frets, inlays, a cream instrument body, pickups and hardware; drums have red shells, white heads, brass cymbals, stands and pedals. Guitar/bass neck proportions remain realistic across supported string counts. No supplied photograph, vendor branding or interface is packaged.
- Highlights use prepared PlanNote identities and native ticks. Chords, repeats, seek, loop and speed follow performed playback; pause retains positions for study, Stop clears them, and replacement/error/stale generations clear prior notes. The viewer creates no audio stream.

The preset catalog is curated from common standard, drop and open tunings, rather than a statistical popularity ranking. Standard note orders were checked against [Fender's bass manual](https://www.fmicassets.com/Damroot/Original/10001/OM_leg_bass_2013_Fender_Bass_Guitars_Owners_Manual_English.pdf), [Fender's alternate-tuning tutorial](https://www.fender.com/articles/setup/tune-like-a-rock-star), [Schecter's factory tuning chart](https://www.schecterguitars.com/about), and [Ibanez's nine-string specification](https://www.ibanez.com/jp/products/detail/rg9pb_1p_02.html). Shifted standard and drop variants derive from those published tunings.

## Verification

Fresh ordinary checks pass **383 Vitest tests in 36 files**, plus **10 resource/package tests** and typecheck. One explicit timing benchmark is skipped in the ordinary batch: its unchanged 5 ms/query budget passes separately with one worker at **0.207 ms/query** for 50,000 selected notes in a 100,000-note plan. This avoids imposing concurrent CI wall-clock scheduling on functional correctness; selected/other/unknown-track assertions remain in the ordinary suite.

The independent targeted review examined immutable patch `39eca811c4cbdaeb4a74a2718664fb5bb0d348005dc01d396db1dc05da7e25d1`, inspected the rendered artwork and ran **106 focused tests**. It found no Critical or Important issues. This review covers the new features and the scoped Linux runner capacity fix, following the earlier independent expansion review. Later changes corrected test harnesses and split the benchmark; product behavior stayed unchanged.

The fresh Rust 1.88 desktop-test build passed these actual Windows flows:

| Flow | Evidence |
| --- | --- |
| Tuning presets/custom/history | Native editor applies bass6/guitar9 presets, edits custom notes, checks track/staff history and saves, restarts and reopens. All 23 edits and original private-source hash checks pass. [Result](../../.analysis/desktop-smoke/advanced-editor-result.json), [log](../../.analysis/expansion/tuning-presets-native-final.log). |
| Four instrument views | Authored Guitar9/Bass6/Drums/Keys fixture: exact prepared note IDs, source coordinates and native ticks; chords, pause/Stop, seek/rests, 50% inclusive loop, hide/show and Auto/manual modes pass with unchanged project/source and no external requests. [Result](../../.analysis/desktop-smoke/instruments-result.json), [log](../../.analysis/expansion/instruments-native-green.log). |
| Native sound/backing regression | Independent WASAPI output capture: 576,000 finite stereo frames at the actual 192 kHz device rate, A4 440.36697 Hz, peak 0.11026077. Cursor/practice/history, viewer modes, self-contained backing save/restart/offline reopen and New pass; no second synth stream. [Log](../../.analysis/expansion/instruments-native-audio-final.log), [result](../../.analysis/desktop-smoke/native-audio-result.json). |

`tests/desktop/instrument-fixture.mjs` generates the owned 36-note/four-bar 60 BPM fixture deterministically and verifies public GP roundtrip plus exact public MIDI/plan pitches and timing. Its SHA256 is `81968f022d45c9e886a55c3eab2cd69b9a8d76d2f742e980b996e053ef8bfb92`. The desktop harness observes only this fixture's audio_prepare plan through pass-through IPC fetch; it does not log headers, invoke keys or private score payloads. Runtime fixtures, recordings and private scores stay ignored.

The earlier 97-test native suite and explicit device/bank/export checks remain recorded in the [expansion audit](2026-10-14-tabplayer-expansion.md); the Rust engine did not change in this follow-up. Fresh fbc63f0 Windows MSI/NSIS builds, actual extraction, normal NSIS installation and installed offline production playback pass. The installed app applies presets and Custom tuning, displays the active physical guitar and produces independently captured A4 output. The absent `desktop_test_io` command is checked explicitly; normal uninstall removes the app, sound resources and registration while retaining preferences. Delivery copies match the recorded SHA256s.

Feature-head CI run `38641519103` has passed macOS native tests, app/DMG builds and mounted resource/hash verification. Windows/Linux packaging remains active. Physical macOS/Linux playback/print, publisher signing/notarization and original Guitar Pro runtime acceptance remain the documented limits.

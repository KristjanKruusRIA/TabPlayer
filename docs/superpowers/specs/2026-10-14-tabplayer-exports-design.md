# TabPlayer printing, exports and delivery

Date: 2026-10-14. Status: written specification awaiting user review. Shared requirements: [expansion specification](2026-10-14-tabplayer-deferred-features-design.md).

## Export workflow

Replace the single Export GP action with an export menu retaining GP and adding PDF/Print, MIDI, mixed WAV and WAV stems. A dialog chooses tracks, the whole song or an inclusive measure range, and format-specific settings. Export renders an immutable snapshot, uses native destinations and source-overwrite protection and never changes document dirty state. Progress/cancellation apply to longer PDF/audio jobs. Failed or cancelled work leaves an existing destination intact; successful writes are atomic.

Stem export chooses a new destination directory and commits a prepared temporary directory only when every stem and the manifest succeeds. It must not partially replace a user's existing stem set. Sanitize track names in filenames and disambiguate duplicate names; filenames remain inside the selected output directory.

## X1 Printing and PDF

Render notation through alphaTab's public SVG renderer with dedicated export settings independent of screen zoom. Paginate at complete system boundaries, with headers/title and page numbers; honor explicit system breaks and the selected tracks/staves/profile. Provide A4/Letter, portrait/landscape, scale and margin settings; reject settings that cannot contain a system rather than silently clipping it. A system taller than usable page height is an actionable error. Preserve standard notation, tab, chord diagrams, texts and newly edited technique/rhythm symbols.

Convert SVG pages to vector PDF in Rust using svg2pdf/usvg and merge the pages with consistent dimensions. Bundle Bravura and an explicitly redistributable text font; resolve fonts from bundled assets and embed/subset them so a machine without those fonts prints correctly. Do not depend on browser screenshots for notation output. PDF conversion must not fetch remote resources or read paths supplied by score text.

Print prepares the same document and opens the platform's normal PDF viewer/print workflow through a narrow native action. Keep the temporary document alive until the viewer can read it. Opening/printing failures preserve the score and offer the saved PDF path. Verify the native print handoff on each target platform, including paths with spaces and Unicode.

## X2 MIDI

Use alphaTab's public MIDI generator and binary writer to export a standard MIDI file. Include track names/programs, tempo and meter changes, current capo/transposition, dynamics, repeats/endings, tuplets/graces and generated technique pitch/control events. MIDI export is musical score data; backing audio and audio effects remain part of audio export. For an inclusive measure range, include its played occurrences and initialize required program/control/tempo state at tick zero. Use standard interoperable channel/event encoding; document per-note expressive events that cannot be represented identically in ordinary MIDI players.

Independently parse the result with a MIDI reader other than the writer. Check exact notes, channels/programs, tempo/meter ordering, range boundaries and curve/control events. Open at least one generated file in an independent MIDI consumer. Original GP files remain byte-identical.

## X3 Audio and stems

Render with the native audio processing core from the audio specification. Export stereo PCM WAV at 44.1 or 48 kHz and 16- or 24-bit integer depth, with deterministic dither for integer conversion. The mixed result includes the chosen tracks, backing channel and persisted amps/effects/mix settings. The default export follows the saved mix at 100% practice speed with metronome off; explicitly selectable current practice speed, metronome and effect-tail options appear in the dialog. A selected range starts at zero and clips all sources consistently.

Stem files start at the same sample zero, use the same length/rate/depth and include silence before each track's first note. Export each score track with its own effects and gain/pan, plus a separate backing stem when included. Do not apply the master limiter separately to each stem; include the separately limited mixed result when requested. A manifest records stable track identity, filename, time range, sample format, sound preset and enabled mix/tail settings. Empty tracks produce aligned silence. Under the corresponding settings, the sum of stems matches the pre-limiter master mix within conversion/dither tolerance.

Stream output to disk in bounded blocks; a multi-minute song must not allocate one complete PCM buffer. Clear old job state on cancellation, use a private temporary path in the destination filesystem, and verify output frames before commit. Decode the produced WAV with an independent reader and validate header/data length, sample rate/depth, finite samples, expected pitch, rhythmic onsets, backing alignment, effect tails and channel content.

## Delivery and regression evidence

Keep tests for native projects, imported formats, private score compatibility, history, source protection, triple dots, linked-note deletion, rapid structural edits and mixer restoration. Add packaged end-to-end runs covering advanced edits → configure sound → import/synchronize backing → play → save → restart → reopen → each export. Perform the shipping build without desktop-test features/environment flags and verify they are absent from the resulting application.

Build Windows, macOS and Linux packages with locked dependencies and pinned assets, using the local Windows host and corresponding CI/hosts for the others. Run core/render/export tests on each OS. Exercise native audio and print handoff on corresponding hosts; build success alone does not prove these flows. Record installer install/launch/uninstall tests and artifact SHA-256 hashes. Refresh third-party notices and source-build instructions. Package no private scores, extracted binaries, private test outputs or user backing files.

Attempt original Guitar Pro acceptance of advanced .gp exports using the available authorized runtime. If the runtime or a signing identity is unavailable, report the precise pending release check, retaining the original evidence distinction. Do not claim signing, native platform audio or Guitar Pro acceptance based on unrelated automated tests. Resolve independent review findings, verify the complete scope matrix and integrate/push the completed work to main under the user's existing authorization.

## Primary references

- [alphaTab export APIs](https://alphatab.net/docs/guides/exporter/)
- [alphaTab raw PCM export guide](https://alphatab.net/docs/guides/audio-export/)
- [svg2pdf vector PDF conversion](https://github.com/typst/svg2pdf)
- [Tauri platform distribution](https://v2.tauri.app/distribute/)

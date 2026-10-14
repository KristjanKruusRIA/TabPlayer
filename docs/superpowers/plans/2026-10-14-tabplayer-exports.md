# TabPlayer Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide printable vector PDF, interoperable MIDI, streamed mixed WAV and aligned WAV stems from immutable score snapshots.

**Architecture:** Public alphaTab SVG/MIDI generation feeds focused export adapters. Rust converts SVG pages with bundled fonts and streams native Renderer blocks into atomic file/directory transactions. Root integration owns native destinations, source protection, command registration and document snapshot capture.

**Tech Stack:** alphaTab exactly 1.8.4, React/TypeScript, svg2pdf exactly 0.13.0 with compatible pdf-writer 0.12, Rust native audio Renderer; independent midly/hound output readers.

**Spec:** [Exports design](../specs/2026-10-14-tabplayer-exports-design.md), [shared expansion](../specs/2026-10-14-tabplayer-deferred-features-design.md), [audio contracts](2026-10-14-tabplayer-native-audio.md), [editor contracts](2026-10-14-tabplayer-advanced-editor.md).

## Global Constraints

- Engine version remains exactly 1.8.4.
- Export renders an immutable snapshot and never changes document dirty state.
- Failed or cancelled work leaves an existing destination intact; successful writes are atomic.
- PDF conversion must not fetch remote resources or read paths supplied by score text.
- Stereo integer PCM WAV uses 44.1 or 48 kHz and 16 or 24 bits with deterministic dither.
- A multi-minute song must not allocate one complete PCM buffer.
- Private test music and extracted Guitar Pro application resources remain outside product/source releases.
- Root alone stages/commits and owns App/controller/bridge/lib registration/source guard; audio-assets owns dependency/resource/notice configuration.

## Review Focus

1. Oversized notation systems/margins produce actionable errors before clipping (task 1).
2. Mid-song ranges through repeats initialize MIDI state and clip sustained notes (task 2).
3. Malicious SVG external images/links cannot read local paths or fetch resources (task 1).
4. Cancel/error after streamed samples preserves an existing WAV and clears temporary state (task 3).
5. Duplicate/Unicode/Windows-reserved stem names stay unique and inside a new directory (task 3).

### Task 1: System pagination, vector PDF and print handoff

**Files:** Create `src/export/types.ts`, `src/export/pdf.ts`, `src/export/pdf.test.ts`, `src-tauri/src/export/{mod,pdf,print}.rs`, their inline Rust tests, `assets/fonts/sources.json`, pinned font/license assets and `scripts/prepare-fonts.mjs`.

**Interfaces:** Consume editor `PrintLayout={paper:'A4'|'Letter',orientation:'portrait'|'landscape',marginMm:number,scale:number,profile:'ScoreTab'|'Score'|'Tab'}`. Produce `ExportSelection={tracks:number[],range:{first:number,last:number}|null}` (inclusive zero-based bars), `SvgPage={svg:string,widthMm:number,heightMm:number}`, `renderPdfPages(score:model.Score,selection:ExportSelection,layout:PrintLayout):SvgPage[]`, `paginateSystems(systems:SvgSystem[],title:string,layout:PrintLayout):SvgPage[]`; Rust `pdf::convert_pages(pages:&[SvgPage],cancel:&AtomicBool)->Result<Vec<u8>,String>` and `print::prepare_and_open(bytes:&[u8],directory:&Path)->Result<PathBuf,String>` preserving the saved file on opener failure.

- [ ] Write tests for literal A4/Letter dimensions, complete-system packing/header/page numbering, selection/profile/model breaks, oversized-system and invalid-scale errors; vector PDF page/font/content tests and rejection of external SVG resources.
- [ ] Run `npm test -- src/export/pdf.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml export::pdf`; verify missing-export RED before implementing.
- [ ] Implement public synchronous `ScoreRenderer` SVG system partials, independent print settings and bundled-font measurement; paginate without splitting systems. Convert with SVG-to-PDF chunks merged at equal physical page dimensions; load only pinned in-memory font bytes and disable all image resource resolution.
- [ ] Run targeted suites, inspect a generated PDF with an independent renderer, verify notation/text/technique paths/font embedding and native print path with spaces/Unicode where host available.
- [ ] Send root registration/UI contracts and evidence; root commits this task.

### Task 2: Standard MIDI with selected tracks and repeated ranges

**Files:** Create `src/export/midi.ts`, `src/export/midi.test.ts`, `src/export/ExportDialog.tsx`, `src/export/ExportDialog.test.tsx`.

**Interfaces:** Produce `exportMidi(score:model.Score,selection:ExportSelection):Uint8Array` using public `MidiFileGenerator`, `AlphaSynthMidiFileHandler(smf1Mode=true)` and `MidiFile.toBinary()`. Dialog consumes `{score,layout,busy,progress,onExport:(options:ExportOptions)=>void,onCancel:()=>void}`. `ExportOptions` is finite GP/PDF/Print/MIDI/WAV/stems union; audio options are sampleRate 44100|48000, bitDepth 16|24, speed 'saved'|'current', metronome boolean, tailSeconds number, backing boolean, includeMix boolean.

- [ ] Write independently decoded MIDI assertions for names/program/channel, capo/transposition, ordered tempo/meter, repeats and selected ranges initialized at zero; technique pitch-wheel/control events and balanced clipped notes. Write dialog tests for selected tracks, inclusive range validation, format-specific controls, disabled/progress/cancel semantics.
- [ ] Run `npm test -- src/export/midi.test.ts src/export/ExportDialog.test.tsx`; verify intended RED.
- [ ] Implement generated-event filtering against public repeated master-bar lookup, state restoration at each concatenated occurrence segment, standard MIDI 1.0 event writing and escaped track names. Show ordinary-MIDI expression limitations in the MIDI dialog.
- [ ] Run tests/typecheck; independently parse native fixture through midly and open a file in an available independent consumer. Record any unavailable consumer explicitly.
- [ ] Send root dialog/MIDI contracts and evidence; root commits this task.

### Task 3: Streamed audio transaction and aligned stem sets

**Files:** Create `src-tauri/src/export/{wav,audio,jobs}.rs`, inline independent-reader tests and `tests/desktop/exports.mjs`.

**Interfaces:** Consume `Renderer::render_into(&mut[[f32;2]])->RenderStatus` and `render_stems_into(&mut[&mut[[f32;2]]])->RenderStatus`, `seek_tick`, `set_speed`, installed backing; stem order plan tracks followed by backing. Produce `AudioFormat={sampleRate:u32,bitDepth:u16}`, `write_wav(path:&Path,format:AudioFormat,render:impl FnMut(&mut[[f32;2]])->Result<usize,String>,cancel:&AtomicBool,progress:impl FnMut(u64))->Result<u64,String>`, `write_stems(directory:&Path,spec:&StemSpec,render:...)->Result<StemManifest,String>`, `ExportJobs` cancellation/progress registry. Renderer preparation/range/tail/metronome passed via typed export request and applied once before output.

- [ ] Write tests catching incorrect RIFF/data length/rate/depth, deterministic finite quantization, stereo contents, cancellation/error preserving old bytes, long-stream block bound, aligned silent stems, unique safe names, new-directory-only atomic commit and manifest completeness.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml export`; verify RED for missing writers.
- [ ] Implement bounded 512-frame buffered integer WAV encoding, TPDF dither with deterministic seed, header backpatch/independent frame verification then atomic commit. Stage complete stem set in a private sibling directory, verify every frame count/manifest and rename only to an absent destination. Keep cancellation/failure cleanup local and preserve prior output.
- [ ] Adapt shared native Renderer through a range/tail frame budget; track stems apply gain/pan/effects and omit master limiter, optionally write separately limited mix. Verify independently decoded sample/onset/frequency/alignment and pre-limiter sum tolerance.
- [ ] Run full frontend/Rust tests, typecheck/fmt/diff checks and desktop export workflow after root integration; write honest host/release limits to `.analysis/expansion/exports.md`. Root commits this task and performs final packaging review.

## Execution rulings

- Plan review and implementation are already auto-approved; no additional agents/reviewers or Git mutations in this worker. Root coordinates independent final review and commits.
- Host-native print/audio, independent-consumer availability and macOS/Linux acceptance are evidence checks, not assumptions established by a passing unit suite.

# Cabinet impulse responses: the user's own, beside the built-in cabinets

Date: 2026-10-24. Status: design, implemented on the slice branch. Whether a loaded response sounds right is for the listener; the tests prove it is the response that was loaded, level-matched, and that nothing else moved.

## Brief

Besides the five synthesized cabinets, the user can load their own cabinet impulse-response WAV files and pick one for a sound. No response ships with the app, appears in the repo, or is read by any committed test: tests and the desktop driver synthesize their own WAVs.

## Behaviour

### The library and the document

- A personal library in the app data folder, `cabinet-irs/`, per user. Importing copies the WAV there as `<id>.wav` with a small `<id>.json` description (name, rate, channels, length). The file dialog is the only way in.
- A response's identity is the first 32 hex digits of the SHA-256 of the file. The same file imported on another machine has the same identity, and a file changed on disk no longer matches its name, so it is refused as unreadable instead of played.
- A document names a response with one optional field on the existing cabinet settings: `cabinet.ir = { id, name, levelDb }`. `name` is the label it was picked under, so a machine without it can say which one is missing; `levelDb` is a trim of -12 to 12 dB. The field is absent unless a response is chosen. There is no new edit command: it travels in the existing `setTrackSound`, so edit-list positions, undo and old logs are untouched.
- The three schemas: `FxSettings` in `dsp.rs` (what `Project` reads through its `EditCommand`s) has `Cabinet.ir` with `deny_unknown_fields`; the TypeScript reader has a `cabinet.ir` rule in `effectRules` that accepts the same values (an id of 32 lowercase hex digits, a trimmed name of 1 to 64 characters of XML-safe text, a finite level in -12..12; a hand-written `null` is read as none, as Rust reads it); `file_library/metadata_input.rs` reads only metadata edits and skips `setTrackSound` unread, so a sound with a response cannot change what it reads. A malformed value is refused when the sound is edited, the same way on both sides, and never reaches a saved log.

### Falling back

A response the library cannot supply is not an error anywhere. A missing, damaged, changed, refused or removed response, or no library at all, resolves to nothing, and the cabinet plays its `model`, bit for bit as if no response were named (tested against the model's own render). The document is not edited: removing a response from the library records no edit, opening a document never rewrites it, and the sound panel names the response and the cabinet that plays instead in a visible notice (`The impulse response “X” is not in this computer's cabinet library, so the built-in closed cabinet plays instead...`), or says it cannot be read and why. Importing the same file again restores it by identity, with no new edit. Sound is never silent: the fallback is a full cabinet.

### Reading and preparing a file (all off the audio thread)

- Reading is bounded: the file's size is checked before it is read (limit 4 MB) and the read is capped.
- The WAV parser is hand-written with checked arithmetic. It takes RIFF/WAVE with PCM 16, 24 or 32-bit integer or 32-bit float (also inside WAVE_FORMAT_EXTENSIBLE), mono or stereo, 8 to 192 kHz, with at most 256 chunks and a data size past the end read as far as the file goes. Anything else is refused with a plain message: not a WAV, RF64, compressed, 8-bit or 64-bit, more than two channels, an odd rate, no audio, damaged header, values that are not numbers, more than 2 seconds, or silent (peak below -80 dBFS). A fuzz test runs thousands of corrupted copies without a panic.
- Stereo files are mixed to mono (the average). The cabinet is one mono response per sound, run on each output channel.
- Resampled to the device rate with a Kaiser-windowed sinc, cutoff just under the lower rate's Nyquist. Leading samples below -60 dB of the peak and the tail below -80 dB are dropped, so a response's pre-delay does not delay the sound. Longer than 1 second after that, it is cut with a 100 ms fade (the import says so); a response that ends by itself gets a 1 ms fade.
- Level: scaled so its average gain between 400 Hz and 4 kHz is 1, which is how the built-in cabinets are drawn against their midrange. Files recorded at any level sit at the same loudness as each other and near the closed cabinet (tested within 6 dB on noise). A response with almost nothing in that band is refused as no guitar cabinet.

### The convolution (`audio/ir_convolver.rs`)

No FFT crate is in the project and none was added. Direct convolution of a 1 second response is 48,000 products per sample per channel, which a heavy mix cannot afford, so this is partitioned convolution with no latency:

- The first 128 taps run directly. The rest is cut into partitions in three tiers: blocks of 128 from tap 128, 512 from tap 1,024 and 2,048 from tap 4,096. A tier's first partition begins a whole block or more after the present, so everything it needs has already been heard when a block starts.
- The transform is a hand-written radix-2 complex FFT with precomputed tables, wrapped as a real FFT of twice the length. Sums run in a fixed order, so output depends only on input, not on how the callback's blocks fall: exported audio and playback are the same bits.
- Following the tone.rs pattern, the response is an immutable `Arc<IrKernel>` of spectra resolved off the audio thread, the running state is an `IrEngine` allocated off the thread for the longest response the rate allows (1 second), and `process` allocates, locks and reads nothing. Displaced kernels and engines are swapped into the old configuration in `transition_from` and retired with it, off the thread.
- A change of cabinet during playback crossfades over the usual 10 ms ramp, as the built-in cabinets do. The engine holds one input history and works out up to two kernels' outputs from it, so a change from one response to another is a true blend of both responses on the same past. A kernel joining mid-block gets its output for the block in progress from the history already held. Built-in to response, and response to built-in, blend the built-in cabinet by itself with the response.
- Silence: input silent on both channels for the response's whole length (plus its blocks) leaves every buffer zero, and the engine rests, returns zeros, and only moves its positions on. Its output is bit-for-bit what it would be without the shortcut. A track whose channels are equal runs one channel and copies it, and a panned track runs both.

### Sound panel

In the Cabinet block: a list of the library's responses with the built-in cabinet first, `Import impulse response…`, `Remove from library`, and an `Impulse response level (dB)` number field that commits on blur or Enter. Importing picks the new response unless it is the one already named; a refused file shows the reason in an alert and changes nothing. The panel sits under the sound panel's existing lock, so a finalized document cannot be edited through it.

## Cost

Release `tone_ab ir-bench` (new), `metal-rhythm`, chain only, percent of one core, 8 tracks. A response replaces the built-in cabinet's FIR, so the cost is the difference. Measured three times on a machine that was also compiling; each row's range is over the runs.

| | Centred | Panned |
|---|---:|---:|
| Built-in closed cabinet | 27.6 to 29.9 | 50.2 to 53.9 |
| Response, 0.1 s | 29.2 to 29.5 | 52.8 to 54.0 |
| Response, 0.2 s | 30.1 to 30.2 | 52.6 to 55.2 |
| Response, 0.5 s | 29.1 to 29.3 | 52.1 to 52.2 |
| Response, 1.0 s | 29.5 to 30.4 | 52.6 to 53.6 |

That is 0.1 to 0.6 percent of one core more per track than the built-in cabinet, and flat in the response's length: the heaviest case, eight panned tracks each with a one second response, is about 53 percent against the 54 percent of the baseline. The work comes in blocks: a one second response at 48 kHz does one 4,096-point transform pair and 22 partition sums every 2,048 frames. Tracks that start together do their blocks together, which is not staggered (see Limits).

## Acceptance

- `src-tauri/tests/audio_cabinet_ir.rs` (17 tests): a click response is transparent; the output equals an independent f64 convolution of the taps at 44.1, 48 and 96 kHz; stereo channels each run through it; the level trim; level near the closed cabinet; a missing, damaged or removed response plays the model bit for bit and leaves the settings equal; no `ir` serializes as before and an old edit reads as before; malformed references are refused; smooth changes in both edit paths (`set_settings` and `transition_from`) between the model and a response, between two responses, on, off, trim and lost; a response-to-response and a model-to-response crossfade equal the weighted blend of the two renders; a renderer changing the cabinet mid-note with `replace_mix` is smooth and the same bits with blocks of 16 and of 1,000 frames; zero heap operations through processing, panning, resting, install, crossfade and reset (counting allocator); resting equals never resting; a seek leaves nothing; renders repeat exactly.
- `ir_convolver` unit tests (6): the FFT against a direct sum, the convolution against a direct sum at lengths on both sides of every tier boundary and at the longest, the impulse with no delay, two channels, a second kernel joining and leaving mid-block, rest.
- `cabinet_ir` unit tests (15): every format, extensible, hostile and fuzzed files, refusals and their messages, the size limit read-free, resampling, trimming, fade, level and cut, the library (copy, identity, dedupe, list, remove, status, damaged, lost description, cache).
- `src/audio/cabinet-ir.test.tsx` (13): the schema, the panel, picking, trim, import, refusal, removal, the notices.
- `tests/desktop/parity-cabinet-ir.mjs`: written, not run. Two launches: the first imports, refuses three bad files, picks, hears the response in an export as the sound plus half of it 10 ms later, trims, switches between two, removes it and gets the built-in cabinet's export byte for byte, and saves; the second opens that document on an empty library, sees the notice, gets the built-in export byte for byte, imports the same file, and gets the first machine's response export byte for byte with no added edit. The picker is replaced by `TABPLAYER_TEST_CABINET_IR`, paths joined by `|`, taken one per import.
- No tone in the built-in chain changed: with no response the cabinet stage is the same code, and `audio_clean_sounds` and `audio_tone` pass as they stood.

## Limits

- A response is a single mono response applied to each output channel; a stereo file is averaged, not played as a pair, so a two-microphone stereo response loses its width, and a file whose channels cancel is refused as silent.
- Files: 4 MB, 2 seconds as recorded, 8 to 192 kHz, 256 responses in a library. A response is played up to 1 second; more is cut after trimming silence.
- A response added to a track already sounding starts from silence, as a cabinet switched on mid-play does: its first tens of milliseconds are built from what comes after, while the 10 ms crossfade brings it in. Between two responses the history is shared and the blend is exact.
- Several tracks with long responses that began together make their large blocks in the same callback. Their cost was not timed apart from the average, and the blocks are not staggered.
- A track already playing a response keeps playing it from memory after it is removed from the library, until its sound is next prepared; the notice shows at once.
- Memory: a track with a response holds the longest response's buffers for its rate, about 1 MB at 48 kHz and 4 MB at 192 kHz, and a kernel about the size of the response in spectra. Twelve kernels are cached.
- Validation: a reference that is not 32 lowercase hex digits makes the sound invalid on both sides, like any malformed field. A reference to a response that does not exist is valid.
- Documents saved with a response do not open in builds before this one, which reject the unknown field.

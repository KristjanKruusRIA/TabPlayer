# GP8 parity F21: FLAC audio export (2026-10-24)

GP8 exports audio as FLAC as well as WAV and AIFF. TabPlayer exported only WAV and AIFF. This slice adds lossless FLAC for mixed audio and stems. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **File type:** the Export dialog's Audio options offer WAV, AIFF and "FLAC (lossless)" for mixed audio and stems. With FLAC chosen, the saved name ends in `.flac` and each stem is a `.flac` file named in its manifest, whose format records `"container": "flac"`.
- **Lossless:** a FLAC holds exactly the samples, dither included, that a WAV of the same export at the same rate and depth would hold. Rates are 44.1 or 48 kHz, depths 16 or 24 bits, in stereo.
- **Encoding:** TabPlayer's own encoder writes the audio in blocks of 4096 frames. For each block it uses whichever stereo coding leaves the least to store: independent, left-side, right-side or mid-side. Each channel is stored as a constant, as plain samples, or through the fixed predictor of order 0 to 4 that leaves the smallest residual, Rice-coded in partitions. Frames carry the standard CRC-8 and CRC-16 checks.
- **Stream information:** the stream information records the rate, depth, total frames, and the smallest and largest frame sizes. The MD5 signature is left unset, which the format defines as unknown.
- **Normalization:** normalization works with FLAC as with WAV and AIFF.
- **Unchanged:** WAV and AIFF exports are written exactly as before. Requests without a file type still mean WAV. A cancelled or failed FLAC export leaves any earlier file in place.

## Evidence
- **Native encoder** (`src-tauri/src/export/flac.rs`, 3 tests):
  - **Round trip:** at 44.1 and 48 kHz and 16 and 24 bits, Symphonia's FLAC decoder gives back exactly every sample of each of these cases:
    - identical and unrelated tones;
    - a silent channel beside a tone;
    - unrelated full-scale noise;
    - noise beside a quieter copy;
    - full-scale alternation, whose side channel needs its extra bit;
    - silence;
    - a 1025-frame stream and a one-frame stream.
  - **Coverage:** the encoded frames are checked to use all four stereo codings and constant, verbatim and fixed subframes.
  - **Size:** a 48 000-frame tone pair encodes to under half its PCM size, and a second of silence to under 1 000 bytes.
  - **Headers:** the header, CRC-8 and CRC-16 match their standard check values, and frame numbers are coded to the standard's UTF-8-like scheme up to six bytes.
  - **Unsupported formats:** a frame at 96 kHz or 20 bits is refused.
  - **Mutation:** writing the side channel without its extra bit fails two of the tests.
- **Native exporter** (`src-tauri/src/export/wav.rs` and `stems.rs`):
  - for 9 000 frames at each rate and depth, the FLAC decodes to exactly the WAV's dithered samples, its stream information records the rate, depth and frame count, and it is smaller than the WAV;
  - `"flac"` round-trips in requests, while `"FLAC"` and `"mp3"` are refused;
  - a FLAC past 2³⁶ − 1 frames is refused;
  - a cancelled FLAC leaves the earlier file and nothing else;
  - FLAC stems are `.flac` files that decode to their own tracks, and the manifest records `flac`;
  - the WAV, AIFF, stem and normalization tests pass unchanged.
- **Editor** (`src/export/flac-export.test.tsx`, 2 tests, and the updated `aiff-export.test.tsx`):
  - the File type lists WAV, AIFF and FLAC (lossless);
  - FLAC sends `container: 'flac'`, with or without normalization, and saves as `.flac`;
  - switching back to WAV sends the request exactly as before;
  - FLAC stems send `flac`.
- **Desktop:** `tests/desktop/parity-flac-export.mjs` on a Windows desktop-test build exports a sustained E2, B2 and E3 on a steel-string guitar through the Export dialog, as FLAC and as WAV. Symphonia, through the new `decode_audio` example, decoded the FLAC, and the test read the WAV itself:

  | Export | Frames | FLAC bytes | WAV bytes | FLAC / WAV |
  |---|---|---|---|---|
  | 44.1 kHz, 24-bit | 264 600 | 279 259 | 1 587 644 | 0.176 |
  | 48 kHz, 16-bit | 288 000 | 158 451 | 1 152 044 | 0.138 |

  - in both exports every sample of the FLAC equals the WAV's;
  - 24-bit FLAC stems were written as `001-Guitar.flac` and `002-Mix.flac`, which the manifest names and which decode at 48 kHz in stereo;
  - there were no page errors;
  - the AIFF export desktop test still passes.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 758 tests;
  - the export `vitest` files;
  - `tsc`;
  - `rustfmt` on the changed native files.

## Review
- **Code review:** approved, with no High or Medium findings.
  - The reviewer checked the encoder against RFC 9639. It also wrote a strict decoder that applies libFLAC's and ffmpeg's checks: CRCs, frame numbers, partition rules, 32-bit residuals, sample widths and stream information. That decoder read the desktop exports, before and after the fixes, as exactly the WAVs' samples.
  - It confirmed that WAV and AIFF output is unchanged, that FLAC receives the same dithered samples, and that no residual or Rice sum can overflow.
  - **Low, fixed:** the 36-bit frame total was not guarded. Exports past 2³⁶ − 1 frames, about 16 days, are now refused.
  - **Low, fixed:** the frame coder labelled any rate other than 44.1 kHz as 48 kHz and any depth other than 16 bits as 24. It now refuses other rates and depths.
  - **Low, fixed:** the final check now also confirms that one block was written for each 4096 frames.
  - **Low, left as a limit:** the MD5 signature is unset, so `flac -t` warns that it cannot check it.

## Limits
- **Fixed predictors only:** TabPlayer does not use the linear-predictive coding that reference encoders such as libFLAC use, so its files are somewhat larger than theirs. They are still standard FLAC.
- **No MD5 signature:** decoders cannot check the whole stream against an MD5, and `flac -t` warns about it, though every frame carries its CRC checks.
- **Length:** an export is limited to 2³⁶ − 1 frames, about 16 days at 48 kHz.
- **No tags:** FLAC files carry no title or artist tags, and neither do the WAV and AIFF exports.
- **Not run against libFLAC:** the tests decode with Symphonia, and the review's strict decoder applies libFLAC's rules, but libFLAC and ffmpeg themselves are not installed here.

# GP8 parity F22: AIFF audio export (2026-10-24)

GP8 exports audio as AIFF as well as WAV. TabPlayer exported mixed audio and stems as WAV only. This slice adds AIFF as a second file type for both. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **File type:** the Export dialog's Audio options have a File type list, WAV or AIFF, for both mixed audio and stems. The formats are now named Mixed audio and Audio stems. WAV stays the default.
- **AIFF files:** an AIFF holds the same audio as the WAV would: stereo PCM at 44.1 or 48 kHz and 16 or 24 bits, with the same rendering, speed, metronome, backing, effect tail and dither. Only the byte order and header differ. Mixed audio is saved with the `.aiff` extension, and the dialog's "Saves as" line shows it.
- **AIFF stems:** each stem is an `.aiff` file, and the stem set's manifest records `"container": "aiff"`.
- **Length limits:** an AIFF stops at 2 GiB of audio, about 2 hours at 48 kHz and 24 bits, because AIFF chunk sizes are signed. A WAV keeps its earlier 4 GiB limit. Either one asks for a shorter range past its limit.
- **Unchanged:**
  - WAV files are written exactly as before;
  - an audio export request or stem manifest without a file type reads as WAV, and WAV is not written into them;
  - a cancelled or failed AIFF export leaves any earlier file in place, as WAV does.

## Evidence
- **Native** (`src-tauri/src/export/wav.rs` and `stems.rs`, 5 new tests):
  - **Same audio as WAV:** a 1025-frame stereo test signal is written as WAV and as AIFF at 44.1 and 48 kHz and 16 and 24 bits. A chunk-by-chunk AIFF reader in the test decodes the AIFF's rate from its 80-bit header, its frame count and its bit depth. Its samples equal the WAV's samples as read by `hound`, dither included. Writing the AIFF samples little-endian fails this test.
  - **Format:** a request without a file type reads as WAV and is written back without one. `"aiff"` round-trips. `"flac"`, `"AIFF"`, `null` and `1` are refused. 44.1 and 48 kHz encode as the standard 80-bit values.
  - **Limits:** a WAV takes its last whole frame below the earlier RIFF limit and refuses the next. An AIFF does the same at the signed 2 GiB limit.
  - **Cancel:** a cancelled AIFF export leaves the earlier file and no temporary file.
  - **Stems:** AIFF stems are `.aiff` files with an AIFF header, and the manifest says `"container": "aiff"`. A WAV stem set's manifest names no file type.
  - **Existing exports:** the WAV, stem and native mix-and-stem export tests pass unchanged.
- **Editor** (`src/export/aiff-export.test.tsx`, 2 tests, and 1 in `useExportCoordinator.test.ts`):
  - the File type list offers WAV and AIFF. Choosing AIFF changes "Saves as" to `.aiff` and sends `container: 'aiff'` with the audio options. Going back to WAV sends exactly the earlier request;
  - stems can be exported as AIFF;
  - the export coordinator passes `container: 'aiff'` to the native exporter for AIFF mixed audio and stems, and no file type for WAV.
- **Desktop:** `tests/desktop/parity-aiff-export.mjs` on a Windows desktop-test build exports a sustained E2, B2 and E3 on a steel-string guitar through the Export dialog. Python's own `aifc` and `wave` modules read the files:

  | Export | Channels | Bits | Rate | Frames | Samples |
  |---|---|---|---|---|---|
  | AIFF and WAV, 44.1 kHz 24-bit | 2 | 24 | 44 100 | 264 600 (6.0 s) | identical; peak 0.469 |
  | AIFF and WAV, 48 kHz 16-bit | 2 | 16 | 48 000 | 288 000 (6.0 s) | identical; peak 0.469 |

  - the dialog showed "Saves as mix-….aiff" before each AIFF export;
  - AIFF stems at 48 kHz 24-bit gave `001-Guitar.aiff` and `002-Mix.aiff`, each with an AIFF header, matching the manifest, which records the file type;
  - there were no page errors;
  - the wah models desktop test, which exports WAV through the same dialog, still passes. `parity-document-tabs.mjs` times out at its first startup wait, as it did before this slice.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 749 tests;
  - the full `vitest` suite: the load-sensitive files pass when run alone;
  - `tsc`;
  - `rustfmt` on the changed native files.

## Review
- **Code review:** approved. The reviewer checked the header against the AIFF specification and had Python's `aifc` read rebuilt headers at both rates and depths, at 0, 1, 3 and 1025 frames. It searched for other places that assume `.wav` for audio exports and found none that matter.
  - **Low, fixed:** the shared size check had tightened the WAV limit by 10 bytes. WAV now keeps its earlier limit.
  - **Low, fixed:** AIFF chunk sizes are signed, so files over 2 GiB could be misread by strict readers. AIFF now stops at 2 GiB.
  - **Low, fixed:** the README still described audio export as WAV only.
  - **Low, left:** a file name typed as `Song.aif` is saved as `Song.aif.aiff`.
  - **Low, left:** the desktop test relies on Python's `aifc` module, which Python 3.13 removes. It runs on the installed Python 3.12.

## Limits
- **PCM only:** AIFF and WAV are written as uncompressed PCM at 44.1 or 48 kHz and 16 or 24 bits. There is no AIFF-C, 32-bit float, or other sample rate.
- **Other codecs:** MP3, OGG and FLAC export are still missing.
- **The `.aif` extension:** a name ending in `.aif` gets `.aiff` added.
- **Desktop test:** it needs Python 3.12 or earlier for the `aifc` module.

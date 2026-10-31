# GP8 parity F23: normalized audio export (2026-10-24)

GP8's audio export can normalize the volume to a target RMS level, and it sets quality and bitrate for MP3. TabPlayer exports uncompressed WAV and AIFF, which have no quality or bitrate, and could not normalize. This slice adds normalization to mixed audio exports. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Normalize:** for mixed audio, the Export dialog's Audio options have a Normalize checkbox and a Normalized level from −30 to −6 dB RMS, −16 by default. The level can be changed only while Normalize is checked. It works for WAV and AIFF.
- **What it does:** the whole export is rendered first, then written with one gain. That gain brings its RMS level, averaged over both channels, to the chosen level. Two limits apply:
  - the gain is lowered where needed so no sample peaks above −1 dBFS;
  - the audio is raised by at most 40 dB, so a nearly silent range, such as one holding only an effect tail, is not lifted into noise. Exact silence is written unchanged.
- **Peaks come first:** material whose peaks sit far above its average, such as a decaying chord, may stop below the chosen level at the −1 dBFS ceiling. One gain keeps the dynamics exactly as rendered.
- **Progress:** a normalized export renders the audio and then writes it, and its progress bar covers both passes.
- **Stems:** stems keep each track's level. Normalize is not offered for stems, and the native exporter refuses it for them.
- **Unchanged:** an export without Normalize is written exactly as before, and the request carries no level. A cancelled or failed normalized export leaves any earlier file in place and removes its scratch file.

## Evidence
- **Native** (`src-tauri/src/export/wav.rs`, 4 tests):
  - **Level:** a 440 Hz sine peaking at −27 dBFS measures −30.01 dB RMS. Normalized to −20, −16 and −12, it reads back from the 24-bit WAV within 0.01 dB of each level. The gain equals the target less the measured level. Progress rises through the render to 96 000 frames and through the write to 192 000. Only the WAV is left afterwards.
  - **Limits:** a quiet tone with a −6 dBFS click, normalized to −12, is held so the click peaks at −1.00 dBFS, and its level stays more than 6 dB under the target. A loud tone is turned down to −20 dB RMS. A residue at −120 dBFS is raised by exactly 40 dB.
  - **Silence and levels:** silence is written with no gain, and its samples are dither alone. Levels of −30.5, −5.9 and NaN are refused, and no file is written.
  - **Cancel and failure:** a cancel while rendering, a cancel while writing, and a renderer failure each leave the earlier file and nothing else in the folder.
  - **Existing exports:** the WAV, AIFF, stem and native mix-and-stem export tests pass unchanged.
- **Editor** (`src/export/normalize-export.test.tsx`, 2 tests, and 1 in `useExportCoordinator.test.ts`):
  - Normalize starts unchecked, with the level disabled at −16, and without it the request is exactly as before. Checked, it sends `normalizeRmsDb: -16`, and −12.5 with AIFF sends both;
  - −31, −5 and an empty level are refused with "Choose a normalization level from -30 to -6 dB RMS.";
  - Normalize is not offered for stems;
  - the export coordinator passes the level to the native exporter for mixed audio only.
- **Desktop:** `tests/desktop/parity-normalize-export.mjs` on a Windows desktop-test build exports a sustained E2, B2 and E3 on a steel-string guitar as 24-bit WAV through the Export dialog. The test reads the files itself:

  | Export | RMS over both channels | Sample peak |
  |---|---|---|
  | Not normalized | −29.45 dB | −6.57 dBFS |
  | Normalized to −24 | −24.00 dB | −1.12 dBFS |
  | Normalized to −16 | −23.88 dB | −1.00 dBFS (held at the ceiling) |
  | Normalized to −10 | −23.88 dB | −1.00 dBFS (held at the ceiling) |

  - every export has the same 288 000 frames, and the peak-to-RMS ratio is unchanged to 0.05 dB, so normalization is one gain;
  - there were no page errors;
  - the AIFF export desktop test still passes.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 754 tests;
  - the export `vitest` files;
  - `tsc`;
  - `rustfmt` on the changed native files.

## Review
- **Code review:** approved.
  - The reviewer confirmed that exports without Normalize take the unchanged path.
  - It confirmed that the scratch file is removed on every early return and panic, and that it stays in the destination's folder, which is already protected.
  - It confirmed that no sample can clip after the gain and dither, that progress always rises, and that the dialog and the native exporter agree.
  - **Medium, fixed:** a nearly silent mix was raised without limit: a −120 dBFS tail gained about 104 dB. The gain is now limited to 40 dB.
  - **Low, fixed:** the scratch file is now created only if no file of that name exists.
  - **Low, left as limits:** the scratch file can be seen in the folder during an export and is left behind if TabPlayer is killed. It takes 8 bytes a frame on the destination drive.

## Limits
- **No codec settings:** quality and bitrate apply to compressed formats such as MP3, which TabPlayer cannot export.
- **RMS, not loudness:** the level is a plain RMS over both channels, not a weighted loudness such as LUFS.
- **One gain:** there is no compression or limiting, so a peaky passage can stop below the chosen level.
- **Mixed audio only:** stems are not normalized.
- **Scratch file:** a normalized export first writes 8 bytes a frame, about 23 MB a minute at 48 kHz, beside the destination. That file is visible during the export and is left behind if TabPlayer is killed.
- **Long exports:** the WAV or AIFF size limit is checked as the file is written, after the whole render.

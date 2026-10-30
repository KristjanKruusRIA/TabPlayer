# GP8 parity F02: import MIDI files with quantization options (2026-10-30)

GP8 imports Standard MIDI files and lets you choose how they are quantized. TabPlayer could not read MIDI. This slice adds an import dialog. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-midi-import-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build.

## Behavior
- **Entry:** File > **Import MIDI…** opens a dialog with its own file picker. The result opens as a new untitled tab through the existing converted-import path, so there is no native or edit-command change, and it works while the current document is finalized.
- **Files:** Standard MIDI formats 0 and 1. Malformed, oversized and unsupported files are refused with a reason, and the open document is untouched.
- **Options:**
  - quantization from 1/4 to 1/64, default 1/16;
  - tuplets: none, triplets (default), or triplets and quintuplets, chosen per quarter note with a penalty so straight playing stays straight;
  - voices per track, 1 to 4, default 2;
  - guitar and bass as tablature.
- **Mapping:** each MIDI track and channel becomes a score track with its program. Tempo and time signatures come from the file, and notes crossing bar lines become ties. Program changes are merged by channel across tracks. Parts that cannot be fingered fall back to notation, and channel 10 becomes a drum track.
- **Caps:** 8 MB, 60,000 notes, 32 parts and 3,000 bars.

## Evidence
- **Unit tests:** `src/interchange/midi-import.test.ts` and `src/workspace/MidiImportDialog.test.tsx`, 71 tests with `src/help`. They include random fuzzing across meters from x/4 to x/32, and truncation sweeps. Together with the other changed areas, 587 of 587 passed on the merged branch.
- **Other checks:** `tsc` was clean, and `src/App.test.tsx` passed 136 of 136 alone at a 60-second timeout.
- **Desktop:** `tests/desktop/parity-midi-import.mjs` passed on a Windows desktop-test build of the merged source. The run:
  - refused a truncated file with its reason, opened nothing and left the score alone;
  - imported a format 1 file as an untitled, editable score, checking tempo, meter, programs, triplets, voices, drums and bass tuning;
  - imported a format 0 file, and showed 1/16 and 1/8 give different durations.

  This driver uses the older harness, so it ran on a copy of that build's executable at `.analysis/desktop-smoke/tabplayer.exe`.

## Review
- **Code review:** an Opus review probed the parser and importer with crafted files and 400 fuzz runs.
- **Findings and fixes:**
  - **High, fixed:** bars could silently fail to sum in odd meters such as 9/32, producing a `NaN` duration. Snapped points now stay in their bar, and a non-integer slot throws.
  - **High, fixed:** the size caps did not bound the work. An 8 MB file could run the GP export out of memory. There is now a note cap, and the drum search is no longer quadratic.
  - **Medium, fixed:** a last note could vanish when it rounded onto the final bar line.
  - **Medium, fixed:** program changes in another track were ignored.
  - **Medium, fixed:** `]]>` in a name broke the GP file.
  - **Medium, fixed:** the driver did not prove format 0 or quantization.
  - **Low, fixed:** a stack overflow on a tempo flood, the Ctrl+Shift+P guard, focus after a failed open, and a tuplet mode shown as selected while disabled.
- **Desktop run:** the first runs failed in the driver. The command was not on the driver's File list, and the harness started an older build.

## Limits
- **Not imported:** velocities, controllers, later program changes, lyrics and markers.
- **Not supported:** SMPTE timing, format 2, RIFF-wrapped files, and tuplets other than triplets and quintuplets.
- **Overlaps:** notes needing more voices than the option allows are shortened, not split onto more staves.
- **Native open:** a raw `.mid` is not offered by the normal Open dialog.
- **Options:** they are not remembered between imports.
- **Tempo:** rounded to whole BPM, so long files can drift slightly.

# GP8 parity F05: ASCII tablature import (2026-10-23)

GP8 imports ASCII tablature text into an editable score. This slice adds an ASCII tab import that reads the tuning, rhythm and common techniques. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Starting an import:**
  - File → "Import ASCII tab…" or the command palette's "Import ASCII tab" opens a modal dialog.
  - Paste the text, or use "Choose text file…" to load a .txt or .tab file of up to 256 KB.
  - A status line reports what was read, for example "2 measures, 6 strings tuned D A D G B E.", plus any skipped marks, skipped line groups and header values that were not understood.
  - Text that cannot be imported is explained, and Import stays disabled.
  - The dialog stays open until the score has opened, so a refused import keeps the text and shows why.
- **What is read:**
  - Runs of 4–8 string lines, joined in order. A run counts when at least one line is clearly tab, so dense licks with few dashes still count.
  - Shorter runs of tab lines are skipped and reported. Prose, chord-chart and lyric lines are ignored.
  - Each line is split on its own bar lines, so a line one column longer does not shift the measures. Doubled bar lines are allowed.
  - Text after a line's last bar line, such as "x2" or "Repeat 3 times", is treated as a note to the reader, not as music.
- **Headers:**
  - `Title:`, `Artist:`, `Tempo:` and `Time:` header lines set those fields. "Tempo: 120 BPM" reads as 120.
  - A tempo or time that cannot be read falls back to 120 BPM or 4/4, and the status line says so.
  - Without headers, the title comes from the file name.
- **Tuning:**
  - String names set the tuning. The lowest string takes the highest pitch at most a whole step above the usual one, so drop D and A-standard baritone stay low. Each higher string is the next pitch up with its name.
  - Names written lowest-first (`E A D G B e`) are read in that order.
  - Unnamed runs use standard tuning: bass for 4 or 5 strings, guitar for 6 to 8.
- **Notes and techniques:**
  - Frets 0–30.
  - `h`/`p` hammer-on and pull-off.
  - `/` and `\` slides between notes, or into a note.
  - `b` bends with an optional higher target fret; `r` releases, written as a four-point GP bend-and-release.
  - `~` vibrato, `x` dead notes, `(n)` ghost notes and `<n>` natural harmonics.
  - Downward bend targets and unknown signs are skipped and counted.
- **Rhythm:**
  - Notes that overlap in columns form one beat.
  - The step is the widest column count that every gap is close to a whole multiple of.
  - Padding after the last beat of up to one and a half steps makes that beat one step long; longer padding lets it ring.
  - Each step becomes the longest note value that fits every step into the bar. Each beat lasts until the next one, written as the longest values that fit (dotted where they fit), and any space left in the bar becomes rests.
  - A long lead-in becomes a rest, and empty measures are full-bar rests.
- **Opening:**
  - The score is written as a GP file and opens as a new untitled tab named after the source, such as `riff.gp` or `Imported tab.gp`. Long names are shortened to the native 200-byte limit.
  - It is an ordinary editable score with undo, and Save asks where to save it.
  - Importing again opens another tab. The import never replaces an open file and never becomes a recent library file.

## Evidence
- **Parser** (`src/interchange/ascii-tab.test.ts`):
  - headers, named and unnamed tunings, chords, and joined blocks;
  - two-digit frets, leading rests, dotted values, a 3/4 time signature and empty measures;
  - evenly spaced notes with tight, loose or no padding read as even values;
  - every technique, including a bend-and-release that survives a GP round trip through `exportGpInterchange` and `loadInterchangeScore`;
  - dense lines without dashes, lines of uneven length, and notes written after the last bar;
  - skipped short runs, loose headers, reversed string order and a baritone tuning;
  - the error messages, and file names shortened on whole characters.
- **Dialog** (`src/workspace/AsciiTabImportDialog.test.tsx`):
  - summary, import and close;
  - a refused import keeps the dialog and the text;
  - invalid text, file loading, the size refusal that keeps earlier text importable, and a stale file read that is dropped;
  - a cleared box forgets the file name;
  - Tab focus trap, Escape, and the busy state.
- **Workspace and bridge:**
  - `src/workspace/WorkspaceController.test.ts`:
    - an import opens a new tab with the parsed music and records no library metadata;
    - a native refusal or a missing bridge keeps the current tab and clears the busy state.
  - `src/workspace/bridge.test.ts`: the `import_converted` payload.
- **Native** (`src-tauri/src/intake.rs` tests):
  - converted scores stage as untitled forks with no intake path or library receipt;
  - the same name opens a second document;
  - unsafe names, non-GP bytes, more than 64 MiB and a frozen workspace are refused.
- **Desktop:** `tests/desktop/parity-ascii-import.mjs` on a Windows desktop-test build:
  - the File menu import refuses prose;
  - Tab and Ctrl+N cannot leave the modal;
  - the pasted drop-D tab opens as an untitled `Imported tab.gp`. The decoded native base has its title, tempo, tuning, quarter-note rhythm, hammer-on and dotted-half ring;
  - a palette `fret 2` edit applies;
  - importing again opens another tab.
  - `parity-command-palette.mjs` still passes.
- **Verification:**
  - full `vitest`: 3402 tests. The load-sensitive `tuning-ui`, `WorkspaceApp` and `corpus` files pass when run alone;
  - `tsc`;
  - `cargo test --lib`: 274 tests passed, before the size-limit assertion was added; the converted-score tests were rerun afterwards.
  - A 250 KB tab is refused at the 2,000-measure limit in 19 ms. A worst-case dense slide line is refused in 32 ms.
- **Review:** an adversarial review found thirteen problems, all fixed:
  - bend-and-release was lost in GP files;
  - evenly spaced tabs gained 32nd rests;
  - dense or annotated top lines dropped a string;
  - "x2" and "Repeat 3 times" became music;
  - one longer line merged all measures;
  - loose headers and chord lines failed the whole import;
  - the dialog let the keyboard leave it;
  - the dialog closed before a refused import, and long names were refused natively;
  - parsing was quadratic and ran on every keystroke;
  - baritone and lowest-first tunings were placed in the wrong octave or order;
  - downward bends became quarter-tone bends;
  - file reads raced with typing;
  - the dialog could overflow the screen.
  
  It also flagged missing tests for library metadata, native refusal and the size limit.
- **Second review:** a second adversarial review of those fixes found nine more problems, all fixed with regression tests:
  - evenly spaced notes with a lead-in or long padding still got dotted values, 32nd rests or halved durations. The step now comes from the gaps between notes only, a lead-in of up to one step is padding, and the grid is the one nearest the bar's width that holds every beat;
  - a dense line using `s` or other technique letters was dropped, importing a 5-string bass;
  - a `PM` or chord line just above named strings became a seventh string. Unnamed lines at the edge of a named block are now skipped and reported;
  - `7b(9)r(7)` became ghost notes, and `7^9` became two notes;
  - all-uppercase names written lowest-first (`E A D G`) were reversed. The order is now chosen by intervals when the case does not settle it;
  - a line missing one bar line shifted later notes into the wrong measure. Such blocks are now split by column, with a status note;
  - a remark such as `x2` or `(let ring)` after an open-ended line became notes or hid the last measure;
  - the check of text after the last bar line was quadratic (about 0.5 s for a 40,000-character tail). It is now linear;
  - a refused large file did not cancel an earlier file that was still loading.

  Verification after these fixes: full `vitest` 3,411 tests, with the load-sensitive `tuning-ui`, `WorkspaceApp`, `corpus` and `library/content` files passing alone; `tsc`; and the desktop `parity-ascii-import.mjs` and `parity-command-palette.mjs` on a rebuilt desktop-test app.

## Limits
- F05 is partial:
  - rhythm comes from spacing, so tuplets, ties across beats and swing are not inferred;
  - long notes are completed with rests rather than ties;
  - palm-mute, let-ring, tap and slap lines, chord names and lyrics are not read;
  - one track per import;
  - no repeat counts or alternate endings;
  - no original-GP8 comparison of the same text.

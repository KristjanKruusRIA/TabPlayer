# GP8 parity S14: change a track's string count (2026-10-24)

GP8 can change how many strings an existing guitar or bass track has. TabPlayer could retune a track but not add or remove strings. Codex implemented this slice on branch `feat/gp8-parity`, and Claude committed it as `66d0cae` when Codex left the project. Claude then validated it: it repaired three faults in the desktop acceptance harness, ran it on Windows, and had the code reviewed.

## Behavior
- **Where:** in Track settings, typing a tuning with a different number of notes from the track's strings shows "N to M strings". A "Strings kept in place" choice offers the high strings (the low end changes) or the low strings (the high end changes). The button becomes "Change string count", and it sends one `setStringCount` edit.
- **Notes keep their pitch:**
  - A note on a kept string stays on it, refretted for the new tuning, when the new fret is playable: fret 24 or below, or the note's own fret if that was already higher.
  - A note on a removed string, or one whose fret would become unplayable, moves to a free string in the same beat at the same pitch, at fret 24 or below. Lower frets are preferred, and the moves are matched so every note in the beat gets its own string.
  - If the notes of a beat cannot all fit that way, a note on a kept string may also move. For example, an A2 on a removed low E string takes the A string when the D3 on that string can move to the open D string.
  - Dead notes have no pitch, so one on a removed string keeps its fret on a free string.
- **Refusals:** the change is refused, and nothing changes, when:
  - a note has no playable string;
  - a tied, slid, hammered, slurred or harmonic note would have to change string;
  - a tie, slide or hammer-on that joins a note to the next note on its string would no longer do so. A link a file already held some other way, such as a hammer-on onto a tapped note on another string, is left as it was;
  - the track is percussion;
  - the string count is unchanged, in which case Apply tuning retunes as before;
  - the tuning has more than 12 or fewer than 1 pitch, or a pitch outside MIDI 0–127.
- **Chord diagrams:** chord diagrams follow the kept strings, with their fingerings. They are checked before anything changes, so an invalid diagram refuses the change rather than leaving it half applied.
- **Kept side:** "Strings kept in place" returns to the high strings when another track is selected.
- **History:** the change is one native edit, so Undo and Redo restore it exactly, and saved projects replay it.

## Evidence
- **Editor** (`src/editor/string-count.test.ts`, 24 tests, and `src/workstation/TrackSettingsPanel.test.tsx`):
  - the review's cases:
    - re-matching a kept note so that a beat fits;
    - keeping a hammer-on onto a tapped note on another string;
    - refusing a kept note at fret 34, while keeping one already at fret 30;
    - moving a dead note by its fret.
    - Without the re-matching pass, the first of these fails.
  - adding a low seventh string, or a high string with the bottom strings kept;
  - moving notes off a removed string to free strings at the same pitch;
  - atomic refusals for unplayable and linked notes;
  - chord diagram remapping;
  - refusing drums, unchanged counts, invalid tunings and keep values;
  - validating the command envelope;
  - keeping explicit slurs;
  - planning every staff before changing any.
  - The panel tests cover the "N to M strings" choice and the command it sends.
- **Native protocol:** `src-tauri/src/edit_types.rs` accepts 1 to 12 pitches with `keep` set to `high` or `low`. It refuses empty, 13-pitch, out-of-range, unknown-keep, negative-track and extra-field commands. The shared fixture `tests/protocol.json` round-trips through Rust.
- **Desktop:** `tests/desktop/parity-string-count.mjs` ran on a Windows desktop-test build made by `tests/desktop/string-count-build.mjs` and passed. The run:
  - opened a 6-string guitar and a 6-string bass, each with notes on every string;
  - changed the guitar to seven strings (E4 B3 G3 D3 A2 E2 B1, high strings kept) through Track settings;
  - undid and redid that change;
  - tried to change the bass to C3 G2 D2 A1 E1 with the high strings kept. That was refused with "no playable string" for the open B0, and the project, its history and the native audio preparation stayed exactly as before;
  - changed the bass to five strings (G2 D2 A1 E1 B0, low strings kept) through Track settings;
  - undid and redid that change.

  After every step the test:
  - exported GP and read it back: every note sat at the expected string and fret, at the authored MIDI pitch. The guitar's notes moved to the next string number at the same fret, and the bass's top-string notes moved to G2 five frets higher;
  - checked the native project, history and revision for exact equality;
  - confirmed that the native audio was ready and paused.

  Across the run:
  - the observed native commands were exactly apply, undo and redo twice, each acknowledged;
  - every audio command succeeded, apart from one expected refusal while the file opened (see Harness repairs);
  - there were no page errors and no IPC fallbacks.
- **Harness repairs:** Codex's harness had never passed on this machine. Claude changed only the harness, not product code:
  - **Listener check:** WebView2 keeps its data in an `EBWebView` folder inside the profile it is given. The listener check now accepts that folder of the owned profile.
  - **Resources:** an unbundled build reads its audio and library resources from beside the executable, so the build script copies them into the run's folder. Without them, native preparation never finished.
  - **Audio commands:** the final check expected only edit commands, but it also observes audio commands.
    - It now requires every audio command of the opened document's owner to succeed, and at least one to follow each edit.
    - At most one command may fail: a command from the owner recorded before Open, sent before the first edit, and refused with "Audio owner is no longer active." The previous owner's `stop` is refused this way once the opened document takes over.
  - **Profile path:** the profile path must end at a quote, a space or the end of the command line. Before, it was compared only up to the next `--`, so `<profile>--x` was accepted.
  - **Diagnostics:** poll timeouts now report the last value seen.
- **Verification:**
  - `tsc`;
  - the editor, workstation, tuning, harmony and protocol `vitest` files: 710 tests;
  - the Rust protocol and edit-type tests;
  - the harness's own tests: `string-count-driver` and `score-layout-acceptance`, 20 tests.
  - The desktop acceptance passed again after the review fixes.

## Review
- **Code review:** an Opus review of Codex's code and the harness repairs found no High findings.
  - It confirmed the string and tuning index arithmetic for both kept sides, both when adding and when removing strings.
  - It confirmed that a refusal leaves the saved project unchanged, because the engine rebuilds from the base.
  - It confirmed that undo and redo replay deterministically, and that the Rust and editor validation agree.
  - **Medium, fixed:** notes on kept strings were never re-matched, so changes that fit were refused, and with the wrong reason.
  - **Medium, fixed:** any link a file held off the next-note pattern refused the whole change, even when nothing moved. The error also named no bar.
  - **Medium, fixed:** kept notes accepted frets up to 127 while moved notes were held to 24, so unplayable tab could be written silently.
  - **Medium, fixed (harness):** the audio refusal allowance accepted any number of refusals, from any earlier owner, at any time.
  - **Low, fixed:** dead notes were placed by pitch.
  - **Low, fixed:** a failing chord diagram was found only after notes had moved.
  - **Low, fixed:** the kept side did not reset on a track change.
  - **Low, fixed:** the profile path was compared only up to the next `--`.
  - **Low, left as limits:**
    - kept chord diagram frets are not refretted when their string's pitch changes;
    - a theory chord already stale is saved as manual;
    - chords of another string count are left as they are;
    - the panel compares the tuning with the first staff only.

## Limits
- **No automatic fret choice beyond the beat:** a displaced note can only move to a free string in its own beat. It does not re-finger neighbouring beats for a playable position.
- **Fret limit:** notes are placed no higher than fret 24, unless a kept note was already higher, so a note that could be reached only higher is refused.
- **Chord diagrams:** a kept string's diagram fret is not refretted when its pitch changes. A chord diagram written for another number of strings is left as it is.
- **Linked notes stay put:** a change that would move a tied, slid, hammered, slurred or harmonic note is refused rather than re-linking the notes on the new string.
- **Tuning name:** the tuning's name is cleared, because the old name no longer describes it.

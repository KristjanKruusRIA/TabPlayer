# GP8 parity S16 and E17: note audition (2026-10-24)

GP8 plays a string's pitch when you click it in the tuning dialog, and plays a note as you enter it. TabPlayer made sound only through score playback. This slice adds one native capability, *audition*: a short note or chord played through a track's own sound, without starting or disturbing playback. Both rows use it. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-note-audition-design.md`. Claude implemented it with two agents, had the real-time path reviewed, and ran it on a Windows desktop build.

## Behavior
- **Tuning fields (S16):** in Track settings, the staff settings panel and the saved-tunings dialog, a tuning that parses shows:
  - one button per string, such as "Play string 6 (E2)";
  - a "Play tuning" button that strums the strings from low to high, 60 ms apart, held 1.5 s.
  - Each group is named after its field ("Hear …"), so the buttons of two fields stay distinct.
  - The draft is played, not the applied tuning, so a typed but unapplied tuning can be heard. Playing it never edits the project.
- **Editing (E17):** after a note edit succeeds, the new or changed notes of the edited beat play together for 0.8 s at their sounding pitch (tuning + fret + capo − transposition). Percussion notes play their drum sound.
  - Rests, deletions, rhythm-only changes, undo and redo stay silent.
  - Nothing plays while playback is running.
  - "Play notes while editing" in the View menu turns this off. It is on by default and remembered.
- **Sound:** an audition uses the track's own instrument sound, gain, pan and effects. Mute and solo do not silence it, so a muted track can still be heard.
- **Playback is untouched:** the clip is added on top of the output, whether playback is running or stopped. It never changes the playback position, plan or state.
- **Repeated clicks:** a new audition replaces one still sounding, after a 5 ms fade, so clicks never stack. Of several requests made at once, the latest one plays.
- **Refusals:** an audition is refused, and nothing plays, when:
  - its owner is not the active document's audio owner ("Audio owner is no longer active.");
  - the workspace is changing sessions;
  - the request is out of bounds: 1–12 notes, keys 0–127, starts 0–1000 ms, velocities 1–127, and a length of 100–3000 ms.
  - If no output stream has been opened yet, the command returns `played: false` rather than opening a device.

## Design
- **Pre-render, then mix:** the clip is rendered off the audio thread with the existing offline renderer, from a one-track plan carrying the request's own sound. It is handed to the audio callback through a dedicated four-slot lock-free queue, and the callback adds its samples to the output.
- **Real-time path:** the callback never builds renderers, allocates, locks or loads resources. A clip rendered for another sample rate, or for a stream that has since been replaced, is refused before it is queued, and dropped unplayed if it gets through.
- **Command:** `audio_audition(owner, request)` returns `{played}`. Rendering runs on a blocking thread and never takes the locks prepare uses, so an audition works while a re-prepare is pending.
- **Status:** `audio_status` gained `auditionSerial`, which counts clips that started, and `auditionPeak`, the loudest sample of the latest clip, so tests can see that a clip reached the output.

## Evidence
- **Native** (`src-tauri/tests/audio_audition.rs`, plus tests in `src-tauri/src/audio/device.rs` and `src-tauri/src/document_audio_ownership_tests.rs`):
  - strict, bounded request validation;
  - sample-voice, GM and percussion clips are stereo, non-silent and faded out;
  - the mix follows gain and ignores mute and solo;
  - a clip mixes while stopped and while playing, without changing playback;
  - replacement fades the earlier clip over 5 ms;
  - clips for another sample rate are dropped unplayed, and clips the live stream could not sound are refused before they are queued;
  - a finished clip is retired, and the serial counts each start;
  - the callback path, including eviction and wrong-rate paths, does not touch the heap;
  - the owner check works without opening a device, and of overlapping requests the latest one wins.
  - The full Rust suite passed: 780 tests.
- **Frontend:**
  - `src/audio/audition.test.ts` checks the exact requests from the tuning field and from editing, with keys that include capo and transposition, silence for rests and deletions, percussion, and the preference's default and persistence.
  - `src/audio/NativePlaybackController.audition.test.ts` checks the bridge call and the owner.
  - `src/tuning-audition.test.tsx` checks the buttons in each tuning field and the dialog, playing the draft without editing.
  - `src/App.test.tsx` checks the edit audition, silence for undo, redo and playback, and the View menu preference.
  - `tsc` was clean. The full `vitest` run passed 3595 tests, apart from timeouts in three heavy UI files while a build ran alongside; those files passed when rerun on their own.
- **Desktop:** `tests/desktop/parity-note-audition.mjs` ran on a Windows desktop-test build of the final source, made by `tests/desktop/string-count-build.mjs`, and passed. In one launch it:
  - clicked "Play string 6 (E2)" and "Play string 1 (E4)" in Track settings. Each raised `auditionSerial` by one, with peaks of 0.27 and 0.09, and playback stayed stopped;
  - clicked Play tuning: the strum peaked at 0.58;
  - typed a D2 for string 6 without applying it and played it: the peak was 0.27;
  - checked that the project, its history and its revision were unchanged by these auditions;
  - set a note at fret 5: it sounded with a peak of 0.12. Undo stayed silent;
  - found "Play notes while editing" checked by default, unchecked it, and set a note at fret 7: it stayed silent.
  - There were no page errors or IPC fallbacks.

## Review
- **Hot-path review:** a fresh Opus reviewer read the native side adversarially, as it touches the audio callback. It found no High findings, and confirmed that the callback never allocates, locks or loads, and that nothing can deadlock with prepare or shutdown.
- **Findings and fixes:**
  - **Medium, fixed:** two auditions rendering at once could queue the older clip after the newer one. Renders now run one at a time, and of overlapping requests only the latest is queued.
  - **Medium, fixed:** an audition was accepted while the workspace was changing sessions. It is now refused, like other audio work.
  - **Low, fixed:**
    - a clip rendered just before the output stream was replaced could be queued for the new stream;
    - the bass sample voice was not chosen from the bass programs; it now follows GM programs 32–39;
    - the callback's intake was unbounded;
    - the status serial could show with a stale peak;
    - the test for the callback's eviction and wrong-rate paths was missing.
- **Second round:** the reviewer approved the fixes.
  - **Low, fixed:** requests overtaken while a render was stuck kept waiting on threads, and a render that panicked blocked every later audition. Overtaken requests now give up while they wait, and a failed render no longer blocks the next one.
  - **Low, fixed:** a refused request cancelled a valid audition in progress.
  - **Low, kept as a limit:** a clip sent while the output device is being switched can be reported as played and never sound.
  - The reviewer approved these fixes too.

## Limits
- **A sounding clip is not cut on owner change:** switching documents does not stop a clip already playing; it ends by itself within its length.
- **Device switch:** a clip sent in the moment the output device is being switched is reported as played but is lost with the old stream.
- **Latency:** each audition loads its samples and renders from scratch, with no cache. A chord took about 106–147 ms to render before it sounded.
- **Buttons, not strings:** auditions come from the tuning buttons and from note edits. Clicking a string in the score, the instrument view or the fretboard does not play it (U12 is a separate row).
- **Edited beat only:** an edit plays the new or changed notes of its beat, not the surrounding notes or the whole chord diagram.
- **Not recorded:** auditions are not exported, recorded or sent to MIDI.

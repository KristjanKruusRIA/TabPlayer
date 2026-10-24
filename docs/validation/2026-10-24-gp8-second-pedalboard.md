# GP8 parity A37: duplicate pedals on a second pedalboard (2026-10-24)

GP8 lets a sound use the same kind of effect more than once. In TabPlayer, a track sound had one instance of each of its 18 blocks, so a pedal could be copied to another track but not doubled on the same one. This slice adds a second pedalboard after a track's signal chain. Any pedal can be duplicated onto it and keeps its own settings. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Duplicate pedal:** every pedal in the Sound task has a Duplicate pedal button. It copies the pedal, switched on, onto a second pedalboard that the signal passes through after the whole chain, as one undoable track-sound edit, and says "Duplicated the Name pedal onto the second pedalboard.". The second pedalboard starts with every other pedal switched off. A pedal already duplicated cannot be duplicated again.
- **Second pedalboard:** it appears below the signal chain while any pedal on it is switched on, and shows those pedals in the order they play, with the same controls as the chain. Each control is named "Second pedalboard: …", so it is distinct from the first pedal's. Editing a duplicate changes only the duplicate. Duplicates can be copied and pasted like any pedal.
- **Removing:** Remove duplicate switches a duplicate off. When the last one is switched off, the second pedalboard is removed from the sound.
- **Playback:** the second pedalboard plays exactly as a second track chain would after the first. Adding or removing it while playing fades it in or out over 10 ms; a removed board's echoes and reverb fade out with it. A board added while playing starts from silence as a pedal switched on does, so a room microphone's reflections fade in. A board added again does not replay what the removed one held.
- **Saved documents and sounds:**
  - a sound without a second pedalboard is written exactly as before;
  - saved sounds in My sounds, copied sounds and pasted sounds keep the second pedalboard;
  - a second pedalboard may not hold another one, and its pedals follow the same rules as the chain's. The editor and the native player refuse the same sounds, and both read a `null` second pedalboard as none;
  - a saved sound whose second pedalboard has nothing switched on loads without it.

## Evidence
- **Native** (`src-tauri/tests/audio_second_pedalboard.rs`, 6 tests):
  - **Format:** a sound without a second pedalboard has no `second` field; one with it round-trips. A nested board is refused with "Invalid second pedalboard." by both validation and the player, and an invalid duplicate is refused.
  - **Same as two chains in series:** a tremolo, chorus and delay, followed by a second board of another tremolo, chorus and a reverb, give exactly the output of the two chains run one after the other, over two seconds. Two graphic EQs at −6 dB lower a signal by 12 dB within 1e-6.
  - **No clicks:** a second board of a room microphone, a drive and a −9 dB level is added, removed and added again through both `set_settings` and the prepared-configuration path. The test signal is away from zero at each change. The largest step in the 20 ms after each change is no more than 1.25× the settled one. On removal, the board's own part of the output, against the first board alone, changes by no more on the prepared path than on the settings path: 0.0017 a sample on both. Once the board has faded out, the output is bit-identical to the first board alone. Without the fade the test fails, as it does when the prepared path drops a removed board at once, at 0.0129 a sample.
  - **Room microphone:** a second board holding a room microphone is added on both paths while a quiet 220 Hz sine plays. The largest step over the next 100 ms is no more than 1.25× the settled one. Before the fix, its first reflection arrived at full level 11 ms in, a step of 0.0064 against 0.0014, and the test fails.
  - **Added again:** after a board of long echoes and a reverb is removed and added again, both paths play exactly as if it had never been there. Before the fix, the prepared path replayed the removed board's echoes, and the test fails.
  - **Reset:** a reset clears the second board as well. This was confirmed to fail without it.
  - **Existing sounds:** the DSP, effect-order, factory-sound, amp and modulation tests pass unchanged; a sound without a second board takes the same path as before.
- **Editor** (`src/audio/second-pedalboard.test.tsx`, 5 tests):
  - the defaults have no second pedalboard. A nested board, a board that is not an object, an invalid duplicate setting and an unknown block are refused, and a `null` board reads as none. A second board saved before later blocks reads them as switched off;
  - Duplicate pedal records one edit with the pedal copied onto a new second board and only it switched on, and shows the status. Duplicate is then disabled, and the duplicate's rate and shape change only the duplicate. Every number field, list and checkbox on the board is named "Second pedalboard: …";
  - Remove duplicate switches one pedal off, and removing the last one removes the board. This was confirmed to fail when the empty board is kept;
  - a saved sound keeps its second pedalboard, and one saved with nothing switched on loads without it.
- **Desktop:** `tests/desktop/parity-second-pedalboard.mjs` on a Windows desktop-test build, with a sustained E2, B2 and E3 on a steel-string guitar, exported as WAV through the Export dialog. The levels are RMS over the chord from 0.1 to 1.5 s:

  | Export | Level | Change |
  |---|---|---|
  | No effects | −23.97 dBFS | |
  | Graphic EQ at −6 dB | −29.97 dBFS | −6.00 dB |
  | Duplicated onto the second pedalboard | −35.97 dBFS | −6.00 dB more |
  | Duplicate's level set to 0 dB | −29.97 dBFS | as the single EQ |

  - the duplicate edit held the same graphic EQ on both boards, and setting the duplicate to 0 dB left the first at −6 dB;
  - Remove duplicate while playing removed the second pedalboard from the sound and the panel; Undo brought it back; there were no page errors;
  - the effect-order, sound-library, factory-sound, amp tone, sound-preview, microphone and graphic EQ desktop tests still pass.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice: 740 tests;
  - the full `vitest` suite: the load-sensitive files pass when run alone;
  - `tsc`;
  - `rustfmt` on the changed native files.

## Review
- **First adversarial review** of the audio thread: changes requested, for one Medium and several Low notes. It found no allocation or freeing on the audio thread: a removed board's memory moves with the configurations and is freed on the control thread. 2000 random add and remove sequences on both paths, with changes 0 to 3000 frames apart, gave no step. Stale echoes were never replayed.
  - **Medium, fixed:** a second board with a room microphone, added while playing, started as at the start of playback, so its first reflection arrived at full level 11 ms later, about 35 times the settled step. It now starts as a pedal switched on while playing.
  - **Low, fixed:**
    - a seek reset second boards that could never play again, which doubled the cost of a seek; only a board in use is reset now;
    - the click test changed settings where the signal crossed zero, so a hard switch on adding passed. The signal now sits away from zero at each change, and a hard switch fails;
    - Flatten graphic EQ had the same name on both boards;
    - the second board listed its pedals in the default order rather than the order they play;
    - a stored second board with nothing switched on showed as an empty board that could not be removed; it is now dropped when loaded;
    - the editor refused a `null` second board that the native player reads as none; both now read it as none.
- **Second review:** approved. The room microphone now steps 0.00037 when its board is added, against 0.00035 for the same microphone switched on in the chain, on every path. 600 random sequences with seeks gave bit-identical output on both paths.
  - **Low, fixed:** the new test signal moved the weak spot, so a removed board dropped at once on the prepared path passed. The removal is now compared with the settings path's fade, and that failure is caught.

## Limits
- **Two instances at most:** each pedal can play at most twice, once in the chain and once on the second pedalboard. There are no parallel chains.
- **Fixed order on the second pedalboard:** its pedals play in the default order and cannot be moved; the second pedalboard always comes after the whole chain.
- **No drag and drop.**
- **Memory:** each prepared configuration of a track with a second pedalboard builds a whole second chain, including a 16-second delay line, off the audio thread.
- **Older builds:** a sound with a second pedalboard cannot be opened by builds from before this slice.

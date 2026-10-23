# GP8 parity A17: reorderable signal chain (2026-10-24)

GP8 lets a track's pedals and amp be arranged in any order along the signal chain. TabPlayer ran its blocks in one fixed order, from the microphone to the reverb. This slice lets each track's sound put its 17 blocks in any order, in the native player and in the Sound task. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Signal chain:** the Sound task lists the blocks in the order the sound plays them, under "Signal chain" instead of "Fixed signal chain".
- **Moving a block:** each block has Move earlier and Move later buttons, labelled with its name, for example "Move Drive later". They are disabled at the ends of the chain.
  - Each move swaps the block with its neighbour and is recorded as one undoable track-sound edit.
  - The status line says where the block went, for example "Drive is now 8 of 17 in the chain.". Keyboard focus stays on the pressed button, or moves to the other one when the block reaches an end.
  - A block's settings stay with it wherever it moves. Copying and pasting a pedal changes only its settings, not the order.
- **What the order changes:** each block processes what the blocks before it produce. For example:
  - with a distortion before a delay, each repeat is the same distorted sound, falling by the feedback;
  - with the distortion after the delay, it squeezes the falling repeats back up.
- **While playing:**
  - A move among blocks that are switched off changes nothing heard, so it applies at once, with no fade.
  - A move that changes the order of blocks that are playing fades the chain's output out over 10 ms, swaps the order at silence and fades it back in over 10 ms.
  - Each block keeps its own state, so a delay's or reverb's tail carries on through the move. Choosing another order during the fade turns it round from the current level.
- **Saved documents and sounds:**
  - the default order is not written, so documents and sounds saved before this slice load and save unchanged;
  - an order must name every block exactly once. The editor refuses any other order with "Invalid effect order.", as the native player does;
  - saved, copied and pasted sounds keep their order. Choosing a factory preset returns to the default order, as it does for every other setting.

## Evidence
- **Native** (`src-tauri/tests/audio_effect_order.rs`, 9 tests):
  - **Format:** the default order is not written and older settings read as the default. An explicit order round-trips. Orders that leave out a block, name one twice or name an unknown one are refused.
  - **Default unchanged:** a fingerprint of every block running, with a settings change halfway, was taken before blocks could be reordered. It is bit-identical after the change, with the order left empty or named explicitly.
  - **Order matters:** through a distortion and a digital delay with 0.5 feedback, each repeat with the drive first is 0.5 ± 0.02 of the one before. With the drive after the delay, each repeat is above 0.6 of the one before.
  - **Every order:** all 17 rotations of the chain and its reversal, with every block enabled, are deterministic, finite and within ±1.
  - **No clicks:** four reorders, including a move back to the default order, are made while a sine plays, through both `set_settings` and the prepared-configuration path that live edits use. The largest step in the 40 ms after each one is no more than 1.25× the larger settled step. The test was confirmed to fail without the fade (0.0239 against a 0.0064 bound).
  - **Takes effect:** 20 ms after a reorder, on either path, the player produces exactly the samples of one built in the new order.
  - **Switched-off blocks:** four moves that only change the places of blocks that are off produce exactly the samples of a player that was not reordered, on both paths. The test was confirmed to fail when every move fades.
  - **The fade itself** is read directly, through two blocks that pass a steady level unchanged, on both paths:
    - one reorder reaches silence at the swap and is back to full within 20 ms;
    - turning back 3 ms in fades back in from about 0.7;
    - a third order during the fade-in fades out again from where it got to;
    - no frame steps by more than the fade's slope, 1/480 of full level.
  - **Another sample rate:** a configuration at 8 kHz that takes over from one at 192 kHz halfway through a fade carries on from the same level, within 0.03.
- **Editor** (`src/audio/effect-order.test.tsx`, 7 tests):
  - the default order matches the native one and is not written; `chainOrder` reads a sound's order;
  - valid orders are accepted. Missing, repeated or unknown blocks, extra entries and non-arrays are refused with "Invalid effect order.";
  - the panel lists the blocks in the sound's order, disables the moves at the ends, and records one move as a track-sound edit that keeps the block's settings. Moving back to the default order records no order;
  - pasting a pedal keeps the order;
  - a saved sound and a copied and pasted sound keep the order;
  - keyboard focus returns to the pressed button after a move, or to the other one at an end of the chain, and the status line gives the new position. The test was confirmed to fail without the focus fix;
  - choosing a factory preset returns to the default order.
- **Desktop:** `tests/desktop/parity-effect-order.mjs` on a Windows desktop-test build.
  - **Setup:** a sixteenth-note A3 on a steel-string guitar, through a distortion (drive 0.8) and a dotted-quarter digital delay (feedback 0.5, mix 1), exported as WAV through the Export dialog.
  - **Before the move:** with the drive before the delay, the second and third repeats are 0.500 and 0.500 of the one before. Exporting again gives identical samples.
  - **After the move:** nine Move Drive later clicks put the drive after the delay. The repeats are then 0.897 and 0.877 of the one before.
  - **Recorded order:** the final edit records the moved order.
  - Playback ran live; Undo moved the drive back before the delay; there were no page errors.
  - The microphone, delay, drive, reverb, modulation, pitch, wah, sound-library, sound-preview and export desktop tests still pass on the same build.
- **Verification:**
  - every Rust test target except `file_library_intake`, which has a compile error that predates this slice, 705 tests before the review fixes. The effects targets and the library were rerun after them;
  - the full `vitest` suite. The load-sensitive `App`, `corpus`, `tuning-ui` and `WorkspaceApp` files failed under load and pass when run alone;
  - `tsc`.
  - The native effects code and its tests were formatted with `rustfmt` in a separate commit, because CI checks formatting.

## Review
- **First adversarial review:** changes requested.
  - **Medium, fixed:** every reorder dipped the output for 20 ms, even a move among blocks that are switched off. On a typical sound that is most clicks of the move buttons. Such a move now applies at once when no settings crossfade is running, and the new test pins it bit-exactly.
  - **Low, fixed:**
    - a configuration at another sample rate taking over mid-fade could underflow the fade counter; it is now rescaled to the new rate;
    - the tests did not read the fade, cover the live-edit path for the takeover, or turn round mid-fade; they do now;
    - keyboard focus was lost when the moved block's buttons moved; it is now restored and the new position announced;
    - that a preset drops the order was untested; it is now tested.
  - **Low, kept as they are:** the microphone can be moved like any other block, and an explicit empty order is accepted as the default.
  - **Checked and fine:** each block keeps its own state in any position. No value passes between blocks. `process()` does not allocate. The default order's output is unchanged.
- **Second review:** approved.
  - A probe on both paths confirmed the shortcut is bit-exact when a block is switched on in the same edit as an off block moves, when an auto wah or a room microphone is switched on, and when a block moves after it reached the end.
  - A move made while a block is still fading out from an earlier edit falls back to the fade, without a click.
  - The rescale across sample rates was added after its note that clamping would restart a fade.

## Limits
- **One of each block:** a chain has each of the 17 blocks once. GP8 can add a pedal more than once, and route through separate chains; neither is supported here.
- **Moving by steps:** blocks move one place at a time with buttons; there is no dragging.
- **Reorder dip:** a move that changes the order of playing blocks dips the output to silence for 10 ms on each side of the swap, rather than crossfading two chains. The blocks hold one state each, so two chains cannot run side by side. A move of switched-off blocks within 10 ms of another edit also takes the dip.
- **Microphone placement:** the microphone can be moved like any pedal, although it stands for how the instrument was recorded. Placed after a stereo reverb, its mono output folds the reverb's width away.
- **Older builds:** a sound with a non-default order cannot be opened by builds from before this slice.

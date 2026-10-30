# Master effects and overall controls

Date: 2026-10-24. Status: design, implemented on the slice branch. Row A18, "Master track effects/mastering and overall controls". Only a listener can judge how the reverb and compressor sound on a mix; the tests below pin what the chain does, not whether it is pleasant.

## Brief

GP8's score mastering gives the song its own chain after the mixer. TabPlayer had a fixed internal limiter and no song-level level, balance or effects. This slice adds a master chain on the mixed output, edited from the mixer, stored in the document, undoable, and applied the same way in playback and in audio export (both run the one `Renderer`).

No dependency is added. The compressor, EQ and reverb are the existing pedalboard blocks from `dsp.rs`, run once on the mix. Nothing in `tone.rs` changes.

## Behaviour

### The chain

In the renderer's per-frame mix, the tracks and the backing are summed, then pass through:

1. the master pedalboard: compressor, EQ, reverb (the reverb mix control is the send level);
2. the overall level (-24..+12 dB) and balance (-1..1; it turns one side down and leaves the other, so centre is exactly unity);
3. the metronome click is added after those, so it is neither coloured nor turned with the music;
4. the master limiter on the sum of everything that sounds, the click included.

The limiter has an instant attack and no lookahead (so no added delay), a ceiling from -12 to 0 dB and a release from 10 to 1000 ms. Its clamp makes the ceiling exact: no output sample, mid-change or not, exceeds the ceiling in force. A change to the limiter crossfades the old and new limiter over 10 ms; during that blend the output is under the higher of the two ceilings, and under the new one once it ends.

Defaults: everything off, level 0 dB, balance centre. The numbers behind a switched-off block are where it starts when switched on (a gentler compressor than a track's: -12 dB, 2:1, 30/200 ms; a hall reverb at mix 0.1; limiter -1 dB, 100 ms).

### Bit-identical default

A master that was never edited, or whose blocks are all off with level 0 and balance centre (`is_neutral`), hands the mix back untouched: `bus` skips the board when it is off and not fading, skips the level when it is unity, and `limit` returns its input while idle. Test `an_untouched_master_leaves_the_mix_bit_for_bit_as_it_was` renders a loud multi-track scene with no master, a default master and a different neutral master, and compares every sample bit for bit. The click is added last, so the sum keeps the order it always had.

### Changing it while it plays

`MasterBus` is resolved off the audio thread (`PreparedMix` builds it with the rest of the mix). Installing a new one calls `transition_from`: the board crossfades itself, the level glides over 10 ms, and the limiter carries its held gain across. `process` allocates nothing and takes no lock (`the_master_stays_off_the_heap`). A seek resets the effect tails and the limiter gain.

### Storage

The master is `DocumentSettings.master`, an optional field that is absent until first edited and skipped when serialized, so every project saved before this slice replays and saves exactly as it did. It is written by one new settings edit, `setMaster { master }`, which is a document-settings edit like `setTrackMix`: it joins the same undo history and the saved edit log, and is allowed on a finalized score since it is how a player balances playback. No new field exists on `Project`; the master lives in the edit log, so `file_library/metadata_input.rs` needs no field and its index ignores `setMaster` wherever its `type` sits in the object (tested). A new edit command has to be listed in `tests/protocol.json` and the hard-coded counts (76 to 77) in `protocol.rs` and `harmony-commands.test.ts`.

Rust (`MasterSettings::validate`) and TypeScript (`masterProblem`) refuse the same things: unknown or missing fields, non-finite or out-of-range numbers, and the pedalboard's own block rules. A malformed `setMaster` is refused when a project is opened without throwing part way through `buildDocument`. A room reverb saved without its model is read back as `room`, as the native player writes every pedalboard.

### Interface

A "Master" strip at the right end of the Mixer (`MasterPanel`): overall level and balance sliders, then Compressor, EQ, Reverb (with model and send) and Limiter sections, each with an on switch, and "Reset master". It reads "Untouched" or "Changed". A slider follows a draft while dragged and commits once when the gesture ends, so a drag is one undoable edit. It is disabled while the app is busy.

## Cost

Measured by `master_cost` on 20 s of 48 kHz stereo, release build, per frame and as a share of one core at 48 kHz: untouched 2.1 ns (0.01%), level and balance 2.0 ns, limiter 5.8 ns (0.03%), EQ 37.5 ns (0.18%), compressor 56.5 ns (0.27%), hall reverb 57.0 ns (0.27%), everything on 94.9 ns (0.46%). Building a bus takes 168 microseconds, off the audio thread.

## Acceptance

- A master chain with EQ, compressor, reverb send, limiter, level and balance, edited from the Mixer, saved in the document, undoable.
- The default chain is bit-identical to before; `audio_clean_sounds` and `audio_tone` pass unchanged.
- The limiter holds its ceiling against any input, including NaN and infinities, and across changes.
- Playback and export render through the same chain.
- Desktop driver `tests/desktop/parity-master-effects.mjs` (written, to be run by the controller): the level edit scales the exported WAV by its gain, the limiter keeps the export under its ceiling, Undo restores the unmastered export sample for sample, the level changes while playing without a new preparation, and Reset is one edit.

## Scope and limits

- Not done: a per-block drag-to-reorder of the master chain (its order is fixed), a master delay or other pedalboard blocks, true-peak (inter-sample) limiting, lookahead, and automation of the master over time.
- The limiter bounds sample peaks, not inter-sample peaks; a later DAC or lossy encode may exceed the ceiling slightly.
- Export-time normalization (`write_normalized_wav`) runs after the chain and never lifts a sample above its own peak ceiling.
- The balance control is a gain on one side, not a pan law.
- No listening review has been done.

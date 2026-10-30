# Master effects and overall controls

Date: 2026-10-24. Status: design, implemented on the slice branch. Row A18, "Master track effects/mastering and overall controls". Only a listener can judge how the reverb and compressor sound on a mix; the tests below pin what the chain does, not whether it is pleasant.

## Brief

GP8's score mastering gives the song its own chain after the mixer. TabPlayer had a fixed internal limiter and no song-level level, balance or effects. This slice adds a master chain on the mixed output, edited from the mixer, stored in the document, undoable, and applied the same way in playback and in audio export (both run the one `Renderer`).

No dependency is added. The compressor, EQ and reverb are the existing pedalboard blocks from `dsp.rs`, run once on the mix. Nothing in `tone.rs` changes.

## Behaviour

### The chain

In the renderer's per-frame mix, the tracks and the backing are summed, then pass through:

1. the master pedalboard: compressor, EQ, reverb. The reverb's mix control, labelled "send" in the Mixer, is the pedalboard's wet/dry crossfade, not a true send: raising it turns the dry mix down as it brings the reverb up, where a send would leave the dry at full level;
2. the overall level (-24..+12 dB) and balance (-1..1; it turns one side down and leaves the other, so centre is exactly unity);
3. the metronome click is added after those, so it is neither coloured nor turned with the music;
4. the master limiter on the renderer's sum of the music and the click, so everything the renderer produces is limited. What the device adds after the renderer is outside the chain and unlimited: the count-in click and audition clips (see Scope and limits).

The limiter has an instant attack and no lookahead (so no added delay), a ceiling from -12 to 0 dB and a release from 10 to 1000 ms. Its clamp makes the ceiling exact for a settled limiter: every sample it emits is within the ceiling, and a non-finite input becomes silence. A change to the limiter crossfades the old and new limiter over 10 ms; the output during that blend is a weighted sum of the two limiters' outputs, so it is under the higher of the two ceilings, not the new one, until the blend ends. The renderer's existing soft clip (`master_limit`, above 0.9) still runs after the limiter, so a ceiling above -0.9 dB is softened further and never raised.

The stem exports (`render_stems_into` and the stems of the mixed export) are the per-track and backing signals before the master: the effects, level, balance and limiter apply to the mixed output only.

Defaults: everything off, level 0 dB, balance centre. The numbers behind a switched-off block are where it starts when switched on (a gentler compressor than a track's: -12 dB, 2:1, 30/200 ms; a hall reverb at mix 0.1; limiter -1 dB, 100 ms).

### Bit-identical default

A master that was never edited, or whose blocks are all off with level 0 and balance centre (`is_neutral`), hands the mix back untouched: `bus` skips the board when it is off and not fading, skips the level when it is unity, and `limit` returns its input while idle. Test `an_untouched_master_leaves_the_mix_bit_for_bit_as_it_was` renders a loud multi-track scene with no master, a default master and a different neutral master, and compares every sample bit for bit. The click is added last, so the sum keeps the order it always had.

### Changing it while it plays

`MasterBus` is resolved off the audio thread (`PreparedMix` builds it with the rest of the mix). Installing a new one calls `transition_from`: the board crossfades itself, the level glides over 10 ms, and the limiter carries its held gain across. `process` allocates nothing and takes no lock (`the_master_stays_off_the_heap`). A seek resets the effect tails and the limiter gain.

The master guards itself against two states that would otherwise be costly or permanent. Its board zeroes compressor, EQ and room-reverb state once it falls below 1e-20 (`flush_quiet_state`, set by `MasterBus::new` only), because silence after a loud passage lets decaying feedback state fall through the subnormal range, where each frame costs several times the normal time on the audio thread; a track's board keeps its exact arithmetic, so track output and the golden tests are unchanged, and the threshold is 400 dB below full scale. Per-stage flushing is used rather than the FTZ/DAZ processor flags, which would have to be set on both the callback and the export threads. And the board's input is held to 64 (as its output already is), because a finite sample near the top of the f32 range, such as a corrupt float backing file could hold, would overflow the reverb's feedback and leave it at NaN until a seek. The hold is only in the path while an effect runs, so a neutral master still hands its input back untouched.

### Storage

The master is `DocumentSettings.master`, an optional field that is absent until first edited and skipped when serialized, so every project saved before this slice replays and saves exactly as it did. It is written by one new settings edit, `setMaster { master }`, which is a document-settings edit like `setTrackMix`: it joins the same undo history and the saved edit log, and is allowed on a finalized score since it is how a player balances playback. No new field exists on `Project`; the master lives in the edit log, so `file_library/metadata_input.rs` needs no field and its index ignores `setMaster` wherever its `type` sits in the object (tested). A new edit command has to be listed in `tests/protocol.json` and the hard-coded counts (76 to 77) in `protocol.rs` and `harmony-commands.test.ts`.

Rust (`MasterSettings::validate`) and TypeScript (`masterProblem`) refuse the same things: unknown or missing fields, non-finite or out-of-range numbers, and the pedalboard's own block rules. A malformed `setMaster` is refused when a project is opened without throwing part way through `buildDocument`. A room reverb saved without its model is read back as `room`, as the native player writes every pedalboard.

### Interface

A "Master" strip at the right end of the Mixer (`MasterPanel`): overall level and balance sliders, then Compressor, EQ, Reverb (with model and send) and Limiter sections, each with an on switch, and "Reset master". It reads "Untouched" or "Changed". A slider follows a draft while dragged and commits once when the gesture ends, so a drag is one undoable edit. It is disabled while the app is busy.

## Cost

Measured by `master_cost` on 20 s of 48 kHz stereo, release build, per frame and as a share of one core at 48 kHz: level and balance 1.5 ns, limiter 5.6 ns (0.03%), EQ 35.1 ns (0.17%), compressor 55.3 ns (0.27%), hall reverb 47.3 ns (0.23%), everything on 93.3 ns (0.45%). Building a bus takes 135 microseconds, off the audio thread.

Silence after a loud burst is measured too (`master_cost` prints the quickest and slowest half-second of 20 s of silence): a long room reverb with the EQ cut, compressor and limiter on stays at 109 to 118 ns/frame, and everything on at 88 to 99 ns/frame. Before the master's board flushed its quiet state, the same silence rose from about 0.1 to about 1.7 microseconds per frame once the reverb's tail reached the subnormal range (about 29% of the frame budget with everything on); that was found in review. `silence_after_a_burst_does_not_slow_the_master_down` times it and `a_tail_dying_away_in_silence_never_passes_through_the_subnormal_range` checks it deterministically; both fail without the flush.

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
- The count-in click and audition clips are mixed by the device after the renderer, outside the master chain and its limiter. Limiting them would need a second limiter instance on the device (the renderer's holds state that the playback frame already advances, and its ceiling follows the master's changes), and the neutral master has to stay bit for bit; they are bounded by their own volume and the click's level, and are not part of the exported mix.
- The export's effect tail (2 s by default, 0 to 30 s) is a hard cut: a long Hall or Room tail still ringing at the end stops abruptly. Playback renders no tail at all: it seeks to the end and stops. No fade is added to the export; lengthen the tail to let it ring out.
- No listening review has been done.

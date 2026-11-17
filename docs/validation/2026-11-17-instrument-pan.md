# The score's pan on a hosted instrument - validation, 2026-11-17

Branch `agy/remainder-batch-3`. `2026-11-17-vst-second-track.md` (Limits) and `2026-11-17-vst-instruments.md` left one gap open: the score's pan of a drum track played by a hosted instrument was not applied to the instrument's output, while an effect plug-in's track got the score's balance right after the insert. This note records the change and its checks. Only the repository's synthetic fake helper and test plug-in were used; no commercial instrument was tried, and nothing was listened to.

## What was real today

Read in the code before the change: `PreparedChannel::attach` and `prepare_with_plugins` set `pan_after` only for an effect, and the `Input` point of `TrackDsp::process_board` never read `insert_pan`. An instrument replaces the track's own sound at the board's input, so its output was multiplied by nothing. The first new tests failed that way (the instrument's two sides equal for a track the score pans hard left or right).

## What changed

- `audio/renderer.rs`: a track with any plug-in has its pan after the plug-in (`pan_after`), and a new flag `pan_flat` says the plug-in is an instrument. The voices of the built-in kit that stand in for an instrument keep the level of the centre on both sides (`pan_pre(.., flat)`), not the louder side's level that an effect is fed, and the pan applied to what the plug-in makes is the score's pan itself (`pan_post`). The two multiply to the score's pan, as before. The same `[cos, sin]` law, the same 10 ms glide when a plug-in is added or removed, and the same delay queue (a pan move reaches the output `D` frames after it reaches the voices, 16 moves held per track, nothing allocated on the audio thread) are used for both kinds.
- `audio/dsp.rs`: the score's pan is applied once, at the point the insert sits at: after the instrument at the input, after the effect at the Amp point. While a slot changes between the two kinds an insert sits at each point, and the factor is split between them (`pan_input_share`, `pan_share`): the factor raised to the share at the input and to one minus the share at the Amp point, so the two multiply to the factor all along. The share glides from where the leaving insert sits to where the arriving one does over the 10 ms ramp, and is carried over at an edit hand-over (including one that comes part-way through such a glide), so a stage between the points (a mono microphone, a room's reflections, any filter) is fed what it was fed the frame before and the placement does not move past it in one frame. A side the score silences (factor 0, which no power splits) is split from a floor of 1e-4, 80 dB down.

Old projects and edit logs are untouched: nothing in the project schema, edit types or stored settings changed; the pan is read from the plan's controller 10 events as before. A track with no plug-in, a refused or missing slot, and a track with an effect plug-in take the same code path as before (`pan_flat` is false, the Amp point applies the pan as it did).

## How it was checked

All with `--locked --manifest-path src-tauri/Cargo.toml`, with Cargo's output in a shared target folder outside the checkout.

| Check | Command | Result |
|---|---|---|
| New and old instrument tests | `cargo test ... --test audio_plugin_instrument` | 88 passed, 0 failed (15 are new) |
| Effect tracks and the rest of the insert tests | `cargo test ... --test audio_plugin_insert` | 64 passed, 0 failed, no test edited |
| Renderer and board unit tests with "pan" in the name | `cargo test ... --lib pan` | 23 passed (one is new) |
| Real helper and test plug-in, drum instrument | `cargo test ... --test plugin_instrument -- --ignored` | 6 passed |
| Format | `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | clean |

The new tests in `src-tauri/tests/audio_plugin_instrument.rs`, each failing before the change except where stated:

| Test | What it pins |
|---|---|
| `a_hosted_instrument_is_placed_by_the_scores_pan` | pans 0, 16, 32, 48, 100, 127 at plug-in latencies 0 and 64: every frame is the centred track's frame times the voices' law |
| `the_side_the_score_silences_is_silent_on_a_hosted_instrument` | hard left and hard right: the other side is under 1e-6 of the sounding one |
| `a_centred_instrument_track_renders_as_it_did_before_the_pan_was_applied` | golden: a track with no pan event, and one with controller 10 at 64, at latencies 0, 64 and 128 renders to the bit what the code before the change rendered (fingerprints taken from the unmodified code); passes before and after |
| `a_pan_moved_while_a_hosted_instrument_rings_places_each_part_where_its_delay_puts_it` | a move from hard left to hard right while a hit rings, latencies 0, 64, 480: each part is placed by the pan that entered the plug-in with it |
| `a_seek_...`, `a_loop_wrap_...`, `an_edit_hand_over_leaves_a_hosted_instrument_where_the_score_has_the_pan` | the pan after a seek into the held hit, a loop wrap from the right-panned end to the left-panned start, and an edit hand-over while the move is still held back. The hand-over test fails if the queue is not carried over (checked by commenting out the carry) |
| `the_kit_mix_of_the_built_in_kit_does_not_reach_a_hosted_instrument` | a kit mix with a hard-panned kick and snare changes no sample of the instrument's output (passes before and after) |
| `the_built_in_kit_that_stands_in_for_a_hosted_instrument_is_placed_like_the_instrument` | with the helper stalled the built-in kit plays and the side the score silences carries under 0.01% of the other |
| `the_side_the_score_silences_stays_silent_while_a_hosted_instrument_comes_and_goes` | an instrument added, played and removed on a panned track: the silenced side stays under 3% over the whole run (the built-in synthesizer's own leak) and under 0.01% while the instrument plays |
| `an_export_places_a_hosted_instrument_by_the_scores_pan` | an export of a hard-right track places every sample as playback does, the first hit on sample 0 |
| `a_board_places_what_its_instrument_makes_and_its_stand_in_by_the_factor_it_is_given` | the board alone: the instrument's output, and the track's own sound after a fault, are multiplied by the factor |
| `switching_between_an_effect_and_an_instrument_places_the_track_once` | a pan factor of one half through a switch in both directions: the settled sound at each end is placed once, and no step is sharper than the unpanned switch's |

A review then found that a plug-in removed, or changed between an effect and an instrument, on a panned track stepped what the leaving plug-in still played: the level the voices keep (`pan_flat`) changed at once while only the glide `pan_blend` and the leaving plug-in's 10 ms fade were gradual, so the factor placing the leaving output dropped (instrument removed, instrument to effect) or rose (effect to instrument) by the loud side's factor, 3 dB for a hard pan. `pan_flat` now keeps its value while the plug-in goes, and a new `pan_flat_mix` glides between the louder side's level and the centre's over the same 10 ms (copied over at an edit hand-over). Tests, each failing before that change:

| Test | What it pins |
|---|---|
| `removing_a_hosted_instrument_from_a_panned_track_does_not_step_what_it_still_plays` | a held hit ringing at the louder side's level, pans 127, 96 and 0: the largest step over the removal is under 0.004 (it was 0.021 for a hard pan) |
| `changing_a_hosted_instrument_to_an_effect_on_a_panned_track_does_not_step_what_it_still_plays` | the same for a slot changed to an effect, pans 127 and 96 |
| `the_pan_that_places_a_plug_in_moves_without_a_step_when_the_plug_in_comes_goes_or_changes_kind` (unit, `renderer.rs`) | add, remove and change kind in every pairing, for a hard pan and a mild one: the louder side's factor moves under 0.004 a frame, and what the voices keep times what is applied after the plug-in is the score's pan at every frame |

A second review found that the first fix left the point where the pan is applied jumping during a switch between an effect and an instrument: with a Microphone block that folds the sides to mono (or adds a room's reflections) between the input and the Amp point, moving the pan from before it to after it in one frame, at a factor near the full pan, gave a different sound in one frame (a step of 0.24 and 0.18 for a track panned hard right with a mono microphone, 0.06 to 0.10 with a room). The earlier tests all used boards with every block off. Tests, each failing before that change:

| Test | What it pins |
|---|---|
| `changing_a_hosted_instrument_to_an_effect_does_not_move_the_pan_past_a_microphone_in_one_frame` | renderer level, the keyed instrument ringing on a track panned 127, 96 and 0, a microphone of `standard` placement with mono output, `room` with stereo and `room` with mono: the largest step over the change is under 0.002 (it was up to 0.036) |
| `a_switch_between_an_effect_and_an_instrument_moves_the_pan_past_a_microphone_over_the_fade` | the board alone, both directions, a hard pan held through the switch, the same three microphones: no step above the unpanned switch's 0.03 (it was 0.24 and 0.18 with the mono microphone, 0.06 with the room); this is the only check of the effect to instrument direction with a microphone |
| `the_two_parts_of_a_split_pan_multiply_to_it_and_move_without_a_jump` (unit, `dsp.rs`) | the two parts multiply to the factor (to the floor for a silenced side) at every step of a 10 ms split, and no side moves by more than 0.025 a frame |

The settled sounds at either end are as before: the existing `switching_between_an_effect_and_an_instrument_places_the_track_once` and the golden test of a centred track pass untouched, and nothing is applied twice, since the two parts multiply to the factor.

## Limits

- Nothing was listened to. The tests prove levels and frames against the synthetic fake and the test plug-in; whether a real drum library in a stereo mix sounds right when panned is for an ear.
- The pan is applied to the instrument's stereo output with the same law as the built-in voices. A kit-element pan (the Rig's per-element balance) belongs to the built-in kit and is not applied to an instrument, whose library has its own mixer; the kit note in the interface already says so. The mixer's own track pan fader acts after the board, as before, on both.
- The built-in kit that stands in for an instrument (while it primes, and for good after it faults) is now placed by the score's pan law, not by the General MIDI synthesizer's own, so a track that is off the centre differs from the same track's built-in sound without a plug-in in the last bits of the voices and, for the synthesizer, in the roughly 1.3% it leaks into the side its own pan silences.
- A slot changed between an effect and an instrument on a panned drum track while it plays glides the level the voices keep (the louder side's for an effect, the centre's for an instrument) and the point where the pan is applied (split between the input and the Amp point, see above) over 10 ms, with the leaving insert's fade. The split is checked at a hard and a mild pan with a mono and a room microphone, not with every other block (a wah, an octaver, a pitch shifter or an EQ before Drive): those see the same split factors, and a stage that is nonlinear or has state between the points still sees a signal that changes level over the 10 ms, as it does for the plug-in's own fade. The effect to instrument direction is checked by the unit test on the factors only: a renderer-level step test needs a leaving effect that plays a steady signal, which the built-in kit does not give. The quieter side's factor moves fast near the end of a glide where the pan is hard (as an effect's always did); what it places there is the quieter side of the score's pan.
- Several MIDI channels of one track with different pans take the pan set last on an instrument, as they do on an effect.
- Everything the earlier notes list for the pan of a track with an effect (a loop wrap within 10 ms of a plug-in being removed, the glide not being delayed by the plug-in's delay, a General MIDI voice staying centred until the next seek) holds for an instrument too.
- Windows and VST3 only, as the hosting is. macOS and Linux run the cross-platform tests above in CI only.

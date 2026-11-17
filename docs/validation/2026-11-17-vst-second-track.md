# A VST3 effect on the second guitar track is silent (2026-11-17)

Branch `agy/vst-second-track`, from `develop`. A report from the installed build, of a song with several distortion guitar tracks and a drum track: an amp-simulation effect plug-in sounded on the first guitar track and the second guitar track was silent, while a drum instrument plug-in worked. On the second guitar the slot said Ready and Active, both trims were 0 dB, and unticking Active brought the track's own sound back. The same plug-in as on the first track was tried, and another one: both silent on the second track.

## Cause

The score pans the guitars, and a track's pan was applied before its board, so an effect plug-in heard it.

- The score pans two guitars to opposite sides: the first at balance 0 and the second at balance 16, that is, hard left and hard right. alphaTab writes them as MIDI controller 10 values 0 and 128, which the plan clamps to 127. The other guitars and the drums are at the centre.
- The recorded guitar voices apply that pan in `MidiChannel::process`, in the renderer, as each voice is mixed: `[cos, sin]` of the pan angle times the square root of two, so at 127 the left factor is 1e-16 and the track is on the right channel only (`renderer.rs`, `MidiChannel::process` and the controller 10 case of `midi_event`). The board, and the effect plug-in at the Drive, Amp and Cabinet point, comes after it.
- The two plug-ins in the report are commercial guitar amp simulations. Played straight through the insert with a real helper, a signal on the right input only gives exact silence from both (peaks 0.0000), while left only, both alike and opposite signs all sound. They declare a stereo bus and read the left channel only, as many guitar amp simulations do. The first guitar is on the left, so it works; the second is on the right, so it is silent. The built-in chain processes both channels, so the track's own sound is there when the slot is inactive, and the status is Ready because nothing is wrong with the helper.

| Plug-in (installed, by kind) | Left only in | Right only in | Opposite signs in |
|---|---|---|---|
| Amp simulation A | sounds, on both sides | **silent** | sounds |
| Amp simulation B | sounds, on both sides | **silent** | sounds |
| Per-channel amp simulation | sounds, left only | sounds, right only | sounds |
| Amp simulation that sums to mono | sounds, both sides | sounds, both sides | **silent** (mono sum) |

## What was ruled out

Before the cause was found, the multi-track paths were tested with the real helper and with in-process fake helpers, and all passed with the unfixed code: two effects on two guitars and an instrument on the drums; the effect on the second guitar only; plug-in latencies 0 against 480 and 100 against 700; the second effect chosen while the first plays, while stopped, while paused, before the first play, by an edit's hand-over, and with the pipeline growing; 44.1 kHz with 1,024-frame callbacks; every factory sound, every block of the board alone, a second pedalboard, and a change from any of five factory sounds to another while the insert plays; the recorded voices; the export. One helper per track, a ring and two events per helper, one `HelperKey` per track, one insert per channel and one compensation line per track were read in the code and held. None of these produced silence on a track whose plug-in the helper reported as Ready.

## Fix

A track with an effect plug-in is panned at the plug-in's output, not before it (`audio/renderer.rs`, `audio/dsp.rs`). The first version of this fix panned the whole board's output, which two adversarial reviews showed changes tracks whose plug-in already worked; the version here is the result of those reviews.

- `PreparedChannel::pan_after` is set when an effect insert is attached (a prepare, a mix change, an export). A slot that is inactive, refused, for another track, missing or an instrument leaves it false, and the pan stays before the board exactly as it was.
- The recorded voices of such a track play at the same level on both sides, that of the louder side the score gave (`pan_pre`): a track the score pans hard right reaches the plug-in as the signal it always had on the right, on both channels. The board's stages before the plug-in (a gate or compressor, which measure the larger of the two sides) measure what they measured, and an amp that saturates is driven as hard as it was.
- What is left of the pan (`pan_post`: the score's factor over the voices' factor, 0 on the silent side) is applied by `TrackDsp::set_insert_pan` to what the plug-in makes, or to its built-in stand-in while it primes or after it faults, before the stages after it. A reverb or delay after the plug-in, and the second pedalboard, hear the guitar placed, as before. If the board has no plug-in at that point any more, the factor is applied to what the board makes.
- The two factors multiply to the score's pan all along the 10 ms glide that runs when a plug-in is added to or removed from a panned track, so the side the score silences gets none of the guitar on the way.
- The score's pan changes (controller 10) take effect at the plug-in's output `D` frames after they reach the voices, `D` being the plug-in's delay, because that is when what entered with the old pan comes out. The moves are held in a fixed queue of 16 per track, with no allocation on the audio thread; a seek replays the controllers, a loop wrap keeps the queue, and an edit's hand-over carries the queue and the glide to the new renderer.
- The track's General MIDI synthesizers are told the centre for controller 10 once the pan is after the plug-in, and their output is multiplied by the same factor as the voices (`synth_factors`), so the pan is applied once. They keep the centre when the plug-in is removed, and the renderer goes on placing them, until the next seek, because a synthesizer handed its pan back moves its voices to it over a block of its own while a factor outside it moves at once, which is heard as a click.
- The count-in, the drain after the last note and the export go through the same code.
- A track with no effect plug-in, a track with an instrument, and a centred track render the same samples as before: the factors are exactly 1 for them, and a multiplication by 1 is not done.

The test plug-in (`test-plugin`) has a tenth mode, `LeftOnly`, which plays the left input on both sides and never reads the right one, to stand in for such plug-ins. The mode parameter has nine steps instead of eight; the values the tests and drivers use (0.125 and 0.25) still pick Crash and Hang.

## Review findings and what was done

Two reviews of the first version returned these; each was reproduced by a test that failed on that version or is recorded below as not reproduced.

| Finding | Result |
|---|---|
| The pan came after every stage of the board, so a reverb after the plug-in lost its cross-feed and a gate or compressor before it measured another level | Confirmed (`the_stages_before_and_after_a_plug_in_hear_what_they_heard_without_it`: 6 of 7 guitars differed by up to 23% of their level; `the_pan_places_what_the_plug_in_makes_before_the_stages_after_it` on the board). Fixed by applying the pan at the insert |
| The level into a saturating plug-in changed by 3 dB, and the guitar was louder on its side | Confirmed (`a_plug_in_that_clips_hears_the_guitar_at_the_level_it_always_did`: the louder side played 0.01 where the centred guitar played 0.00707). Fixed by `pan_pre` at the louder side's level |
| Brand and product names in the note, tests and the test plug-in | Removed from every file of the branch |
| A General MIDI synthesizer was told the centre at once while the factor glided | Reproduced by a mutation of the fix (`a_general_midi_track_is_panned_without_a_step_while_a_plug_in_comes_and_goes` and `the_pan_of_a_general_midi_track_with_an_effect_is_applied_once` fail without the synthesizer's factor); the first version itself was not run against the new test. Fixed as described above |
| The two factors did not multiply to the pan during the glide, so the silent side leaked up to 25% | Confirmed (`the_side_the_score_silences_stays_silent_while_a_plug_in_comes_and_goes`: 0.0735 against 0.309). Fixed |
| A pan moved by the score was applied to the output at once, `D` frames early | Confirmed (`a_pan_moved_while_a_note_rings_places_each_part_of_what_the_plug_in_makes`: 0.375 off with latency 0). Fixed by the queue |
| A hand-over, a seek and a wrap | `a_plug_in_leaves_the_pan_where_the_score_has_it_across_a_seek_a_wrap_and_a_hand_over`: the wrap failed before the queue existed; the hand-over fails if the queue is not carried over (checked by removing the carry), passes with it |
| The pan blend glided on the first frames of a play after a plug-in was added while stopped; the renderer built by a hand-over started the blend afresh | Not reproduced as an audible fault: the factors multiply to the pan, so a glide at a bad moment changes nothing for a linear board. The blend is nevertheless set at once at a seek and carried over a hand-over |
| Several MIDI channels with different pans | Pinned, not changed (see Limits) |
| An inactive, refused or missing slot, or a faulted plug-in | `a_slot_that_is_missing_or_refused_leaves_the_track_panned_once` (the stems equal those without a plug-in, sample for sample; it passed on the first version as well) and `the_stand_in_for_a_plug_in_is_placed_like_the_plug_in` (nothing on the silenced side while priming, playing or fallen back; written against the new interface) stay as the guards |
| The count-in could index a track that does not exist | Fixed (`get_mut`) |
| The two new test programs cost CI link time and the real-helper one never ran in CI | The tests live in `audio_plugin_insert.rs` (`mod several_tracks`) and `plugin_playback.rs` (`mod windows_tracks_tests`), both already built and run by CI; no new test program, no CI change |
| The README of the test plug-in lacked the new mode | Added |

## How it was checked

All on Windows, 2026-11-17, in the worktree, with a Cargo target folder shared with other jobs. The real-helper tests find the helper and the test plug-in by the test program's own path: `target_dir()` is the folder above `deps` that the test executable runs from, and `cargo build -p tabplayer-plugin-host -p tabplayer-test-plugin` with the same target put `tabplayer-plugin-host.exe` and `tabplayer_test_plugin.dll` there.

New tests, all in `audio_plugin_insert.rs` (cross-platform, fake helpers in process) except where noted. "Before" is the first version of the fix, run on this branch before the rewrite.

| Test | What | Before / after |
|---|---|---|
| `the_stages_before_and_after_a_plug_in_hear_what_they_heard_without_it` | a compressor before and a room reverb after a plug-in that changes nothing, guitars panned 0, 16, 32, 48, 64, 100, 127, latencies 0 and 480: each stem is the same guitar without the plug-in, tails included | before: 6 of 7 guitars off by up to 23% of their level, the reverb's cross-feed gone; after: ok |
| `the_pan_places_what_the_plug_in_makes_before_the_stages_after_it` (TrackDsp) | a reverb after the plug-in carries a hard-right guitar into the left | new interface; ok |
| `a_plug_in_that_clips_hears_the_guitar_at_the_level_it_always_did` | a plug-in that clips far below the guitar: the louder side of a panned guitar is as loud as the centred one | before: 0.01 against 0.00707 (3 dB); after: ok |
| `a_plug_in_that_changes_nothing_leaves_every_pan_as_the_score_set_it` | 15 controller values from 0 to 127: same law and level, the centre to 1e-4 | passed before and after (the guard of the law) |
| `the_side_the_score_silences_stays_silent_while_a_plug_in_comes_and_goes` | the plug-in added at 0.5 s and removed at 1 s from a hard-panned long note | before: 0.0735 against 0.309 (24%) on the silent side; after: under 1% |
| `a_general_midi_track_is_panned_without_a_step_while_a_plug_in_comes_and_goes` and `the_pan_of_a_general_midi_track_with_an_effect_is_applied_once` | the same on a General MIDI voice; pan 0, 32, 64, 100, 127 | ok; both fail if the synthesizer's factor is left out |
| `a_pan_moved_while_a_note_rings_places_each_part_of_what_the_plug_in_makes` | a burst that straddles a balance move from hard left to hard right, latencies 0 and 480 | before: 0.375 off (level 0.467); after: ok |
| `a_plug_in_leaves_the_pan_where_the_score_has_it_across_a_seek_a_wrap_and_a_hand_over` | a seek, a loop wrap from the right-panned end to the left-panned start with a burst straddling it, and an edit's hand-over with the plug-in's output still on its way | before: the wrap 0.375 off; after: ok. Without the carry-over in `continue_from` the hand-over fails (0.107 off) |
| `channels_of_one_track_with_different_pans_take_the_pan_set_last_with_a_plug_in` | pins the limit below | passed before and after |
| `a_slot_that_is_missing_or_refused_leaves_the_track_panned_once` | a plan for another track, an instrument on a guitar, no plans: every stem equals the one without plug-ins, sample for sample | passed before and after |
| `the_stand_in_for_a_plug_in_is_placed_like_the_plug_in` (TrackDsp) | priming, playing and after a stall fault: nothing on the silenced side, the right side as the plug-in then the stand-in make it | new interface; ok |
| `a_plug_in_attached_to_a_renderer_for_an_export_places_the_pan_after_it` | `Renderer::attach_plugin` on a renderer built without one, a plug-in that reads only the left input | ok |
| `an_effect_that_reads_the_left_input_sounds_on_a_track_panned_to_either_side` (from the first version) | five pans, three latencies | on the unfixed code 4 of 5 guitars wrong; ok throughout since |
| `windows_tracks_tests` in `plugin_playback.rs` (real helper and test plug-in, `--ignored`) | three recorded guitars panned left, right and centre with the test plug-in in `LeftOnly` mode: playback, the second effect chosen while the first plays, and the export; and the installed-plug-in diagnostics, which skip when `TABPLAYER_REAL_PLUGIN` is unset | ok (the three LeftOnly tests failed with the guitar at 127 silent on the unfixed code) |

The runs, on the final tree (`d695de8` and this note):

| Command | Result |
|---|---|
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | clean, exit 0 |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin` | `Finished dev profile [unoptimized + debuginfo] target(s) in 1.67s` |
| `cargo test --locked --workspace --no-fail-fast --manifest-path src-tauri/Cargo.toml` | 100 test programs ran, 85 passed and 15 failed (`-p tabplayer --lib`, `audio_backing`, `audio_cabinet_ir`, `audio_drum_mix`, `audio_golpe`, `audio_line_in`, `audio_master`, `audio_nam`, `audio_palm_mute`, `audio_palm_mute_identity`, `audio_recorded_kit`, `audio_render`, `audio_resources`, `audio_tone`, `reference_sync`). The 105 failed tests all stop with `Os { code: 3, kind: NotFound }` for `node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2`, which the worktree does not have. Among the passes: `audio_plugin_insert` 64, `audio_plugin_compensation` 23, `audio_plugin_instrument` 54, `plugin_helper` 26 (17 ignored), `plugin_document` 10, `plugin_rate` 6 |
| the same 15 programs again, with a temporary junction `node_modules` to the main checkout's (removed afterwards; git ignores it) | all pass, exit 0: lib 1,092 (7 ignored), `audio_backing` 6, `audio_cabinet_ir` 18, `audio_drum_mix` 20, `audio_golpe` 8, `audio_line_in` 13, `audio_master` 20, `audio_nam` 18, `audio_palm_mute` 19, `audio_palm_mute_identity` 1, `audio_recorded_kit` 8, `audio_render` 39, `audio_resources` 12, `audio_tone` 22, `reference_sync` 13. These are the golden and byte-exact programs behind the claim that a track without an effect plug-in renders what it did |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_helper --test plugin_playback --test plugin_export --test plugin_editor --test plugin_library --test plugin_instrument -- --ignored --test-threads=1` | exit 0: `plugin_editor` 8, `plugin_export` 9, `plugin_helper` 17, `plugin_instrument` 6, `plugin_library` 2, `plugin_playback` 25 passed |
| `cargo test --locked -p tabplayer-plugin-host --manifest-path src-tauri/Cargo.toml -- --ignored --test-threads=1` | exit 0: `main.rs` 3 and `tests/helper.rs` 37 passed (its other tests passed in the workspace run) |

The failures of the first workspace run were not run on `develop`: they are all the missing file above, which every one of those programs reads from the same path, and they pass here once it is present. That they fail identically on `develop` in a worktree without `node_modules` is argued from the cause, not observed.

## Limits

- The project as it was edited was not available, only the original score file, so the pan values above are those of that file. If the second guitar was moved to the centre, this is not the cause there.
- The installed build and the installed plug-ins were not run for this version, and nothing was listened to. The checks render stems and read their samples, with fake helpers in process and, on Windows, a real helper process and the test plug-in. The environment-gated tests against installed plug-ins skip when their variables are unset and were not run. No desktop driver was run.
- The macOS and Linux runs of the cross-platform tests were not made; the tests were run on Windows only.
- A track whose MIDI channels have different pans gets one pan after the plug-in: the one set last. Guitar Pro writes the same balance on all of a track's channels, and the test for a hand-made plan with two shows the result (`channels_of_one_track_with_different_pans_take_the_pan_set_last_with_a_plug_in`). Before the plug-in the channels were each panned by their own.
- The pan of a hosted instrument's output (a drum track with an instrument) is not applied by the renderer, before or after this change, and its built-in stand-in is panned. An effect plug-in is the only thing that moves the pan. (Closed later the same day: see `2026-11-17-instrument-pan.md`.)
- A kit-mix element panned by the score's kit balance, and a SoundFont region's own pan, are applied before the plug-in; a plug-in that reads only the left input is silent for a drum element panned hard right.
- Golpe knocks (channel 9 of a guitar) carry no pan of their own, and on a track with an effect plug-in they now follow the track's pan, as the rest of the guitar does. This was read in the code, not tested.
- The built-in Microphone block set to mono folds the track to the centre before the plug-in. A track with that setting and an effect plug-in is now panned by the score after the plug-in; before, it stayed in the centre. Read in the code, not tested.
- A plug-in that processes the two sides independently and non-linearly is, on a track panned between the centre and a side, fed the louder side's level on both channels; the quieter side is that signal scaled down afterwards instead of a quieter signal processed. The louder side is as before; the quieter one differs in tone slightly. A plug-in that sums to mono gets the louder side's level on both channels and the pan after it.
- The built-in Drive, Amp and Cabinet that stand in for a plug-in (while it primes, and for good after it faults) get the same input as the plug-in does, so a non-linear stand-in is fed as the plug-in would have been, and does not sound as the same track with Active unticked, which still pans before its board; the difference is the level on the quieter side and up to 3 dB of drive on a hard pan. The change from one to the other glides over 10 ms.
- With a General MIDI voice, adding a plug-in changes the synthesizer's pan over one of its own blocks while the factor outside it changes at once: a short change of level on the louder side, which stays under the click threshold of the step test. The synthesizer stays centred, and the renderer pans it, until the next seek; the synthesizer's own pan law leaks about -38 dB into the side it silences at the hard right, which is gone while it is centred.
- A second review of the fix as it stands found no blocker and three short artefacts that are left in, all of them only while a plug-in is added, removed or switched during playback on a track that is not centred, and none in an export:
  - a loop that wraps within 10 ms of a plug-in being removed ends the pan glide at once while the leaving plug-in is still fading, so the side the score silences can carry the guitar for up to 10 ms;
  - the glide is not delayed by the plug-in's delay, and a pan move queued just before a plug-in is added or removed is still timed by the old delay, so for the length of that delay a partly panned track can be placed slightly off, and a pan move in that window can come late;
  - after a plug-in is removed during playback, a General MIDI voice is panned by the renderer's pan law and not the synthesizer's until the next seek, wrap or edit, so until then playback differs slightly from an export of the same document.
- The same review found that `a_slot_that_is_missing_or_refused_leaves_the_track_panned_once` has no case for a plan that failed with a status, and that the silent-side glide test uses hard pans only, where it cannot tell the two factors' timing apart.
- `export::audio::tests::exported_native_mix_and_stems_decode_with_aligned_onsets_pitch_and_tail_frames` and the 104 other tests listed above fail in a worktree for want of `node_modules`; none of them is affected by this change.

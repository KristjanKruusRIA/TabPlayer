# GP8 parity A23: drum-element mix (2026-10-31)

GP8 row A23 mixes the pieces of a drum kit apart. Before, a percussion track had one volume, pan, mute and solo. Now the Mixer view of a selected percussion track also has six kit elements (kick, snare, hi-hat, toms, cymbals, other percussion), each with volume, pan, mute and solo, heard in playback and in audio export.

## What an element is

- A note belongs to the element of the **articulation** it plays, by the instrument that owns the articulation in `src/instruments/drum-kit.ts` (the owner is found by the articulation's element name, and only for a name nobody knows by its sounding pitch). The element of each instrument is the table in `src/audio/drum-kit.ts`: kick and kick 2 are kick; snare and electric snare are snare; hi-hat is hats; the six toms are toms; splash, the crashes, reverse, ride, china and ride 2 are cymbals; every other instrument is other.
- The native player only plays MIDI. The playback plan names the element on a note's `noteOn`/`noteOff` (`kitElement`) **only where it is not the one the pitch gives**. Where the plan names nothing (plans written before this, auditions, an articulation nobody owns) the player groups by pitch: kick 35 36; snare 37 38 40; hats 42 44 46; toms 41 43 45 47 48 50; cymbals 49 51 52 53 55 57 59; everything else other (`gm_kit_element` in `settings.rs`).
- Exactly 9 of the 95 standard articulation entries (94 ids; id 83 is both Jingle Bell and Tinkle Bell) sound the pitch of another element and are named by the plan: Metronome (hit, bell) sound snare pitches, Bell Tree (hit, return), Jingle Bell, Tinkle Bell and Piatti (hit, hand) sound cymbal pitches, and Grancassa sounds a tom pitch. All are `other`. A track's own articulation is read by its own element name whatever pitch it sounds.
- A `.tabplayer` mix without `drumKit` replays as before. Elements at their defaults are never saved, and a kit of elements all at their defaults is the same as no kit, in the editor and in the player.

## How it sounds

- A kit is installed like any mix: no rebuild, nothing cut and no held note struck again, when the first kit arrives, changes or is removed. (An earlier version rebuilt the player on the first kit edit.)
- Each percussion track with a General MIDI sound holds six synthesizers beside its own (seven in all). A track with no kit, or a kit of defaults, plays only on its own synthesizer exactly as it did; the six sound only while a kit is in effect.
- Level, pan, mute and solo move over 10 ms, on the clock and not on the notes, so a mute or a level change never steps a ringing cymbal, and a note struck after the change, including the first kit edit or a seek, starts at the new level from its attack (tests measure from the hit). A transport that is stopped or paused renders nothing, so a kit installed then is completed at once for a track that has rendered no frame since the last seek, even when the seek struck held notes again (tested through `CallbackTransport` for stop, for pause then seek then edit, and for edit then seek). This holds for any number of edits made while nothing renders, including those that wait behind a track's own crossfade (which cannot run until Play): the kit levels are taken from the waiting mix, while track faders and the rest of that mix still install as before (tested with four stopped edits). A track paused with kit notes ringing keeps its ramp so they resume without a step (tested); a hit soon after such a resume starts partway through the ramp (about 10 ms, and about 21 ms when the edit was made while paused, which also waits for the track's own crossfade).
- A note already sounding when the **first** kit arrives plays out on the track's own synthesizer at its original level; the kit governs the notes struck after it. Once a kit is in effect, changes to it are heard on the notes already sounding too.
- Pan is balance: the louder channel keeps its level and the other falls, as `1 - |pan|`. This differs from the track's own equal-power pan.

## Mixer view

- Reached in Mixer, with a percussion track selected (`aria-label` "Drum kit <track>"). There is no other kit panel: the Sound pane's panel is removed.
- Controls are the shared `Fader` and `Knob` with `useLivePreview`, as on a strip. A drag is heard as it moves through `previewDrumElement` (nothing recorded) and saved once on release; a key press saves one change; Escape puts the sound back; choosing the value an element already has records nothing. A busy mixer refuses a change with `aria-disabled` (no `disabled` on a switch that may hold focus).

## Evidence

All run on branch `feat/slice-a23` after merging `feat/gp8-parity`.

- `npx tsc --noEmit -p .`: no errors.
- `npx vitest run src/audio src/mixer src/App.test.tsx --testTimeout=40000 --maxWorkers=2`: 67 files, 1119 passed, 1 skipped. Seven `plan.test.ts` cases read fixtures from `.analysis/compatibility`, which a fresh worktree lacks; they were run with that folder linked from the main checkout.
- `cargo test --locked --no-fail-fast --manifest-path src-tauri/Cargo.toml`: 1,017 tests passed and 1 failed across all targets. The one failure, `file_library::index::tests::a_page_search_over_fifty_thousand_rows_stays_fast`, is load sensitive: it failed in the full run, which shared the machine with other work, and passed (3 s) when run alone.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: clean.
- `src-tauri/tests/audio_drum_mix.rs` (19 tests) renders a kick then a snare through the real renderer. The no-kit render is compared with a fingerprint of the same render taken on `feat/gp8-parity` before this feature, not with itself. It also covers: a kit of defaults equal to no kit (bit for bit); level (the kick at 0.5 is half of the baseline, the snare unchanged), pan, mute, solo; a note following the element its plan names; a kit installed or removed in a playing renderer; a mute fading instead of stepping; an audio export (`AudioExportRender`) carrying the kit; a wrong `kitElement` refused and an absent one not written.
- `render_seek_and_kit_mix_install_do_not_touch_heap` (`audio_render.rs`) counts heap operations in the audio callback across rendering with a kit, seeking into held notes, three mix installs (one parked), a kit removed, a seek and the tail: zero.
- `a_drum_kit_edit_reaches_a_playing_document_as_a_mix_and_never_rebuilds_it` (`device.rs`) checks that a first kit, a changed kit and a removed kit each queue a `Mix` command and leave the plan and resources shared.
- Unit tests in `renderer.rs` (`kit_tests`) check the gains (level, pan, mute, solo), the ramp and that a kit of defaults is not active. `drum-kit.test.ts` checks the element table, the list of 9 above and that the pitch table equals the one parsed out of `settings.rs`. `plan.test.ts` checks the plan names the element for the metronome and for a custom articulation, and leaves it out otherwise.
- Mutations made on purpose, each making a test fail: kit of defaults not normalised away (unit test); plan element ignored; ramp state not handed over at an install; element gain not applied; ramp length 0; allocation added to the kit note-on or render path (heap test).
- UI: `MixerView.test.tsx`, `MixerView.live.test.tsx` and `App.test.tsx` (the kit is reached from the Mixer view of a percussion track and edits record one undoable change each).

## Limits

- Nobody has listened to it, and the app was not run: no desktop driver run, no real audio device. Only the renderer, the player's command queue and the interface under test doubles were exercised.
- `App.test.tsx` uses a stand-in player, so it proves the kit is reachable and the edits it saves, not the player's own handling; that is covered by `mix-preview.test.ts` and the Rust tests.
- A note released to the wrong synthesizer cannot be heard (General MIDI drums are one-shots), so the routing of a `noteOff` is not tested by sound; the mutation that removes it was not caught.
- While a kit is in effect each element has its own synthesizer, so a choke the SoundFont defines between notes of different elements would no longer apply; one within an element still does. This was not checked against the SoundFont.
- Voices are limited per synthesizer (256), not per track, so a kit track can sound more voices than before.
- The kit is saved with the `.tabplayer` mix. A Guitar Pro export does not carry it (not exercised here).

## Review

A review of the first version found the failures fixed here: the integration test no longer compiled, the first kit edit rebuilt the player and cut ringing notes, a mute stepped, a drag recorded an edit per step, the grouping disagreed with the kit on 9 articulations, and a test compared the new code with itself. This version is awaiting a second review.

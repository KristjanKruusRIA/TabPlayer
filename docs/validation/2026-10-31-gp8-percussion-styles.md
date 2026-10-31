# GP8 parity A35: percussion playing styles and extended kit variants

Status: partial. Drum kit choice is built and audible. Separate rim shot, choke, half-open and similar playing styles cannot be built, because the pinned sound bank has no samples for them.

## Behavior

What the bundled bank holds (`sonivox.sf2`, General MIDI, bank 128, read from its preset list and checked by rendering):

- Four drum kits: Standard (program 0), Room (8), Jazz (32) and Brush (40). Guitar and bass recordings are separate and hold no drums.
- Within each kit every drum key 27 to 87 renders a different sound from every other key (pitch or envelope differ even where two keys share a sample).
- The kits differ from Standard only on some keys: Room on the five toms (41, 43, 47, 48, 50), Jazz on the two kicks (35, 36), Brush on the kicks and on snare, hand clap and electric snare (35, 36, 38, 39, 40). Everything else is the Standard sample.
- Any other program (such as a 1980s electronic or TR-808 kit) falls back to Standard.

What was missing: a drum track could not choose a kit. alphaTab 1.8.4 forces every percussion track's own MIDI program to 0 when a score is finished, so the track's program cannot carry the choice.

What is built:

- A stored per-track field `drumKit` on the track's sound (the `setTrackSound` edit and the document sound settings), holding the program that selects the kit (8, 32 or 40). It is left out for Standard, like `locked`. Rust bounds it to those three values and TypeScript refuses anything else.
- The Track panel shows a Drum kit select on drum tracks only (and drops the 128-entry MIDI instrument list there, none of which changed the sound). One choice is one undoable `setTrackSound` edit that keeps the rest of the sound; choosing the kit already in effect records nothing. The select uses `busySelect`, so it keeps focus while busy and refuses the change.
- The Sound panel's presets, factory sounds, pastes and saved sounds keep the track's kit, as they keep its lock.
- The renderer rewrites the plan's programs (track, program changes, notes) to the kit before it is built. Playback, WAV and audio export, runtime renders and note audition all build their renderer the same way, so they agree. (Whether the audition request from the interface carries the track's kit was not traced.) A kit change during playback rebuilds the renderer (`sound_source_changed`). Nothing in the realtime path changed: the work happens when the renderer is built.
- A collapsible table in the same panel lists which hits each kit changes and which notations play the identical sound.

Notations that sound identical (they differ on the page only): snare hit = rim shot; hi-hat open = half-open; ride edge = middle = choke; crash and splash chokes = their hits; China choke = China hit; the bongo, conga, tambourine, maraca, shaker, cabasa, cowbell, bell tree and golpe variants = their plain hits. The bank has no rim shot, bell-versus-edge, choke, mute or slap sample, so no playing style among these can be audibly authored. Side stick (key 37) and the ride bell (key 53) do sound different, because the bank maps them to their own keys.

## Evidence

- `src-tauri/src/audio/drum_kit_tests.rs`: renders the bank with the same synthesizer playback and export use. It checks that the bank holds exactly the four kits listed in `src/audio/drum-kits.json`, that no two drum keys render alike in any kit, that each kit differs from Standard on exactly its listed keys, that programs without a kit play Standard (all 124 others), and that the real `Renderer` plays Jazz, Brush and Room differently from Standard, leaves untouched keys untouched, overrides the plan's own program and program change, and leaves a plan alone when no kit is chosen. It also checks the sound serializes byte for byte as before when no kit is set, accepts 8, 32 and 40, and refuses 0, 1, 25, 127, 128, 255 and 300. `device.rs` has a test that a kit change forces a renderer rebuild on a drum track and not on a pitched one.
- `src/editor/drum-kits.test.ts`: kit table, shared-sound table, and an old edit log (a sound edit without the field) replaying to identical settings; the kit edit saves, reloads and undoes; TypeScript validation of `drumKit`.
- `src/workstation/DrumKitPicker.test.tsx`: options, one edit per choice, no edit for the current kit, Standard clears the field and keeps the lock, focus kept while busy, no kit control on pitched tracks.
- `npx tsc --noEmit -p .` clean. Vitest over `src/audio src/editor src/workstation src/mixer src/rig src/App.test.tsx`: 2058 passed; 7 failed in `src/audio/plan.test.ts` because the `.analysis/compatibility` fixtures are not in this worktree (ENOENT), unrelated to this change.
- `cargo test --locked --no-fail-fast`: all integration tests pass; in the library tests 406 passed and 1 failed, `file_library::index::tests::a_page_search_over_fifty_thousand_rows_stays_fast`, a timing test in code this change does not touch (it failed again alone in a debug build).

## Review

Not independently reviewed. This is not a guard, permission or migration path, but it adds a field to a persisted, validated settings struct, so a fresh read of `settings.rs`, `voices.rs::with_drum_kits` and `document-settings.ts` is worth doing. Points checked by hand: `drumKit: null` is read as no kit by Rust and refused by TypeScript; the field travels with a duplicated track (settings are copied through `completeSound`); older app builds reject a file that stores a kit (`deny_unknown_fields`).

## Limits

- Only Room, Jazz and Brush exist beyond Standard, and each changes a few keys. No kit is audibly different on cymbals or hi-hats.
- No rim shot, side-stick variants beyond key 37, choke, half-open hi-hat, bell, mute, slap, roll or brush-sweep sound exists, and none was added: the task forbids adding audio, and `voices.rs` plays drums through the General MIDI bank only. These remain notation-only. A choke does not cut the sound.
- The kit applies to the whole track; a mid-song kit change is not supported.
- Brush-kit output was verified by rendering, not by ear.
- A kit chosen here lives in the sound settings, not in the exported MIDI or Guitar Pro file, so another program opens those with its own drum kit.
- Desktop app was not launched for this change.
